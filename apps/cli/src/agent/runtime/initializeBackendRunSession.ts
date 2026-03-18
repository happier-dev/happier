import type { ApiClient } from '@/api/api'
import type { ApiSessionClient } from '@/api/session/sessionClient'
import type { AgentState, Metadata, Session } from '@/api/types'
import type { SessionAttachMetadataIdentityPolicy } from '@happier-dev/protocol'
import { setupOfflineReconnection } from '@/api/offline/setupOfflineReconnection'
import { createBaseSessionForAttach } from '@/agent/runtime/createBaseSessionForAttach'
import {
  applyStartupMetadataUpdateToSession,
  type AcpSessionModeOverride,
  type ModelOverride,
  type PermissionModeOverride,
} from '@/agent/runtime/startupMetadataUpdate'
import { mergeSessionMetadataForStartup } from '@/agent/runtime/mergeSessionMetadataForStartup'
import { readSessionAttachMetadataIdentityPolicyFromEnv } from '@/agent/runtime/readSessionAttachMetadataIdentityPolicyFromEnv'
import {
  persistTerminalAttachmentInfoIfNeeded,
  primeAgentStateForUi,
  reportSessionToDaemonIfRunning,
  sendTerminalFallbackMessageIfNeeded,
} from '@/agent/runtime/startupSideEffects'

export interface InitializeBackendRunSessionOptions {
  api: Pick<ApiClient, 'getOrCreateSession' | 'sessionSyncClient'>
  sessionTag: string
  metadata: Metadata
  state: AgentState
  existingSessionId?: string
  uiLogPrefix: string
  startupMetadataOverrides: {
    permissionModeOverride: PermissionModeOverride
    acpSessionModeOverride?: AcpSessionModeOverride
    modelOverride?: ModelOverride
  }
  metadataKeysToUnsetOnAttach?: readonly string[]
  attachMetadataIdentityPolicy?: SessionAttachMetadataIdentityPolicy | null
  /**
   * Optional: forward offline reconnection status updates (e.g. "Reconnected!") to the caller's UX.
   * When omitted, the offline reconnection utility uses console output.
   */
  offlineNotify?: (message: string) => void
  allowOfflineStub?: boolean
  onSessionSwap?: (newSession: ApiSessionClient) => void | Promise<void>
  onAttachMetadataSnapshotError?: (error: unknown) => void
  onAttachMetadataSnapshotMissing?: (error: unknown | null) => void
  onAttachMetadataSnapshotReady?: (snapshot: unknown, session: ApiSessionClient) => void | Promise<void>
  startupSideEffectsOrder?: 'report-first' | 'persist-first'
}

export interface InitializeBackendRunSessionResult {
  session: ApiSessionClient
  reconnectionHandle: { cancel: () => void } | null
  reportedSessionId: string | null
  attachedToExistingSession: boolean
}

type DaemonReportMode = 'await' | 'background'

type InitializeBackendRunSessionDeps = {
  createBaseSessionForAttachFn?: typeof createBaseSessionForAttach
  setupOfflineReconnectionFn?: typeof setupOfflineReconnection
  applyStartupMetadataUpdateToSessionFn?: typeof applyStartupMetadataUpdateToSession
  primeAgentStateForUiFn?: typeof primeAgentStateForUi
  reportSessionToDaemonIfRunningFn?: typeof reportSessionToDaemonIfRunning
  persistTerminalAttachmentInfoIfNeededFn?: typeof persistTerminalAttachmentInfoIfNeeded
  sendTerminalFallbackMessageIfNeededFn?: typeof sendTerminalFallbackMessageIfNeeded
  nowFn?: () => number
}

function normalizeExistingSessionId(existingSessionId: string | undefined): string {
  if (typeof existingSessionId !== 'string') return ''
  return existingSessionId.trim()
}

