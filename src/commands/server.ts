import { Command, flags } from '@oclif/command'
import fs from 'fs'
import http from 'http'
import YAML from 'js-yaml'
import net from 'net'
import Pino from 'pino'
import { v4 as UUIDv4 } from 'uuid'
import { server as WSServer } from 'websocket'

import {
  HostPortPair,
  ICredential,
  isUTF8Message,
  isWildcardPort,
  logResponse,
  sendJSON,
  TunnelError,
} from '../utils'

const log = Pino({
  prettyPrint: true,
})

class SocketConnection {
  target: HostPortPair
  socket?: net.Socket

  constructor(target: HostPortPair) {
    this.target = target
  }

  async start() {
    return new Promise<net.Socket>((res, rej) => {
      const sock = net.connect({
        host: this.target.host,
        port: this.target.port,
      })
      sock.on('connect', () => {
        this.socket = sock
        res(sock)
      })
      sock.on('timeout', () => rej(new TunnelError('TIMEOUT')))
    })
  }

  async close() {
    const { socket } = this
    if (!socket) throw new TunnelError('NOCONNECTION')
    return new Promise<void>((res) => {
      socket.end(() => {
        this.socket = undefined
        res()
      })
    })
  }
}

export default class Server extends Command {
  static description = 'WebSocket Relay Server'
  static examples = [
    `$ wstunnel server`,
    `$ wstunnel server -P foobar`,
    `$ wstunnel server --port 9999`,
  ]

  static flags = {
    help: flags.help({ char: 'h' }),
    port: flags.integer({ char: 'p', default: 3000 }),
    verbosity: flags.enum({
      char: 'v',
      options: ['error', 'info', 'debug', 'trace'],
      default: 'info',
      description: 'Log output verbosity',
    }),
    passphraseFile: flags.string({
      char: 'f',
      description: 'File path to credential definition YAML',
    }),
  }

