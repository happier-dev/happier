import { logger } from '@/ui/logger'
import type { SessionClientPort } from '@/api/session/sessionClientPort'
import axios from 'axios'
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog'
import { buildReadyNotificationContent, type AccountSettings } from '@happier-dev/protocol'
import { dispatchActivityNotificationAsync } from '@/activity/notifications/dispatchActivityNotification'
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot'

type PushSender = {
  sendToAllDevices?: (title: string, body: string, opts: { sessionId: string }) => void
  sendToAllDevicesAsync?: (title: string, body: string, data: Record<string, unknown>) => Promise<void>
}

function resolveReadyNotificationSettingsContext(opts: Readonly<{
  accountSettings?: AccountSettings | null
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>
}>): Readonly<{
  settings: AccountSettings | null
  settingsSecretsReadKeys: ReadonlyArray<Uint8Array | null | undefined>
}> {
  const activeSnapshot = getActiveAccountSettingsSnapshot()
  if (activeSnapshot && activeSnapshot.source !== 'none') {
    return {
      settings: activeSnapshot.settings,
      settingsSecretsReadKeys: activeSnapshot.settingsSecretsReadKeys,
    }
  }
  return {
    settings: opts.accountSettings ?? null,
    settingsSecretsReadKeys: opts.settingsSecretsReadKeys ?? [],
  }
}

export function sendReadyWithPushNotification(opts: {
  session: Pick<SessionClientPort, 'sessionId' | 'sendSessionEvent'>
  pushSender: PushSender
  waitingForCommandLabel: string
  logPrefix: string
  sessionTitle?: string | null
  assistantPreviewText?: string | null
  includeAssistantPreviewText?: boolean
  accountSettings?: AccountSettings | null
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>
  loggerDebug?: (message: string, error: unknown) => void
  shouldSendPush?: () => boolean
}): void {
  opts.session.sendSessionEvent({ type: 'ready' })

  try {
    const currentSettingsContext = resolveReadyNotificationSettingsContext({
      accountSettings: opts.accountSettings,
      settingsSecretsReadKeys: opts.settingsSecretsReadKeys,
    })
    if (currentSettingsContext.settings) {
      const loggerDebug = opts.loggerDebug ?? logger.debug.bind(logger)
      const expoPushSender = opts.pushSender?.sendToAllDevicesAsync
        ? {
          sendToAllDevicesAsync: opts.pushSender.sendToAllDevicesAsync.bind(opts.pushSender),
        }
        : opts.pushSender?.sendToAllDevices
          ? {
            sendToAllDevicesAsync: async (title: string, body: string, data: Record<string, unknown>) => {
              const sessionId = typeof data.sessionId === 'string' ? data.sessionId : opts.session.sessionId
              opts.pushSender?.sendToAllDevices?.(title, body, { sessionId })
            },
          }
          : null
      void dispatchActivityNotificationAsync({
        settings: currentSettingsContext.settings,
        settingsSecretsReadKeys: currentSettingsContext.settingsSecretsReadKeys,
        expoPushSender,
        event: {
          topic: 'ready',
          sessionId: opts.session.sessionId,
          sessionTitle: opts.sessionTitle,
          waitingForCommandLabel: opts.waitingForCommandLabel,
          assistantPreviewText: opts.assistantPreviewText,
        },
      }).catch((pushError) => {
        if (axios.isAxiosError(pushError)) {
          loggerDebug(`${opts.logPrefix} Failed to send ready push`, serializeAxiosErrorForLog(pushError))
        } else {
          loggerDebug(`${opts.logPrefix} Failed to send ready push`, pushError)
        }
      })
      return
    }
    const shouldSend = opts.shouldSendPush ?? (() => true)
    if (shouldSend() !== true) return
    if (!opts.pushSender?.sendToAllDevices) return
    const content = buildReadyNotificationContent({
      sessionTitle: opts.sessionTitle,
      defaultTitle: opts.waitingForCommandLabel,
      waitingForCommandLabel: opts.waitingForCommandLabel,
      fallbackBody: `${opts.waitingForCommandLabel} is waiting for your command`,
      includeMessageText: opts.includeAssistantPreviewText,
      messageText: opts.assistantPreviewText,
    })
    opts.pushSender.sendToAllDevices(
      content.title,
      content.body,
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
