/* eslint @typescript-eslint/restrict-template-expressions: [ "error", { "allowNumber": true, "allowBoolean": true } ] */
import * as crypto from 'crypto'
import * as fs from 'fs'
import { stat, realpath } from 'fs/promises'
import * as http from 'http'
import * as https from 'https'
import * as path from 'path'
import { Transform } from 'stream'
import { spawn } from 'child_process'
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

// Video metadata extraction function
async function extractVideoMetadata(filePath: string): Promise<{ width?: number; height?: number; duration?: number }> {
  return new Promise((resolve, reject) => {
    // Use a simple ffprobe-like approach with a timeout
    const ffprobe = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ])
    
    let stdout = ''
    let stderr = ''
    
    ffprobe.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    
    ffprobe.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    
    ffprobe.on('close', (code: number) => {
      if (code !== 0) {
        console.log(`[DEBUG] ffprobe failed with code ${code}, stderr: ${stderr}`)
        resolve({})
        return
      }
      
      try {
        const data = JSON.parse(stdout)
        const videoStream = data.streams?.find((stream: any) => stream.codec_type === 'video')
        
        if (videoStream) {
          const metadata = {
            width: videoStream.width,
            height: videoStream.height,
            duration: data.format?.duration ? Math.round(parseFloat(data.format.duration)) : undefined
          }
          console.log(`[DEBUG] Extracted video metadata:`, metadata)
          resolve(metadata)
        } else {
          resolve({})
        }
      } catch (error) {
        console.log(`[DEBUG] Failed to parse ffprobe output:`, error)
        resolve({})
      }
    })
    
    ffprobe.on('error', (error: Error) => {
      console.log(`[DEBUG] ffprobe error:`, error.message)
      resolve({})
    })
    
    // Timeout after 10 seconds
    setTimeout(() => {
      ffprobe.kill('SIGTERM')
      resolve({})
    }, 10000)
  })
}

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

function buildJSONConfig(payload: unknown) {
  return {
    method: 'POST',
    compress: true,
    headers: { 'content-type': 'application/json', connection: 'keep-alive' },
    body: JSON.stringify(payload, replacer),
  }
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
): Promise<{ method: string; compress: boolean; headers: any; body: MultipartStream; videoMetadata?: { width?: number; height?: number; duration?: number } }> {
  for (const field of FORM_DATA_JSON_FIELDS) {
    if (hasProp(payload, field) && typeof payload[field] !== 'string') {
      payload[field] = JSON.stringify(payload[field])
    }
  }
  const boundary = crypto.randomBytes(32).toString('hex')
  const formData = new MultipartStream(boundary)
  let videoMetadata: { width?: number; height?: number; duration?: number } = {}
  
  const attachResults = await Promise.all(
    Object.keys(payload).map(async (key) => {
      // @ts-expect-error payload[key] can obviously index payload, but TS doesn't trust us
      const metadata = await attachFormValue(formData, key, payload[key], agent)
      if (key === 'video' && metadata && (metadata.width || metadata.height || metadata.duration)) {
        videoMetadata = metadata
      }
      return metadata
    })
  )
  
  return {
    method: 'POST',
    compress: true,
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      connection: 'keep-alive',
    },
    body: formData,
    videoMetadata
  }
}

async function attachFormValue(
  form: MultipartStream,
  id: string,
  value: unknown,
  agent: ApiClient.Agent
): Promise<{ width?: number; height?: number; duration?: number }> {
  if (value == null) {
    return {}
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
    return {}
  }  if (id === 'thumb' || id === 'thumbnail') {
    const attachmentId = crypto.randomBytes(16).toString('hex')
    await attachFormMedia(form, value as InputFile, attachmentId, agent)
    form.addPart({
      headers: { 'content-disposition': `form-data; name="${id}"` },
      body: `attach://${attachmentId}`,
    })
    return {}
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
    form.addPart({
      headers: { 'content-disposition': `form-data; name="${id}"` },
      body: JSON.stringify(items),
    })
    return {}
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
    form.addPart({
      headers: { 'content-disposition': `form-data; name="${id}"` },
      body: JSON.stringify({
        ...value,
        media: `attach://${attachmentId}`,
      }),
    })
    return {}
  }
  return await attachFormMedia(form, value as InputFile, id, agent)
}

