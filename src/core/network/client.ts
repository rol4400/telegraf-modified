/* eslint @typescript-eslint/restrict-template-expressions: [ "error", { "allowNumber": true, "allowBoolean": true } ] */
import * as crypto from 'crypto'
import * as fs from 'fs'
import { stat, realpath } from 'fs/promises'
import * as http from 'http'
import * as https from 'https'
import * as path from 'path'
import { Transform } from 'stream'
import fetch, { RequestInit } from 'node-fetch'
import axios from 'axios'
import { hasProp, hasPropType } from '../helpers/check'
import { InputFile, Opts, Telegram } from '../types/typegram'
import { AbortSignal } from 'abort-controller'
import { compactOptions } from '../helpers/compact'
import MultipartStream from './multipart-stream'
import TelegramError from './error'
import { URL } from 'url'
// eslint-disable-next-line @typescript-eslint/no-var-requires
const debug = require('debug')('telegraf:client')
const { isStream } = MultipartStream

// Progress callback types
export interface UploadProgress {
  loaded: number
  total: number
  percentage: number
}

export type ProgressCallback = (progress: UploadProgress) => void

const WEBHOOK_REPLY_METHOD_ALLOWLIST = new Set<keyof Telegram>([
  'answerCallbackQuery',
  'answerInlineQuery',
  'deleteMessage',
  'leaveChat',
  'sendChatAction',
])

namespace ApiClient {
  export type Agent = http.Agent | ((parsedUrl: URL) => http.Agent) | undefined
  export interface Options {
    /**
     * Agent for communicating with the bot API.
     */
    agent?: http.Agent
    /**
     * Agent for attaching files via URL.
     * 1. Not all agents support both `http:` and `https:`.
     * 2. When passing a function, create the agents once, outside of the function.
     *    Creating new agent every request probably breaks `keepAlive`.
     */
    attachmentAgent?: Agent
    apiRoot: string
    /**
     * @default 'bot'
     * @see https://github.com/tdlight-team/tdlight-telegram-bot-api#user-mode
     */
    apiMode: 'bot' | 'user'
    webhookReply: boolean
    testEnv: boolean
  }
  export interface CallApiOptions {
    signal?: AbortSignal
    /**
     * Progress callback for file uploads
     */
    onProgress?: ProgressCallback
  }
}

const DEFAULT_EXTENSIONS: Record<string, string | undefined> = {
  audio: 'mp3',
  photo: 'jpg',
  sticker: 'webp',
  video: 'mp4',
  animation: 'mp4',
  video_note: 'mp4',
  voice: 'ogg',
}

const DEFAULT_OPTIONS: ApiClient.Options = {
  apiRoot: 'https://api.telegram.org',
  apiMode: 'bot',
  webhookReply: true,
  agent: new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 10000,
  }),
  attachmentAgent: undefined,
  testEnv: false,
}

function includesMedia(payload: Record<string, unknown>) {
  return Object.entries(payload).some(([key, value]) => {
    if (key === 'link_preview_options') return false

    if (Array.isArray(value)) {
      return value.some(
        ({ media }) =>
          media && typeof media === 'object' && (media.source || media.url)
      )
    }
    return (
      value &&
      typeof value === 'object' &&
      ((hasProp(value, 'source') && value.source) ||
        (hasProp(value, 'url') && value.url) ||
        (hasPropType(value, 'media', 'object') &&
          ((hasProp(value.media, 'source') && value.media.source) ||
            (hasProp(value.media, 'url') && value.media.url))))
    )
  })
}

function replacer(_: unknown, value: unknown) {
  if (value == null) return undefined
  return value
}

function buildJSONConfig(payload: unknown): Promise<RequestInit> {
  return Promise.resolve({
    method: 'POST',
    compress: true,
    headers: { 'content-type': 'application/json', connection: 'keep-alive' },
    body: JSON.stringify(payload, replacer),
  })
}

const FORM_DATA_JSON_FIELDS = [
  'results',
  'reply_markup',
  'mask_position',
  'shipping_options',
  'errors',
] as const

async function buildFormDataConfig(
  payload: Opts<keyof Telegram>,
  agent: ApiClient.Agent
) {
  for (const field of FORM_DATA_JSON_FIELDS) {
    if (hasProp(payload, field) && typeof payload[field] !== 'string') {
      payload[field] = JSON.stringify(payload[field])
    }
  }
  const boundary = crypto.randomBytes(32).toString('hex')
  const formData = new MultipartStream(boundary)
  
  await Promise.all(
    Object.keys(payload).map((key) =>
      // @ts-expect-error payload[key] can obviously index payload, but TS doesn't trust us
      attachFormValue(formData, key, payload[key], agent)
    )
  )
  return {
    method: 'POST',
    compress: true,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      connection: 'keep-alive',
    },
    body: formData,
  }
}

