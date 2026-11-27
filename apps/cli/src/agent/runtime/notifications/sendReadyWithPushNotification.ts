import type { SessionClientPort } from '@/api/session/sessionClientPort'
import type { PushNotificationDeliveryOptions } from '@/api/pushNotifications'
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog'
import type { AccountSettings } from '@happier-dev/protocol';
import { dispatchActivityNotificationAsync } from '@/notifications/activity/dispatchActivityNotification'
import type { ExpoPushActivityNotificationSender } from '@/notifications/activity/sendExpoPushActivityNotification'
import type { SessionNotificationContextReader } from '@/notifications/activity/sessionActivityNotificationEligibility'
import {
  resolveLiveActivityRemoteSender,
  type LiveActivityRemoteSenderCandidate,
} from '@/notifications/activity/liveActivity/resolveLiveActivityRemoteSender'
import { getActiveAccountSettingsSnapshot, getActiveAccountSettingsSnapshotLifetimeToken,
  isActiveAccountSettingsSnapshotLifetimeCurrent } from '@/settings/accountSettings/activeAccountSettingsSnapshot'
import { logger } from '@/ui/logger'
import type { ReadyNotificationTurnContext } from './createReadyNotificationDispatcher'

type PushSender = LiveActivityRemoteSenderCandidate & SessionNotificationContextReader & {
  sendToAllDevices?: (title: string, body: string, opts: { sessionId: string; activityEventLocalId?: string }, deliveryOptions?: PushNotificationDeliveryOptions) => void
  sendToAllDevicesAsync?: ExpoPushActivityNotificationSender['sendToAllDevicesAsync']
}

type ReadyTranscriptSession = Pick<SessionClientPort, 'sessionId'>
  & Required<Pick<SessionClientPort, 'enqueueSessionEventCommitted'>>

export async function enqueueReadySessionEventCommitted(
  session: ReadyTranscriptSession,
  ownerActivityDelivery: 'rich_sender' | 'home_required' = 'home_required',
  completedTurnId?: string,
): ReturnType<ReadyTranscriptSession['enqueueSessionEventCommitted']> {
  const admission = await session.enqueueSessionEventCommitted({ type: 'ready', ownerActivityDelivery,
    ...(completedTurnId ? { completedTurnId } : {}) })
  if (!admission.persisted) {
    throw Object.assign(
      new Error('Ready event was not admitted to durable transcript custody'),
      { code: 'ready_transcript_custody_unavailable' },
    )
  }
  return admission
}

function resolveReadyNotificationSettingsContext(opts: Readonly<{
  accountSettings?: AccountSettings | null
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>
}>) {
  const activeSnapshot = getActiveAccountSettingsSnapshot()
  if (activeSnapshot && activeSnapshot.source !== 'none') {
    const incumbent = activeSnapshot.scopeKey ? { scopeKey: activeSnapshot.scopeKey,
      lifetimeToken: getActiveAccountSettingsSnapshotLifetimeToken() } : null
    return {
      settings: activeSnapshot.settings,
      settingsSecretsReadKeys: activeSnapshot.settingsSecretsReadKeys,
      // The Activity owner acquires the Account row catalog on demand. Do not
      // freeze a missing process-local facet as an explicit loading catalog.
      isCurrent: () => incumbent !== null && isActiveAccountSettingsSnapshotLifetimeCurrent(incumbent),
    }
  }
  return {
    settings: opts.accountSettings ?? null,
    settingsSecretsReadKeys: opts.settingsSecretsReadKeys ?? [],
    notificationChannelCatalog: { status: 'loading' as const },
  }
}

