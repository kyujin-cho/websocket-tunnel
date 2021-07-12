import { Command, flags } from '@oclif/command'
import { Mutex } from 'async-mutex'
import net from 'net'
import Pino from 'pino'
import { v4 as UUIDv4 } from 'uuid'
import { client as WSClient, connection } from 'websocket'

import { isUTF8Message, logResponse, panic, sendJSON } from '../utils'

const log = Pino({
  prettyPrint: true,
})

const startConnection = async (client: WSClient, server: string) => {
  return new Promise<void>((res) => {
    client.connect(server, 'proxy')
    client.on('connect', (conn) => {
      conn.on('message', (data) => {
        if (isUTF8Message(data)) {
          const body = JSON.parse(data.utf8Data)
          if (body.status === 'ESTABLISHED') res()
        }
      })
    })
  })
}

export default class Client extends Command {
  static description = 'WebSocket Relay Client'
  static examples = [
    `$ wstunnel client wss://tunnel.foo.bar google.com:80`,
    `$ wstunnel client wss://tunnel.foo.bar google.com:80 -P foobar`,
    `$ wstunnel client wss://tunnel.foo.bar google.com:80 -p 9999`,
  ]

  static args = [
    { name: 'relayServer', description: 'Target relay server' },
    { name: 'target', description: 'destination to initiate TCP connection' },
  ]

  static flags = {
    port: flags.integer({
      char: 'p',
      description: 'Local port to accept traffic',
    }),
    verbosity: flags.enum({
      char: 'v',
      options: ['error', 'info', 'debug', 'trace'],
      default: 'info',
      description: 'Log output verbosity',
    }),
    passphrase: flags.string({
      char: 'P',
      description:
        'If provided, try to access with given passphrase to server protected with passphrase',
    }),
  }

  async run() {
    const {
      argv: [relayServer, target],
      flags: { port: fixedPort, verbosity, passphrase },
    } = this.parse(Client)

    log.level = verbosity

    const port = fixedPort || Math.floor(Math.random() * 55535) + 10000

    let connectionId = ''

    let wsConnection: connection | undefined = undefined
    let isConnected = false

    const buffers: Buffer[] = []

    const lock = new Mutex()

    const setupWsClient = (): WSClient => {
      const wsClient = new WSClient()
      const clientId = UUIDv4()

      wsClient.on('connectFailed', (error) => {
        panic(log, undefined, 'Connect Error: ' + error.toString())
      })

      wsClient.on('connect', (conn) => {
        isConnected = true
        log.debug('%s: Initiated connection with remote server', clientId)
        wsConnection = conn

        sendJSON(conn, log, { type: 'CONNECT', passphrase })

        conn.on('message', (data) => {
          if (isUTF8Message(data)) {
            const body = JSON.parse(data.utf8Data)
            logResponse(log, body)
            switch (body.command) {
              case 'CONNECT':
                if (body.error) {
                  conn.close()
                  localServer?.close()
                  panic(log, body.error)
                } else {
                  sendJSON(conn, log, {
                    type: 'START',
                    host: target.split(':')[0],
                    port: parseInt(target.split(':')[1]),
                  })
                }
                break
              case 'START':
                if (body.error) {
                  conn.close()
                  localServer?.close()
                  panic(log, body.error)
                } else {
                  connectionId = body.connection
                  log.info('Allocated Resource# %s...', body.connection)
                }
                break
              case 'TRAFFIC':
                if (body.error) {
                  conn.close()
                  localServer?.close()
                  panic(log, body.error)
                }
                break
            }

            if (body.connection) {
              if (body.status) {
                switch (body.status) {
                  case 'ESTABLISHED':
                    log.info(
                      `Connection to %s successfully started on remote server...`,
                      target
                    )
                    log.info(`Now accepting traffic from localhost:%s!`, port)
                    break
                  case 'CLOSED':
                    localServer?.close()
                    panic(log, undefined, 'Remote socket closed')
                    break
                  case 'FAILED':
                    localServer?.close()
                    panic(
                      log,
                      undefined,
                      'Failed to initiate connection from remote site'
                    )
                    break
                }
              } else if (body.data) {
                const buffer = Buffer.from(body.data, 'base64')
                if (client) {
                  log.trace('Sending %d bytes to client', buffer.length)
                  client.write(buffer)
                } else {
                  log.trace('Stacking received bytes until client connects')
                  buffers.push(buffer)
                }
              }
            }
          }
        })

        conn.on('close', () => {
          log.info('Connection closed from remote server')
          wsClient.removeAllListeners()
          isConnected = false
        })
      })

      return wsClient
    }

    const localServer = net.createServer((socket) => {
      socket.on('data', async (data) => {
        const release = await lock.acquire()
        if (!isConnected) {
          await startConnection(setupWsClient(), relayServer)
        }
        release()
        wsConnection &&
          sendJSON(wsConnection, log, {
            type: 'TRAFFIC',
            id: connectionId,
            data: data.toString('base64'),
          })
      })

      socket.on('close', () => {
        wsConnection?.close()
        client = undefined
      })
    })

    localServer.on('connection', (socket) => {
      if (!client) {
        client = socket
        log.debug('Allocated client')
        while (buffers.length > 0) {
          const buffer = buffers.shift() as Buffer
          log.trace('Sending %d bytes to client', buffer.length)
          socket.write(buffer)
        }
      } else {
        socket.end()
      }
    })

    localServer.listen(port)

    let client: net.Socket | undefined = undefined

    const release = await lock.acquire()
    await startConnection(setupWsClient(), relayServer)
    release()

    isConnected = true
  }
}