async function attachFormValue(
  form: MultipartStream,
  id: string,
  value: unknown,
  agent: ApiClient.Agent
) {
  if (value == null) {
    return
  }
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    form.addPart({
      headers: { 'content-disposition': `form-data; name="${id}"` },
      body: `${value}`,
    })
    return
  }  if (id === 'thumb' || id === 'thumbnail') {
    const attachmentId = crypto.randomBytes(16).toString('hex')
    await attachFormMedia(form, value as InputFile, attachmentId, agent)
    return form.addPart({
      headers: { 'content-disposition': `form-data; name="${id}"` },
      body: `attach://${attachmentId}`,
    })
  }
  if (Array.isArray(value)) {
    const items = await Promise.all(
      value.map(async (item) => {
        if (typeof item.media !== 'object') {
          return await Promise.resolve(item)
        }
        const attachmentId = crypto.randomBytes(16).toString('hex')
        await attachFormMedia(form, item.media, attachmentId, agent)
        const thumb = item.thumb ?? item.thumbnail
        if (typeof thumb === 'object') {
          const thumbAttachmentId = crypto.randomBytes(16).toString('hex')
          await attachFormMedia(form, thumb, thumbAttachmentId, agent)
          return {
            ...item,
            media: `attach://${attachmentId}`,
            thumbnail: `attach://${thumbAttachmentId}`,
          }
        }
        return { ...item, media: `attach://${attachmentId}` }
      })
    )
    return form.addPart({
      headers: { 'content-disposition': `form-data; name="${id}"` },
      body: JSON.stringify(items),
    })
  }
  if (
    value &&
    typeof value === 'object' &&
    hasProp(value, 'media') &&
    hasProp(value, 'type') &&
    typeof value.media !== 'undefined' &&
    typeof value.type !== 'undefined'
  ) {    const attachmentId = crypto.randomBytes(16).toString('hex')
    await attachFormMedia(form, value.media as InputFile, attachmentId, agent)
    return form.addPart({
      headers: { 'content-disposition': `form-data; name="${id}"` },
      body: JSON.stringify({
        ...value,
        media: `attach://${attachmentId}`,
      }),
    })
  }
  return await attachFormMedia(form, value as InputFile, id, agent)
}

async function attachFormMedia(
  form: MultipartStream,
  media: InputFile,
  id: string,
  agent: ApiClient.Agent
) {
  let fileName = media.filename ?? `${id}.${DEFAULT_EXTENSIONS[id] ?? 'dat'}`
  if ('url' in media && media.url !== undefined) {
    const timeout = 1_500_000 // ms
    const res = await fetch(media.url, { agent, timeout })
    return form.addPart({
      headers: {
        'content-disposition': `form-data; name="${id}"; filename="${fileName}"`,
      },
      body: res.body,
    })
  }
  if ('source' in media && media.source) {
    let mediaSource = media.source
    if (typeof media.source === 'string') {
      const source = await realpath(media.source)
      if ((await stat(source)).isFile()) {
        fileName = media.filename ?? path.basename(media.source)
        mediaSource = await fs.createReadStream(media.source)
      } else {
        throw new TypeError(`Unable to upload '${media.source}', not a file`)
      }
    }

    if (isStream(mediaSource) || Buffer.isBuffer(mediaSource)) {
      form.addPart({
        headers: {
          'content-disposition': `form-data; name="${id}"; filename="${fileName}"`,
        },
        body: mediaSource,
      })
    }
  }
}

async function answerToWebhook(
  response: Response,
  payload: Opts<keyof Telegram>,
  options: ApiClient.Options
): Promise<true> {
  if (!includesMedia(payload)) {
    if (!response.headersSent) {
      response.setHeader('content-type', 'application/json')
    }
    response.end(JSON.stringify(payload), 'utf-8')
    return true
  }

  const { headers, body } = await buildFormDataConfig(
    payload,
    options.attachmentAgent
  )
  if (!response.headersSent) {
    for (const [key, value] of Object.entries(headers)) {
      response.setHeader(key, value)
    }
  }
  await new Promise((resolve) => {
    response.on('finish', resolve)
    body.pipe(response)
  })
  return true
}

function redactToken(error: Error): never {
  error.message = error.message.replace(
    /\/(bot|user)(\d+):[^/]+\//,
    '/$1$2:[REDACTED]/'
  )
  throw error
}

type Response = http.ServerResponse
class ApiClient {
  readonly options: ApiClient.Options

  constructor(
    readonly token: string,
    options?: Partial<ApiClient.Options>,
    private readonly response?: Response
  ) {
    this.options = {
      ...DEFAULT_OPTIONS,
      ...compactOptions(options),
    }
    if (this.options.apiRoot.startsWith('http://')) {
      this.options.agent = undefined
    }
  }

  /**
   * If set to `true`, first _eligible_ call will avoid performing a POST request.
   * Note that such a call:
   * 1. cannot report errors or return meaningful values,
   * 2. resolves before bot API has a chance to process it,
   * 3. prematurely confirms the update as processed.
   *
   * https://core.telegram.org/bots/faq#how-can-i-make-requests-in-response-to-updates
   * https://github.com/telegraf/telegraf/pull/1250
   */
  set webhookReply(enable: boolean) {
    this.options.webhookReply = enable
  }

