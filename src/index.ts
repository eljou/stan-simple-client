import NatsStreamingClient, {
  SubscriptionModes,
  ClientEvents,
  MessageResult,
  SubscriptionHandler,
} from './lib/NatsStreamingClient'

const handleMessage: SubscriptionHandler = (
  message: MessageResult,
  markAsProcessed: (() => void) | undefined,
): void => {
  console.log(`got message ${message.sequence}`)

  setTimeout((): void => {
    markAsProcessed && markAsProcessed()
  }, 900)
}

const client = new NatsStreamingClient(
  'checkout-cluster',
  // 'test-cluster',
  'tester',
  'nats://localhost:4222',
  // 'nats://localhost:4222, nats://localhost:4223, nats://localhost:4224',
  {
    restartTimeout: 2000,
  },
)
client.connect()
client.on(
  ClientEvents.NATS_CONNECTED,
  (): void => {
    ;['foo', 'bar'].forEach(
      (channel): void => {
        client.subscribe(channel, handleMessage, {
          queueGroup: 'test-group',
          manualAck: true,
          subType: {
            mode: SubscriptionModes.ALL_AVAILABLE,
          },
        })
      },
    )
  },
)

let isShuttingDown = false
const gracefullShutdown = (): void => {
  if (!isShuttingDown) {
    isShuttingDown = true
    client.closeConnection()
  }
}
process.on('SIGINT', gracefullShutdown)
process.on('SIGTERM', gracefullShutdown)
