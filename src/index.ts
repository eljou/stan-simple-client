import EventEmitter from 'events'
import { NatsError } from 'nats'
import stan, { Subscription, Stan, Message } from 'node-nats-streaming'
import { Logger, defaultLogger } from './logger'

export enum NatsClientEvents {
  NATS_CONNECTED = 'nats:connected',
  NATS_CLOSED = 'nats:closed',
  NATS_DISCONNECTED = 'nats:disconnected',
  NATS_CONNECTION_LOST = 'nats:connection_lost',
  NATS_RECONNECTED = 'nats:reconnected',
  NATS_RECONNECTING = 'nats:reconnecting',
  NATS_ERROR = 'nats:error',
  NATS_SUBSCRIPTION_ERROR = 'nats:subscription:error',
  NATS_MAX_RECONNECT_RETRIES = 'nats:max_reconnect:retries',
}

export enum StanConnectionEvents {
  CONNECT = 'connect',
  CLOSE = 'close',
  DISCONNECT = 'disconnect',
  CONNECTION_LOST = 'connection_lost',
  RECONNECT = 'reconnect',
  RECONNECTING = 'reconnecting',
  ERROR = 'error',
}

export enum ConnectionStates {
  CONNECTED,
  DISCONNECTED,
  CLOSED,
}

export interface ConnectionOptions {
  clientId: string
  clusterName: string
  maxReconnectAttempts: number
  restartTimeout?: number
  stanMaxPingOut?: number
  stanPingInterval?: number
  stanEncoding?: string
  reconnectTimeWait?: number
}

export enum SubscriptionModes {
  ALL_AVAILABLE,
  START_WITH_LAST_RECEIVED,
  START_AT_SEQUENCE,
  START_AT_TIME_DELTA,
  START_TIME,
}
export type SubscriptionType =
  | { mode: SubscriptionModes.ALL_AVAILABLE }
  | { mode: SubscriptionModes.START_WITH_LAST_RECEIVED }
  | { mode: SubscriptionModes.START_AT_SEQUENCE; value: number }
  | { mode: SubscriptionModes.START_TIME; value: Date }
  | { mode: SubscriptionModes.START_AT_TIME_DELTA; value: number }
export interface SubOptions {
  queueGroup?: string
  manualAck: boolean
  ackWait?: number
  durableName?: string
  maxInFlight?: number
  subType: SubscriptionType
}
export type SubscriptionHandler = (result: MessageResult, manualAck?: () => void) => void
export interface MessageResult {
  sequence: number
  data: string | Buffer
  timestamp: Date
  isRedelivered: boolean
}

export interface NatsSubscription {
  subject: string
  instance: Subscription
}

export class NatsStreamingClient extends EventEmitter {
  private logger: Logger
  private connectionState: ConnectionStates
  private connectionOptions: ConnectionOptions
  private stanClient: Stan | null
  private serversURI: string[]
  private subscriptions: NatsSubscription[]
  private disconnectsCounter: number = 10

  public constructor(
    connectionString: string,
    connectionOptions: ConnectionOptions,
    logger: Logger = defaultLogger('[queue]'),
  ) {
    super()
    //TODO: Validate construction parameters

    this.logger = logger
    this.subscriptions = []
    this.connectionState = ConnectionStates.DISCONNECTED
    this.connectionOptions = connectionOptions
    this.connectionOptions.stanMaxPingOut = 3
    this.connectionOptions.stanPingInterval = 5000
    this.connectionOptions.reconnectTimeWait = 3000
    this.connectionOptions.stanEncoding = 'utf8'
    this.connectionOptions.maxReconnectAttempts = connectionOptions.maxReconnectAttempts || -1
    this.connectionOptions.clusterName = connectionOptions.clusterName
    this.connectionOptions.clientId = connectionOptions.clientId

    this.stanClient = null
    const servers = connectionString.split(',')
    if (servers.length === 0) {
      throw new Error(`Bad connection string format -> ${connectionString}`)
    }
    this.serversURI = servers
    this.disconnectsCounter = connectionOptions.maxReconnectAttempts
  }

