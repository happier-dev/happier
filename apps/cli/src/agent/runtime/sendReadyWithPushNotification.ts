import type { ApiSessionClient } from '@/api/session/sessionClient'
import { logger } from '@/ui/logger'

type PushSender = {
  sendToAllDevices: (title: string, body: string, opts: { sessionId: string }) => void
}

export function sendReadyWithPushNotification(opts: {
  session: ApiSessionClient
  pushSender: PushSender
  waitingForCommandLabel: string
  logPrefix: string
  loggerDebug?: (message: string, error: unknown) => void
}): void {
  opts.session.sendSessionEvent({ type: 'ready' })

  try {
    opts.pushSender.sendToAllDevices(
      "It's ready!",
      `${opts.waitingForCommandLabel} is waiting for your command`,
      { sessionId: opts.session.sessionId },
    )
  } catch (pushError) {
    const loggerDebug = opts.loggerDebug ?? logger.debug.bind(logger)
    loggerDebug(`${opts.logPrefix} Failed to send ready push`, pushError)
  }
}