  async run() {
    const {
      flags: { port, verbosity, passphraseFile },
    } = this.parse(Server)

    let credentials: { [key: string]: ICredential } | undefined = undefined
    if (passphraseFile) {
      const _credentials: { [key: string]: ICredential } = {}
      const passphraseDefinitionFile = await new Promise<string>((res, rej) => {
        fs.readFile(passphraseFile, 'utf-8', (err, data) => {
          if (err) {
            rej(err)
          } else {
            res(data)
          }
        })
      })

      const passphraseDefinitionYAML = YAML.load(
        passphraseDefinitionFile
      ) as any
      passphraseDefinitionYAML.forEach((item) => {
        if (item.allowed !== undefined) {
          const allowedHosts: { [host: string]: number[] } = {}

          item.allowed.forEach((hostPortPair) => {
            const [host, port] = hostPortPair.split(':')
            if (allowedHosts[host] === undefined) {
              allowedHosts[host] = []
            }

            if (port === '*') {
              allowedHosts[host].push(0)
            } else {
              allowedHosts[host].push(parseInt(port, 10))
            }
          })

          item.allowed = allowedHosts
        }

        _credentials[item.passphrase] = item
      })
      credentials = _credentials
    }

    const sockets: {
      [id: string]: { [connection: string]: SocketConnection }
    } = {}

    log.level = verbosity

    const isAuthenticated = (body: any) => {
      if (!credentials) return true
      const { passphrase } = body
      if (!passphrase) return false
      return credentials[passphrase] !== undefined
    }

    const httpServer = http.createServer((req, res) => {
      res.writeHead(404)
      res.end()
    })

    httpServer.listen(port, () => {
      log.info('Server started listening at port %d', port)
    })

    const wsServer = new WSServer({
      httpServer,
      autoAcceptConnections: false,
    })

    wsServer.on('request', (req) => {
      const conn = req.accept('proxy', req.origin)
      conn.id = UUIDv4()

      log.info('Connection accepted at %s.', new Date())
      conn.on('message', async (message) => {
        if (isUTF8Message(message)) {
          const body = JSON.parse(message.utf8Data)
          logResponse(log, body)

          if (body.type === 'CONNECT') {
            if (!isAuthenticated(body)) {
              sendJSON(conn, log, { command: 'CONNECT', error: 'AUTHFAIL' })
              return
            } else if (body.passphrase) {
              const { passphrase } = body
              conn.passphrase = passphrase
              log.debug('Passphrase set to %s', passphrase)
            }

            sockets[conn.id] = {}
            sendJSON(conn, log, { command: 'CONNECT' })
          } else if (body.type === 'START') {
            if (!sockets[conn.id]) {
              sendJSON(conn, log, { command: body.type, error: 'AUTHFAIL' })
              return
            }
            const pair = HostPortPair.fromBody(body)
            const socketConnection = new SocketConnection(pair)
            const id = UUIDv4()
            const { passphrase } = conn

            if (credentials) {
              if (!passphrase) {
                sendJSON(conn, log, { command: body.type, error: 'AUTHFAIL' })
                return
              }
              const { allowed } = credentials[passphrase]

              log.debug('Allowed hosts: %o', credentials)

              if (allowed) {
                if (!(allowed[pair.host] || allowed['*'])) {
                  sendJSON(conn, log, {
                    command: body.type,
                    error: 'FORBIDDEN',
                  })
                  return
                }

                const allowedPorts = allowed[pair.host] || allowed['*']
                if (
                  allowedPorts.indexOf(pair.port) === -1 &&
                  allowedPorts.indexOf(0) === -1
                ) {
                  sendJSON(conn, log, {
                    command: body.type,
                    error: 'FORBIDDEN',
                  })
                  return
                }
              }
            }

            sendJSON(conn, log, {
              command: 'START',
              status: 'CONNECTING',
              connection: id,
            })
            socketConnection
              .start()
              .then((socket: net.Socket) => {
                let remoteIP = req.socket.remoteAddress
                if (req.httpRequest.headers['x-forwarded-for'])
                  remoteIP = req.httpRequest.headers[
                    'x-forwarded-for'
                  ] as string
                else if (req.httpRequest.headers['x-remote-ip'])
                  remoteIP = req.httpRequest.headers['x-remote-ip'] as string

                log.info(
                  'Established connection %s <===> server <===> %s',
                  remoteIP,
                  pair.toString()
                )
                sendJSON(conn, log, { status: 'ESTABLISHED', connection: id })

                socket.on('data', (data) => {
                  sendJSON(conn, log, {
                    connection: id,
                    data: data.toString('base64'),
                  })
                })

                socket.on('close', (hadError) => {
                  delete sockets[conn.id][id]
                  sendJSON(conn, log, {
                    connection: id,
                    status: 'CLOSED',
                    hadError,
                  })
                  conn.close()
                })

                sockets[conn.id][id] = socketConnection
              })
              .catch((e) => {
                log.error('Connect failed: %o', e)
                sendJSON(conn, log, {
                  status: 'FAILED',
                  error: e.reason,
                  connection: id,
                })
              })
          } else if (body.type == 'TRAFFIC') {
            if (!sockets[conn.id]) {
              sendJSON(conn, log, { command: body.type, error: 'AUTHFAIL' })
            }
            if (!body.id) {
              sendJSON(conn, log, {
                command: 'TRAFFIC',
                connection: body.id,
                error: 'NOID',
              })
              return
            } else if (!sockets[conn.id][body.id]) {
              sendJSON(conn, log, {
                command: 'TRAFFIC',
                connection: body.id,
                error: 'INVALIDID',
              })
              return
            }

            const { socket } = sockets[conn.id][body.id]
            if (!socket) {
              sendJSON(conn, log, {
                command: 'TRAFFIC',
                connection: body.id,
                error: 'CLOSED',
              })
              return
            }

            socket.write(Buffer.from(body.data, 'base64'), (err) => {
              if (err) {
                sendJSON(conn, log, {
                  connection: body.id,
                  command: 'TRAFFIC',
                  error: err,
                })
              } else {
                sendJSON(conn, log, { connection: body.id, command: 'TRAFFIC' })
              }
            })
          } else {
            sendJSON(conn, log, {
              command: body.type || 'UNKNOWN',
              error: 'NOTIMPLEMENTED',
            })
          }
        }
      })

      conn.on('close', async function () {
        const openConnections = sockets[conn.id]
        for (const id of Object.keys(openConnections || {})) {
          await sockets[conn.id][id].close()
        }
      })
    })
  }
}
