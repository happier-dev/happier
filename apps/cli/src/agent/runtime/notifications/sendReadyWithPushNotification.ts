import type { SessionClientPort } from '@/api/session/sessionClientPort'
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog'
import { buildReadyNotificationContent, type AccountSettings } from '@happier-dev/protocol'
import { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification'
import {
  resolveLiveActivityRemoteSender,
  type LiveActivityRemoteSenderCandidate,
} from '@/notifications/activity/liveActivity/resolveLiveActivityRemoteSender'
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot'
import { logger } from '@/ui/logger'

type PushSender = LiveActivityRemoteSenderCandidate & {
  sendToAllDevices?: (title: string, body: string, opts: { sessionId: string }) => void
  sendToAllDevicesAsync?: (title: string, body: string, data: Record<string, unknown>) => Promise<void>
}

type ReadyTranscriptSession = Pick<SessionClientPort, 'sessionId'>
  & Required<Pick<SessionClientPort, 'enqueueSessionEventCommitted'>>

export async function enqueueReadySessionEventCommitted(session: ReadyTranscriptSession): Promise<void> {
  const admission = await session.enqueueSessionEventCommitted({ type: 'ready' })
  if (!admission.persisted) {
    throw Object.assign(
      new Error('Ready event was not admitted to durable transcript custody'),
      { code: 'ready_transcript_custody_unavailable' },
    )
  }
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

export async function sendReadyWithPushNotification(opts: {
  session: ReadyTranscriptSession
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
}): Promise<void> {
  await enqueueReadySessionEventCommitted(opts.session)

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
        liveActivityRemoteSender: resolveLiveActivityRemoteSender(opts.pushSender),
        event: {
          topic: 'ready',
          sessionId: opts.session.sessionId,
          sessionTitle: opts.sessionTitle,
          waitingForCommandLabel: opts.waitingForCommandLabel,
          assistantPreviewText: opts.assistantPreviewText,
        },
      }).catch((pushError) => {
        loggerDebug(`${opts.logPrefix} Failed to send ready push`, serializeAxiosErrorForLog(pushError))
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
    loggerDebug(`${opts.logPrefix} Failed to send ready push`, serializeAxiosErrorForLog(pushError))
  }
}
