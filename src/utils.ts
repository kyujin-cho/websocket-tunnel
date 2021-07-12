import { Logger } from 'pino'
import { connection, IMessage } from 'websocket'

const errorMap = {
  AUTHFAIL: 'Server authentication failed',
  NOID: '#NOID: This should not happen. Try again with trace option enabled (with `-v trace` flag), capture console output and send to developer for additional help.',
  INVALIDID:
    '#INVALIDID: This should not happen. Try again with trace option enabled (with `-v trace` flag), capture console output and send to developer for additional help.',
  NOTIMPLEMENTED:
    '#NOTIMPLEMENTED: This should not happen. Try again with trace option enabled (with `-v trace` flag), capture console output and send to developer for additional help.',
  CLOSED: "Socket closed from remote site. Check remote server's health.",
}

declare module 'websocket' {
  export interface connection {
    id: string
  }
}

export interface IUTF8Message {
  type: 'utf8'
  utf8Data: string
}

export interface IBinaryMessage {
  type: 'binary'
  binaryData: Buffer
}

export class TunnelError {
  reason!: string
  constructor(reason: string) {
    this.reason = reason
  }
}

export class HostPortPair {
  host!: string
  port!: number

  constructor(s: string)
  constructor(host: string, port: number)
  constructor(...params) {
    if (params.length === 1 && typeof params[0] === 'string') {
      this.host = params[0].split(':')[0]
      this.port = parseInt(params[0].split(':')[1])
    } else if (
      params.length === 2 &&
      typeof params[0] === 'string' &&
      typeof params[1] === 'number'
    ) {
      this.host = params[0]
      this.port = params[1]
    }
  }

  static fromBody(body: any) {
    return new HostPortPair(body.host, body.port)
  }

  public toString() {
    return this.host + ':' + this.port
  }
}

export const sendJSON = (conn: connection, log: Logger, body: any) => {
  const logOutput = { ...body }
  if (log.level !== 'trace' && logOutput.data) logOutput.data = '==TRUNCATED=='
  log[log.level === 'trace' ? 'trace' : 'debug']('⬆ %o', logOutput)
  conn.sendUTF(JSON.stringify(body))
}

export const logResponse = (log: Logger, body: any) => {
  const logOutput = { ...body }
  if (log.level !== 'trace' && logOutput.data) logOutput.data = '==TRUNCATED=='
  log[log.level === 'trace' ? 'trace' : 'debug']('⬇ %o', logOutput)
}

export const panic = (
  log: Logger,
  errorCode?: string,
  errorMessage?: string
) => {
  if (errorMessage) {
    log.fatal(errorMessage)
  } else if (errorCode) {
    let errorString = errorMap[errorCode]
    if (!errorString) {
      errorString = `#${errorCode || 'UNDEFINED'}: Unknown error.`
    }
    log.fatal(errorString)
  }
  process.exit(-1)
}

export const isUTF8Message = (msg: IMessage): msg is IUTF8Message =>
  msg.type === 'utf8'
export const isBinaryMessage = (msg: IMessage): msg is IBinaryMessage =>
  msg.type === 'binary'
