import type { ApiClient } from '@/api/api'
import type { ApiSessionClient } from '@/api/session/sessionClient'
import type { AgentState, Metadata, Session } from '@/api/types'
import { setupOfflineReconnection } from '@/api/offline/setupOfflineReconnection'
import { createBaseSessionForAttach } from '@/agent/runtime/createBaseSessionForAttach'
import {
  applyStartupMetadataUpdateToSession,
  type AcpSessionModeOverride,
  type ModelOverride,
  type PermissionModeOverride,
} from '@/agent/runtime/startupMetadataUpdate'
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
  allowOfflineStub?: boolean
  onSessionSwap?: (newSession: ApiSessionClient) => void
  onAttachMetadataSnapshotError?: (error: unknown) => void
  onAttachMetadataSnapshotMissing?: (error: unknown | null) => void
  onAttachMetadataSnapshotReady?: (snapshot: unknown, session: ApiSessionClient) => void
  startupSideEffectsOrder?: 'report-first' | 'persist-first'
}

export interface InitializeBackendRunSessionResult {
  session: ApiSessionClient
  reconnectionHandle: { cancel: () => void } | null
  reportedSessionId: string | null
  attachedToExistingSession: boolean
}

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
  const terminal = opts.metadata.terminal
  const runStartupSideEffects = async (sessionToUse: ApiSessionClient, sessionId: string): Promise<void> => {
    if (startupSideEffectsOrder === 'persist-first') {
      await persistTerminalAttachmentInfoIfNeededFn({ sessionId, terminal })
      sendTerminalFallbackMessageIfNeededFn({ session: sessionToUse, terminal })
      await reportSessionToDaemonIfRunningFn({ sessionId, metadata: opts.metadata })
      return
    }

    await reportSessionToDaemonIfRunningFn({ sessionId, metadata: opts.metadata })
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

    let snapshot: unknown = null
    let snapshotError: unknown = null
    try {
      snapshot = await session.ensureMetadataSnapshot({ timeoutMs: 30_000 })
    } catch (error) {
      snapshotError = error
      opts.onAttachMetadataSnapshotError?.(error)
    }

    if (snapshot) {
      applyStartupMetadataUpdateToSessionFn({
        session,
        next: opts.metadata,
        nowMs: nowFn(),
        permissionModeOverride: opts.startupMetadataOverrides.permissionModeOverride,
        acpSessionModeOverride: opts.startupMetadataOverrides.acpSessionModeOverride,
        modelOverride: opts.startupMetadataOverrides.modelOverride,
        mode: 'attach',
      })
      opts.onAttachMetadataSnapshotReady?.(snapshot, session)
    } else {
      opts.onAttachMetadataSnapshotMissing?.(snapshotError)
    }

    primeAgentStateForUiFn(session, opts.uiLogPrefix)
    await runStartupSideEffects(session, existingSessionId)

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

  const { session, reconnectionHandle } = setupOfflineReconnectionFn({
    api: opts.api as ApiClient,
    sessionTag: opts.sessionTag,
    metadata: opts.metadata,
    state: opts.state,
    response: response as Session | null,
    onSessionSwap: (newSession) => {
      opts.onSessionSwap?.(newSession)
    },
  })

  const reportedSessionId = response ? response.id : null
  primeAgentStateForUiFn(session, opts.uiLogPrefix)
  if (reportedSessionId) {
    await runStartupSideEffects(session, reportedSessionId)
  }

  return {
    session,
    reconnectionHandle,
    reportedSessionId,
    attachedToExistingSession: false,
  }
}