export async function sendReadyWithPushNotification(opts: {
  session: ReadyTranscriptSession
  pushSender: PushSender
  waitingForCommandLabel: string
  logPrefix: string
  sessionTitle?: string | null
  assistantPreviewText?: string | null
  completedTurn?: ReadyNotificationTurnContext['completedTurn']
  includeAssistantPreviewText?: boolean
  accountSettings?: AccountSettings | null
  settingsSecretsReadKeys?: ReadonlyArray<Uint8Array | null | undefined>
  loggerDebug?: (message: string, error: unknown) => void
  shouldSendPush?: () => boolean
}): Promise<void> {
  const hasRichAlertSender = typeof opts.pushSender?.sendToAllDevicesAsync === 'function'
    || typeof opts.pushSender?.sendToAllDevices === 'function'
  const currentSettingsContext = resolveReadyNotificationSettingsContext({
    accountSettings: opts.accountSettings,
    settingsSecretsReadKeys: opts.settingsSecretsReadKeys,
  })
  const admission = await enqueueReadySessionEventCommitted(
    opts.session,
    hasRichAlertSender ? 'rich_sender' : 'home_required',
    opts.completedTurn?.original ? undefined : opts.completedTurn?.turnId,
  )
  const original = opts.completedTurn?.original ?? admission

  try {
    const fetchSessionNotificationContext = opts.pushSender.fetchSessionNotificationContext?.bind(opts.pushSender)
    const loggerDebug = opts.loggerDebug ?? logger.debug.bind(logger)
    const expoPushSender = opts.pushSender?.sendToAllDevicesAsync
      ? {
          sendToAllDevicesAsync: opts.pushSender.sendToAllDevicesAsync.bind(opts.pushSender),
        }
      : opts.pushSender?.sendToAllDevices
        ? {
            sendToAllDevicesAsync: async (title: string, body: string, data: Record<string, unknown>, deliveryOptions?: PushNotificationDeliveryOptions) => {
              const sessionId = typeof data.sessionId === 'string' ? data.sessionId : opts.session.sessionId
              opts.pushSender?.sendToAllDevices?.(title, body, { ...data, sessionId }, deliveryOptions)
              return true
            },
          }
        : null
    void (async () => {
      const committed = original.whenCommitted ? await original.whenCommitted : original
      if (!committed) return
      const contribution = committed.personalFollow
      const sourceMessage = contribution?.sourceMessage
      // The original Turn may already have supplied its selected personal
      // effect before this optional rich marker was committed.
      if (contribution?.accepted === true && contribution.sourceSessionId === opts.session.sessionId
        && sourceMessage && sourceMessage.localId === committed.localId && sourceMessage.seq === committed.committedSequence) return
      const admittedRulePolicies = opts.completedTurn && contribution?.sourceSessionId === opts.session.sessionId
        && sourceMessage && sourceMessage.localId === committed.localId && sourceMessage.seq === committed.committedSequence
        ? sourceMessage.policies : undefined
      await dispatchActivityNotificationAsync({
        ...currentSettingsContext,
        expoPushSender,
        fetchSessionNotificationContext,
        readAccountSessionDeliveryMutedScopes: opts.pushSender.readAccountSessionDeliveryMutedScopes?.bind(opts.pushSender),
        liveActivityRemoteSender: resolveLiveActivityRemoteSender(opts.pushSender),
        admittedRulePolicies,
        ...(opts.completedTurn ? { settledFinished: true } : {}),
        event: {
          topic: 'ready',
          sessionId: opts.session.sessionId,
          sessionTitle: opts.sessionTitle,
          waitingForCommandLabel: opts.waitingForCommandLabel,
          assistantPreviewText: opts.assistantPreviewText,
          ...(committed.localId ? { committedLocalId: committed.localId } : {}),
          ...(committed.committedSequence ? { committedSequence: committed.committedSequence } : {}),
        },
      })
    })().catch((pushError) => {
      loggerDebug(`${opts.logPrefix} Failed to send ready push`, serializeAxiosErrorForLog(pushError))
    })
  } catch (pushError) {
    const loggerDebug = opts.loggerDebug ?? logger.debug.bind(logger)
    loggerDebug(`${opts.logPrefix} Failed to send ready push`, serializeAxiosErrorForLog(pushError))
  }
}