  private relaunchConnection(): void {
    if (this.stanClient) {
      this.stanClient.removeAllListeners()
      this.subscriptions.forEach(
        (sub): void => {
          sub.instance.removeAllListeners()
          this.logger.debug(`subscription subject: ${sub.subject} cleared`)
        },
      )
      this.subscriptions = []

      try {
        this.stanClient.close()
        this.stanClient = null
      } catch (error) {
        this.logger.error(error)
      } finally {
        this.connect()
      }
    }
  }

  public connect(): void {
    this.stanClient = stan.connect(this.connectionOptions.clusterName, this.connectionOptions.clientId, {
      servers: this.serversURI,
      ...this.connectionOptions,
    })
    if (this.stanClient !== null) {
      this.stanClient.on(
        StanConnectionEvents.CONNECT,
        (): void => {
          this.connectionState = ConnectionStates.CONNECTED
          this.emit(NatsClientEvents.NATS_CONNECTED)
          this.logger.info(`NATS server connected with client_id: ${this.connectionOptions.clientId}`)

          this.stanClient &&
            this.stanClient.on(
              StanConnectionEvents.CONNECTION_LOST,
              (): void => {
                this.connectionState = ConnectionStates.CLOSED
                this.logger.error(`NATS server connection lost`)
                this.emit(NatsClientEvents.NATS_CONNECTION_LOST)
                setTimeout((): void => {
                  this.logger.info('Reinstanciating connection')
                  this.relaunchConnection()
                }, this.connectionOptions.restartTimeout || 1000)
              },
            )
        },
      )
      this.stanClient.on(
        StanConnectionEvents.DISCONNECT,
        (): void => {
          this.connectionState = ConnectionStates.DISCONNECTED
          this.logger.info(`NATS server disconnected`)
          this.emit(NatsClientEvents.NATS_DISCONNECTED)
          if (this.connectionOptions.maxReconnectAttempts > -1) {
            this.disconnectsCounter -= 1
            if (this.disconnectsCounter <= 0) {
              this.disconnectsCounter = this.connectionOptions.maxReconnectAttempts || 10
              this.emit(NatsClientEvents.NATS_MAX_RECONNECT_RETRIES, this.connectionOptions.maxReconnectAttempts)
            }
          }
        },
      )
      this.stanClient.on(
        StanConnectionEvents.CLOSE,
        (): void => {
          this.connectionState = ConnectionStates.CLOSED
          this.logger.info(`NATS server connection closed`)
          this.emit(NatsClientEvents.NATS_CLOSED)
        },
      )
      this.stanClient.on(
        StanConnectionEvents.RECONNECTING,
        (): void => {
          this.logger.debug(`NATS server reconnecting`)
          this.emit(NatsClientEvents.NATS_RECONNECTING)
        },
      )
      this.stanClient.on(
        StanConnectionEvents.RECONNECT,
        (): void => {
          this.connectionState = ConnectionStates.CONNECTED
          this.logger.info(`NATS server reconnected`)
          this.emit(NatsClientEvents.NATS_RECONNECTED)
        },
      )
      this.stanClient.on(
        StanConnectionEvents.ERROR,
        (error: NatsError): void => {
          this.logger.error(`NATS server reconnected`)
          this.emit(NatsClientEvents.NATS_ERROR, error)
        },
      )
    }
  }

  public isConnected(): boolean {
    return this.connectionState === ConnectionStates.CONNECTED
  }

  public getConnectionState(): ConnectionStates {
    return this.connectionState
  }

  public publish(subject: string, data?: Uint8Array | string | Buffer): Promise<string> {
    return new Promise(
      (resolve, reject): void => {
        if (this.stanClient === null) {
          reject(new Error('NATS connection has not been opened'))
        } else {
          this.stanClient.publish(
            subject,
            data,
            (err, guid): void => {
              if (err) {
                reject(err)
              }
              resolve(guid)
            },
          )
        }
      },
    )
  }