  get webhookReply() {
    return this.options.webhookReply
  }  async callApi<M extends keyof Telegram>(
    method: M,
    payload: Opts<M>,
    { signal, onProgress }: ApiClient.CallApiOptions = {}
  ): Promise<ReturnType<Telegram[M]>> {
    console.log(`[DEBUG] callApi called for method: ${method}, onProgress: ${!!onProgress}`)
    const { token, options, response } = this

    if (
      options.webhookReply &&
      response?.writableEnded === false &&
      WEBHOOK_REPLY_METHOD_ALLOWLIST.has(method)
    ) {
      debug('Call via webhook', method, payload)
      // @ts-expect-error using webhookReply is an optimisation that doesn't respond with normal result
      // up to the user to deal with this
      return await answerToWebhook(response, { method, ...payload }, options)
    }

    if (!token) {
      throw new TelegramError({
        error_code: 401,
        description: 'Bot Token is required',
      })
    }    debug('HTTP call', method, payload)

    // Calculate total size for progress tracking if needed
    let totalSize = 0
    if (onProgress && includesMedia(payload)) {
      console.log('[DEBUG] Progress callback provided, calculating total size...')
      for (const key of Object.keys(payload)) {
        // @ts-expect-error payload[key] can obviously index payload, but TS doesn't trust us
        const value = payload[key]
        console.log(`[DEBUG] Checking payload key: ${key}, value type: ${typeof value}`)
        if (value != null && typeof value === 'object' && !Array.isArray(value)) {
          if ('source' in value && value.source) {
            console.log(`[DEBUG] Found source in ${key}, source type: ${typeof value.source}`)
            if ('knownSize' in value && typeof value.knownSize === 'number') {
              console.log(`[DEBUG] Using knownSize: ${value.knownSize}`)
              totalSize += value.knownSize
            } else if (typeof value.source === 'string') {
              console.log(`[DEBUG] Source is file path: ${value.source}`)
              try {
                const stats = await stat(value.source)
                if (stats.isFile()) {
                  console.log(`[DEBUG] File size: ${stats.size}`)
                  totalSize += stats.size
                }
              } catch (error) {
                console.log(`[DEBUG] Error getting file stats: ${error}`)
              }
            } else if (Buffer.isBuffer && Buffer.isBuffer(value.source)) {
              console.log(`[DEBUG] Source is Buffer, size: ${value.source.length}`)
              totalSize += value.source.length
            }
          } else if ('url' in value && 'knownSize' in value && typeof value.knownSize === 'number') {
            console.log(`[DEBUG] Found URL with knownSize: ${value.knownSize}`)
            totalSize += value.knownSize
          }
        }
      }
      console.log(`[DEBUG] Total calculated size: ${totalSize}`)
    }

    const apiUrl = new URL(
      `./${options.apiMode}${token}${options.testEnv ? '/test' : ''}/${method}`,
      options.apiRoot
    )

    let res: any

    // Use axios for multipart uploads with progress tracking
    if (onProgress) {
      const config = await buildFormDataConfig(
        { method, ...payload },
        options.attachmentAgent
      )
      
      const axiosConfig: any = {
        method: 'POST',
        url: apiUrl.toString(),
        data: config.body,
        headers: config.headers,
        timeout: 0,
        httpsAgent: options.agent,
        httpAgent: options.agent,
        signal: signal,
        onUploadProgress: totalSize > 0 ? (progressEvent: any) => {
          console.log(`[DEBUG] Axios upload progress: loaded=${progressEvent.loaded}, total=${progressEvent.total || totalSize}`)
          const progress = {
            loaded: progressEvent.loaded,
            total: progressEvent.total || totalSize,
            percentage: Math.round((progressEvent.loaded / (progressEvent.total || totalSize)) * 100)
          }
          console.log(`[DEBUG] Calling progress callback with:`, progress)
          onProgress(progress)        } : undefined
      }

      try {
        res = await axios(axiosConfig)
        // Convert axios response to fetch-like response for compatibility
        res = {
          status: res.status,
          statusText: res.statusText,
          json: () => Promise.resolve(res.data)
        }
      } catch (error: any) {
        if (error.response) {
          // Convert axios error to fetch-like response
          res = {
            status: error.response.status,
            statusText: error.response.statusText,
            json: () => Promise.resolve(error.response.data)
          }
        } else {
          // Network or other error, apply token redaction and rethrow
          redactToken(error)
        }
      }
    } else {
      const config = await buildJSONConfig(payload)
      config.agent = options.agent
      // @ts-expect-error AbortSignal shim is missing some props from Request.AbortSignalAdd commentMore actions
      config.signal = signal
      config.timeout = 1_500_000 // ms
      const res = await fetch(apiUrl, config).catch(redactToken)
    }
    if (res.status >= 500) {
      const errorPayload = {
        error_code: res.status,
        description: res.statusText,
      }
      throw new TelegramError(errorPayload, { method, payload })
    }
    const data = await res.json()
    if (!data.ok) {
      debug('API call failed', data)
      throw new TelegramError(data, { method, payload })
    }
    return data.result
  }
}

export default ApiClient