async function attachFormMedia(
  form: MultipartStream,
  media: InputFile,
  id: string,
  agent: ApiClient.Agent
): Promise<{ width?: number; height?: number; duration?: number }> {
  let fileName = media.filename ?? `${id}.${DEFAULT_EXTENSIONS[id] ?? 'dat'}`
  let videoMetadata: { width?: number; height?: number; duration?: number } = {}
  
  if ('url' in media && media.url !== undefined) {
    const timeout = 1_500_000 // ms
    try {
      const res = await axios({
        method: 'GET',
        url: media.url,
        responseType: 'stream',
        timeout,
        ...(agent && { httpsAgent: agent, httpAgent: agent })
      })
      form.addPart({
        headers: {
          'content-disposition': `form-data; name="${id}"; filename="${fileName}"`,
        },
        body: res.data as any,
      })
      return videoMetadata
    } catch (error: any) {
      // Handle axios errors by rethrowing them properly
      if (error.response) {
        throw new Error(`Failed to fetch media from URL: ${error.response.status} ${error.response.statusText}`)
      } else {
        throw new Error(`Failed to fetch media from URL: ${error.message}`)
      }
    }
  }
  if ('source' in media && media.source) {
    let mediaSource = media.source
    if (typeof media.source === 'string') {
      const source = await realpath(media.source)
      if ((await stat(source)).isFile()) {
        fileName = media.filename ?? path.basename(media.source)
        mediaSource = await fs.createReadStream(media.source)
        
        // Extract video metadata for video files
        if (id === 'video' && (fileName.endsWith('.mp4') || fileName.endsWith('.mov') || fileName.endsWith('.avi'))) {
          try {
            videoMetadata = await extractVideoMetadata(source)
          } catch (error) {
            console.log(`[DEBUG] Failed to extract video metadata from ${source}:`, error)
          }
        }
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
  
  return videoMetadata
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
      response.setHeader(key, value as string)
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
      for (const key of Object.keys(payload)) {
        // @ts-expect-error payload[key] can obviously index payload, but TS doesn't trust us
        const value = payload[key]
        if (value != null && typeof value === 'object' && !Array.isArray(value)) {
          if ('source' in value && value.source) {
            if ('knownSize' in value && typeof value.knownSize === 'number') {
              totalSize += value.knownSize
            } else if (typeof value.source === 'string') {
              try {
                const stats = await stat(value.source)
                if (stats.isFile()) {
                  totalSize += stats.size
                }
              } catch (error) {
              }
            } else if (Buffer.isBuffer && Buffer.isBuffer(value.source)) {
              totalSize += value.source.length
            }
          } else if ('url' in value && 'knownSize' in value && typeof value.knownSize === 'number') {
            totalSize += value.knownSize
          }
        }
      }
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
      
      // Inject video metadata into axios data if available
      if (method === 'sendVideo' && config.videoMetadata) {
        const { width, height, duration } = config.videoMetadata
        const videoPayload = payload as any // Type assertion to access video properties
        
        if (width && !videoPayload.width) {
          config.body.addPart({
            headers: { 'content-disposition': 'form-data; name="width"' },
            body: `${width}`,
          })
        }
        if (height && !videoPayload.height) {
          config.body.addPart({
            headers: { 'content-disposition': 'form-data; name="height"' },
            body: `${height}`,
          })
        }
        if (duration && !videoPayload.duration) {
          config.body.addPart({
            headers: { 'content-disposition': 'form-data; name="duration"' },
            body: `${duration}`,
          })
        }
        console.log(`[DEBUG] Injected video metadata: width=${width}, height=${height}, duration=${duration}`)
      }
      
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
          const progress = {
            loaded: progressEvent.loaded,
            total: progressEvent.total || totalSize,
            percentage: Math.round((progressEvent.loaded / (progressEvent.total || totalSize)) * 100)
          }
          onProgress(progress)        
        } : undefined
      }

      try {
        res = await axios(axiosConfig)
        // Convert axios response to fetch-like response for compatibility
        const axiosData = res.data // Store the data before overwriting res
        res = {
          status: res.status,
          statusText: res.statusText,
          json: () => Promise.resolve(axiosData)
        }
      } catch (error: any) {
        if (error.response) {
          // Convert axios error to fetch-like response
          const errorData = error.response.data || {}
          res = {
            status: error.response.status,
            statusText: error.response.statusText,
            json: () => Promise.resolve(errorData)
          }
        } else {
          // Network or other error, apply token redaction but don't throw here
          // Let the error bubble up so retry logic can handle it
          console.log(`[DEBUG] Network error occurred:`, error.message)
          error.message = error.message.replace(
            /\/(bot|user)(\d+):[^/]+\//,
            '/$1$2:[REDACTED]/'
          )
          throw error
        }
      }
    } else {
      // Use axios for all requests for consistency
      let config: any;
      if (includesMedia(payload)) {
        config = await buildFormDataConfig(
          { method, ...payload },
          options.attachmentAgent
        )
        
        // Inject video metadata into axios data if available
        if (method === 'sendVideo' && config.videoMetadata) {
          const { width, height, duration } = config.videoMetadata
          const videoPayload = payload as any // Type assertion to access video properties
          
          if (width && !videoPayload.width) {
            config.body.addPart({
              headers: { 'content-disposition': 'form-data; name="width"' },
              body: `${width}`,
            })
          }
          if (height && !videoPayload.height) {
            config.body.addPart({
              headers: { 'content-disposition': 'form-data; name="height"' },
              body: `${height}`,
            })
          }
          if (duration && !videoPayload.duration) {
            config.body.addPart({
              headers: { 'content-disposition': 'form-data; name="duration"' },
              body: `${duration}`,
            })
          }
          console.log(`[DEBUG] Injected video metadata (non-progress): width=${width}, height=${height}, duration=${duration}`)
        }
      } else {
        config = buildJSONConfig(payload)
      }

      const axiosConfig: any = {
        method: 'POST',
        url: apiUrl.toString(),
        data: config.body,
        headers: config.headers,
        timeout: 1_500_000, // ms
        httpsAgent: options.agent,
        httpAgent: options.agent,
        signal: signal
      }

      try {
        res = await axios(axiosConfig)
        // Convert axios response to fetch-like response for compatibility
        const axiosData = res.data // Store the data before overwriting res
        res = {
          status: res.status,
          statusText: res.statusText,
          json: () => Promise.resolve(axiosData)
        }
      } catch (error: any) {
        if (error.response) {
          // Convert axios error to fetch-like response
          const errorData = error.response.data || {}
          res = {
            status: error.response.status,
            statusText: error.response.statusText,
            json: () => Promise.resolve(errorData)
          }
        } else {
          // Network or other error, apply token redaction but don't throw here
          // Let the error bubble up so retry logic can handle it
          console.log(`[DEBUG] Network error occurred:`, error.message)
          error.message = error.message.replace(
            /\/(bot|user)(\d+):[^/]+\//,
            '/$1$2:[REDACTED]/'
          )
          throw error
        }
      }
    }
    if (res.status >= 500) {
      const errorPayload = {
        error_code: res.status,
        description: res.statusText,
      }
      throw new TelegramError(errorPayload, { method, payload })
    }
    
    const data = await res.json()
    
    if (!data || !data.ok) {
      debug('API call failed', data)
      console.log(`[DEBUG] API call failed for method ${method}:`, data)
      throw new TelegramError(data || { error_code: 500, description: 'Empty response' }, { method, payload })
    }
    return data.result
  }
}

export default ApiClient
