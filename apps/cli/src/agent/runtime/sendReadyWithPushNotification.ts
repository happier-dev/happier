import { logger } from '@/ui/logger'
import { shouldSendReadyPushNotificationForActiveAccount } from '@/settings/notifications/notificationsPolicy'
import type { SessionClientPort } from '@/api/session/sessionClientPort'
import axios from 'axios'
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog'

type PushSender = {
  sendToAllDevices: (title: string, body: string, opts: { sessionId: string }) => void
}

export function sendReadyWithPushNotification(opts: {
  session: Pick<SessionClientPort, 'sessionId' | 'sendSessionEvent'>
  pushSender: PushSender
  waitingForCommandLabel: string
  logPrefix: string
  loggerDebug?: (message: string, error: unknown) => void
  shouldSendPush?: () => boolean
}): void {
  opts.session.sendSessionEvent({ type: 'ready' })

  try {
    const shouldSend = opts.shouldSendPush ?? shouldSendReadyPushNotificationForActiveAccount
    if (shouldSend() !== true) return
    opts.pushSender.sendToAllDevices(
      "It's ready!",
      `${opts.waitingForCommandLabel} is waiting for your command`,
      { sessionId: opts.session.sessionId },
    )
  } catch (pushError) {
    const loggerDebug = opts.loggerDebug ?? logger.debug.bind(logger)
    if (axios.isAxiosError(pushError)) {
      loggerDebug(`${opts.logPrefix} Failed to send ready push`, serializeAxiosErrorForLog(pushError))
    } else {
      loggerDebug(`${opts.logPrefix} Failed to send ready push`, pushError)
    }
  }
}