export async function initializeBackendRunSession(
  opts: InitializeBackendRunSessionOptions,
  deps: InitializeBackendRunSessionDeps = {},
): Promise<InitializeBackendRunSessionResult> {
  const createBaseSessionForAttachFn = deps.createBaseSessionForAttachFn ?? createBaseSessionForAttach
  const setupOfflineReconnectionFn = deps.setupOfflineReconnectionFn ?? setupOfflineReconnection
  const applyStartupMetadataUpdateToSessionFn = deps.applyStartupMetadataUpdateToSessionFn ?? applyStartupMetadataUpdateToSession
  const primeAgentStateForUiFn = deps.primeAgentStateForUiFn ?? primeAgentStateForUi
  const reportSessionToDaemonIfRunningFn = deps.reportSessionToDaemonIfRunningFn ?? reportSessionToDaemonIfRunning
  const persistTerminalAttachmentInfoIfNeededFn = deps.persistTerminalAttachmentInfoIfNeededFn ?? persistTerminalAttachmentInfoIfNeeded
  const sendTerminalFallbackMessageIfNeededFn = deps.sendTerminalFallbackMessageIfNeededFn ?? sendTerminalFallbackMessageIfNeeded
  const nowFn = deps.nowFn ?? (() => Date.now())
  const startupSideEffectsOrder = opts.startupSideEffectsOrder ?? 'report-first'

  const existingSessionId = normalizeExistingSessionId(opts.existingSessionId)
  const attachMetadataIdentityPolicy =
    opts.attachMetadataIdentityPolicy
    ?? readSessionAttachMetadataIdentityPolicyFromEnv()
    ?? null
  const terminal = opts.metadata.terminal
  const startDaemonReport = (sessionId: string, metadata: Metadata, mode: DaemonReportMode): Promise<void> => {
    const reportPromise = reportSessionToDaemonIfRunningFn({ sessionId, metadata })
    if (mode === 'background') {
      void reportPromise.catch(() => {})
      return Promise.resolve()
    }
    return reportPromise
  }
  const runStartupSideEffects = async (
    sessionToUse: ApiSessionClient,
    sessionId: string,
    metadata: Metadata,
    daemonReportMode: DaemonReportMode,
  ): Promise<void> => {
    if (startupSideEffectsOrder === 'persist-first') {
      await persistTerminalAttachmentInfoIfNeededFn({ sessionId, terminal })
      sendTerminalFallbackMessageIfNeededFn({ session: sessionToUse, terminal })
      await startDaemonReport(sessionId, metadata, daemonReportMode)
      return
    }

    await startDaemonReport(sessionId, metadata, daemonReportMode)
    await persistTerminalAttachmentInfoIfNeededFn({ sessionId, terminal })
    sendTerminalFallbackMessageIfNeededFn({ session: sessionToUse, terminal })
  }

  if (existingSessionId) {
    const baseSession = await createBaseSessionForAttachFn({
      existingSessionId,
      metadata: opts.metadata,
      state: opts.state,
    })
    const session = opts.api.sessionSyncClient(baseSession)

    let snapshot: Metadata | null = null
    let snapshotError: unknown = null
    let daemonReportMetadata = opts.metadata
    try {
      snapshot = await session.ensureMetadataSnapshot({ timeoutMs: 30_000 })
    } catch (error) {
      snapshotError = error
      opts.onAttachMetadataSnapshotError?.(error)
    }

    if (snapshot) {
      const startupNowMs = nowFn()
      daemonReportMetadata = mergeSessionMetadataForStartup({
        current: snapshot,
        next: opts.metadata,
        nowMs: startupNowMs,
        permissionModeOverride: opts.startupMetadataOverrides.permissionModeOverride,
        acpSessionModeOverride: opts.startupMetadataOverrides.acpSessionModeOverride,
        modelOverride: opts.startupMetadataOverrides.modelOverride,
        metadataKeysToUnsetOnAttach: opts.metadataKeysToUnsetOnAttach,
        attachMetadataIdentityPolicy,
        mode: 'attach',
      })
      await applyStartupMetadataUpdateToSessionFn({
        session,
        next: opts.metadata,
        nowMs: startupNowMs,
        permissionModeOverride: opts.startupMetadataOverrides.permissionModeOverride,
        acpSessionModeOverride: opts.startupMetadataOverrides.acpSessionModeOverride,
        modelOverride: opts.startupMetadataOverrides.modelOverride,
        metadataKeysToUnsetOnAttach: opts.metadataKeysToUnsetOnAttach,
        attachMetadataIdentityPolicy,
        mode: 'attach',
      })
      await opts.onAttachMetadataSnapshotReady?.(snapshot, session)
    } else {
      opts.onAttachMetadataSnapshotMissing?.(snapshotError)
    }

    primeAgentStateForUiFn(session, opts.uiLogPrefix)
    await runStartupSideEffects(session, existingSessionId, daemonReportMetadata, 'background')

    return {
      session,
      reconnectionHandle: null,
      reportedSessionId: existingSessionId,
      attachedToExistingSession: true,
    }
  }

  const response = await opts.api.getOrCreateSession({
    tag: opts.sessionTag,
    metadata: opts.metadata,
    state: opts.state,
  })

  if (!response && !opts.allowOfflineStub) {
    throw new Error('Failed to create session')
  }

  const reportedSessionId = response ? response.id : null
  let ranStartupSideEffects = false
  const runStartupSideEffectsOnce = async (sessionToUse: ApiSessionClient, sessionId: string): Promise<void> => {
    if (ranStartupSideEffects) return
    ranStartupSideEffects = true
    await runStartupSideEffects(sessionToUse, sessionId, opts.metadata, 'await')
  }

  const { session, reconnectionHandle } = setupOfflineReconnectionFn({
    api: opts.api as ApiClient,
    sessionTag: opts.sessionTag,
    metadata: opts.metadata,
    state: opts.state,
    response: response as Session | null,
    onNotify: opts.offlineNotify,
    onSessionSwap: (newSession) => {
      if (opts.onSessionSwap) {
        try {
          void Promise.resolve(opts.onSessionSwap(newSession)).catch(() => {})
        } catch {
          // Swallow hook failures; reconnection should continue.
        }
      }

      // If startup began offline (no session id yet), rerun UI priming and startup side effects once the
      // real session arrives. Do not do this for normal online starts (reportedSessionId is set).
      if (reportedSessionId) return
      if (ranStartupSideEffects) return
      const nextId = String((newSession as any)?.sessionId ?? '').trim()
      if (!nextId || nextId.startsWith('offline-')) return

      primeAgentStateForUiFn(newSession, opts.uiLogPrefix)
      void runStartupSideEffectsOnce(newSession, nextId).catch(() => {})
    },
  })

  primeAgentStateForUiFn(session, opts.uiLogPrefix)
  if (reportedSessionId) {
    await runStartupSideEffectsOnce(session, reportedSessionId)
  }

  return {
    session,
    reconnectionHandle,
    reportedSessionId,
    attachedToExistingSession: false,
  }
}