  public subscribe(
    subject: string,
    handler: SubscriptionHandler,
    options: SubOptions = {
      manualAck: true,
      subType: { mode: SubscriptionModes.ALL_AVAILABLE },
    },
  ): void {
    if (!subject || !handler) {
      throw new Error('In order to subscribe you must provide a "subject" and a "message callback function"')
    }

    if (this.stanClient === null) {
      throw new Error('NATS connection has not been opened')
    }

    const subscriptionOptions = this.stanClient.subscriptionOptions()
    subscriptionOptions.setManualAckMode(options.manualAck)
    subscriptionOptions.setAckWait(options.ackWait || 30000)
    options.durableName && subscriptionOptions.setDurableName(options.durableName)
    options.maxInFlight && subscriptionOptions.setMaxInFlight(options.maxInFlight)
    switch (options.subType.mode) {
      case SubscriptionModes.ALL_AVAILABLE:
        subscriptionOptions.setDeliverAllAvailable()
        break
      case SubscriptionModes.START_WITH_LAST_RECEIVED:
        subscriptionOptions.setStartWithLastReceived()
        break
      case SubscriptionModes.START_AT_SEQUENCE:
        subscriptionOptions.setStartAtSequence(options.subType.value)
        break
      case SubscriptionModes.START_TIME:
        subscriptionOptions.setStartTime(options.subType.value)
        break
      case SubscriptionModes.START_AT_TIME_DELTA:
        subscriptionOptions.setStartAtTimeDelta(options.subType.value)
        break
      default:
        subscriptionOptions.setDeliverAllAvailable()
        break
    }

    const subscription = options.queueGroup
      ? this.stanClient.subscribe(subject, options.queueGroup, subscriptionOptions)
      : this.stanClient.subscribe(subject, subscriptionOptions)
    subscription.on(
      'ready',
      (): void => {
        this.logger.info(`${subject} subscription ready`)
      },
    )
    subscription.on(
      'message',
      (message: Message): void => {
        handler(
          {
            sequence: message.getSequence(),
            data: message.getData().toString(),
            timestamp: message.getTimestamp(),
            isRedelivered: message.isRedelivered(),
          },
          options && options.manualAck
            ? (): void => {
                message.ack()
              }
            : undefined,
        )
      },
    )
    // TODO: do something with subscriptions errors
    subscription.on(
      'error',
      (error): void => {
        this.logger.error(`:[subscription] ERROR:: ${error}`)
        this.emit(NatsClientEvents.NATS_SUBSCRIPTION_ERROR)
      },
    )
    this.subscriptions.push({
      subject,
      instance: subscription,
    })
  }

  public unsubscribe(subject: string): Promise<void> {
    return new Promise(
      (resolve): void => {
        this.subscriptions.forEach(
          (sub): void => {
            if (sub.subject === subject) {
              sub.instance.on(
                'unsubscribed',
                (): void => {
                  this.logger.info(`unsubscribed from subject: ${subject}`)
                  sub.instance.removeAllListeners()
                  this.subscriptions = this.subscriptions.filter((sub): boolean => sub.subject !== subject)
                  resolve()
                },
              )
              sub.instance.on(
                'error',
                (): void => {
                  this.logger.debug(`deleted subscription from subject: ${subject}`)
                  sub.instance.removeAllListeners()
                  this.subscriptions = this.subscriptions.filter((sub): boolean => sub.subject !== subject)
                  resolve()
                },
              )
              sub.instance.unsubscribe()
            }
          },
        )
      },
    )
  }

  public unsubscribeAll(): Promise<void> {
    return new Promise(
      async (resolve): Promise<void> => {
        if (this.subscriptions.length === 0) {
          this.logger.info(`No subscriptions active`)
          return resolve()
        }

        for (const subscription of this.subscriptions) {
          await this.unsubscribe(subscription.subject)
        }
        this.logger.info(`unsubscribed from all subjects`)
        resolve()
      },
    )
  }

  public async closeConnection(cleanSubscriptions = true): Promise<void> {
    if (!this.stanClient || this.connectionState !== ConnectionStates.CONNECTED) {
      throw new Error(`NATS connection state is ${this.connectionState}`)
    }
    if (cleanSubscriptions) {
      await this.unsubscribeAll()
    }

    this.connectionState = ConnectionStates.CLOSED
    this.stanClient && this.stanClient.close()
  }
}
