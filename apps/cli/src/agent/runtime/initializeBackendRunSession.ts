import type { ApiClient } from '@/api/api'
import type { ApiSessionClient } from '@/api/session/sessionClient'
import type { AgentState, Metadata, Session } from '@/api/types'
import type { SessionAttachMetadataIdentityPolicy } from '@happier-dev/protocol'
import { setupOfflineReconnection } from '@/api/offline/setupOfflineReconnection'
import { createBaseSessionForAttach } from '@/agent/runtime/createBaseSessionForAttach'
import {
  applyStartupMetadataUpdateToSession,
  type SessionModeOverride,
  type ModelOverride,
  type PermissionModeOverride,
} from '@/agent/runtime/startupMetadataUpdate'
import { mergeSessionMetadataForStartup } from '@/agent/runtime/mergeSessionMetadataForStartup'
import { readSessionAttachMetadataIdentityPolicyFromEnv } from '@/agent/runtime/readSessionAttachMetadataIdentityPolicyFromEnv'
import { hasPublishedSessionRuntimeIdentityForAttach } from '@/agent/runtime/identity'
import { normalizeLegacySessionModeMetadataCompat } from '@/agent/runtime/startup/normalizeLegacySessionModeMetadataCompat'
import {
  persistTerminalAttachmentInfoIfNeeded,
  primeAgentStateForUi,
  reportSessionToDaemonIfRunning,
  sendTerminalFallbackMessageIfNeeded,
} from '@/agent/runtime/startupSideEffects'
import {
  clearPendingFirstInputFromEnv,
  readPendingFirstInputFromEnv,
} from '@/daemon/spawn/pendingFirstInput'

export interface InitializeBackendRunSessionOptions {
  api: Pick<ApiClient, 'getOrCreateSession' | 'sessionSyncClient'>
  sessionTag: string
  metadata: Metadata
  state: AgentState
  existingSessionId?: string
  sessionAttachFilePath?: string
  uiLogPrefix: string
  startupMetadataOverrides: {
    permissionModeOverride: PermissionModeOverride
    sessionModeOverride?: SessionModeOverride
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
  configureSessionClient?: (session: ApiSessionClient) => void
  onAttachMetadataSnapshotError?: (error: unknown) => void
  onAttachMetadataSnapshotMissing?: (error: unknown | null) => void
  onAttachMetadataSnapshotReady?: (snapshot: unknown, session: ApiSessionClient) => void | Promise<void>
  startupSideEffectsOrder?: 'report-first' | 'persist-first'
  deferPendingFirstInputCommitUntilRuntimeReady?: boolean
  signal?: AbortSignal
}

export interface InitializeBackendRunSessionResult {
  session: ApiSessionClient
  reconnectionHandle: { cancel: () => void } | null
  reportedSessionId: string | null
  attachedToExistingSession: boolean
  commitPendingFirstInputAfterRuntimeReady?: (() => Promise<void>) | null
}

type DaemonReportMode = 'await' | 'background'

const HANDOFF_ATTACH_METADATA_PUBLISH_WAIT_MS = 5_000
const HANDOFF_ATTACH_METADATA_PUBLISH_MAX_ATTEMPTS = 3

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

function throwIfSignalAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return
  throw signal.reason ?? new Error('Backend run session initialization cancelled')
}

async function waitForAttachMetadataWakeup(
  session: Pick<ApiSessionClient, 'waitForMetadataUpdate'>,
  signal?: AbortSignal,
): Promise<void> {
  throwIfSignalAborted(signal)
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort()
  }, HANDOFF_ATTACH_METADATA_PUBLISH_WAIT_MS)
  timer.unref?.()
  const onAbort = () => {
    controller.abort(signal?.reason)
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    await session.waitForMetadataUpdate(controller.signal)
  } catch {
    // Best effort only; a subsequent retry may still succeed if the connection races in.
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  throwIfSignalAborted(signal)
}

async function applyAttachStartupMetadataUpdateWithRetry(opts: {
  session: Pick<ApiSessionClient, 'getMetadataSnapshot' | 'waitForMetadataUpdate'>
  runtimeMetadata: Metadata
  attachMetadataIdentityPolicy: SessionAttachMetadataIdentityPolicy | null
  applyUpdate: () => Promise<void>
  signal?: AbortSignal
}): Promise<void> {
  const shouldVerifyRuntimeIdentity =
    opts.attachMetadataIdentityPolicy === 'replace_with_runtime_identity'

  for (let attempt = 1; attempt <= HANDOFF_ATTACH_METADATA_PUBLISH_MAX_ATTEMPTS; attempt += 1) {
    throwIfSignalAborted(opts.signal)
    await opts.applyUpdate()
    throwIfSignalAborted(opts.signal)

    if (!shouldVerifyRuntimeIdentity) {
      return
    }

    if (hasPublishedSessionRuntimeIdentityForAttach(opts.session.getMetadataSnapshot(), opts.runtimeMetadata)) {
      return
    }

    if (attempt >= HANDOFF_ATTACH_METADATA_PUBLISH_MAX_ATTEMPTS) {
      return
    }

    throwIfSignalAborted(opts.signal)
    await waitForAttachMetadataWakeup(opts.session, opts.signal)
    throwIfSignalAborted(opts.signal)
  }
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
  const throwIfAborted = (): void => throwIfSignalAborted(opts.signal)
  throwIfAborted()
  const startupSideEffectsOrder = opts.startupSideEffectsOrder ?? 'report-first'
  const pendingFirstInput = readPendingFirstInputFromEnv()
  let pendingFirstInputCommitted = pendingFirstInput === null
  let commitPendingFirstInputAfterRuntimeReady: (() => Promise<void>) | null = null
  const commitPendingFirstInput = async (session: ApiSessionClient): Promise<void> => {
    throwIfAborted()
    if (pendingFirstInputCommitted || pendingFirstInput === null) return
    await session.enqueueSessionUserMessage({
      text: pendingFirstInput.text,
      localId: pendingFirstInput.localId,
      meta: { source: 'ui', sentFrom: 'cli' },
    })
    pendingFirstInputCommitted = true
    clearPendingFirstInputFromEnv()
    throwIfAborted()
  }
  const deferOrCommitPendingFirstInput = async (session: ApiSessionClient): Promise<void> => {
    if (
      !opts.deferPendingFirstInputCommitUntilRuntimeReady
      || pendingFirstInput === null
    ) {
      await commitPendingFirstInput(session)
      return
    }

    let commitPromise: Promise<void> | null = null
    commitPendingFirstInputAfterRuntimeReady = () => {
      commitPromise ??= commitPendingFirstInput(session)
      return commitPromise
    }
  }

  const existingSessionId = normalizeExistingSessionId(opts.existingSessionId)
  const attachMetadataIdentityPolicy =
    opts.attachMetadataIdentityPolicy
    ?? readSessionAttachMetadataIdentityPolicyFromEnv()
    ?? null
  const terminal = opts.metadata.terminal
  const startDaemonReport = (
    sessionId: string,
    metadata: Metadata,
    mode: DaemonReportMode,
    requireDaemonAck: boolean,
  ): Promise<void> => {
    throwIfAborted()
    const reportPromise = reportSessionToDaemonIfRunningFn({
      sessionId,
      metadata,
      ...(requireDaemonAck ? { requireDaemonAck: true } : {}),
    })
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
    requireDaemonAck: boolean,
  ): Promise<void> => {
    if (startupSideEffectsOrder === 'persist-first') {
      throwIfAborted()
      await persistTerminalAttachmentInfoIfNeededFn({ sessionId, terminal })
      throwIfAborted()
      sendTerminalFallbackMessageIfNeededFn({ session: sessionToUse, terminal })
      throwIfAborted()
      await startDaemonReport(sessionId, metadata, daemonReportMode, requireDaemonAck)
      throwIfAborted()
      return
    }

    throwIfAborted()
    await startDaemonReport(sessionId, metadata, daemonReportMode, requireDaemonAck)
    throwIfAborted()
    await persistTerminalAttachmentInfoIfNeededFn({ sessionId, terminal })
    throwIfAborted()
    sendTerminalFallbackMessageIfNeededFn({ session: sessionToUse, terminal })
    throwIfAborted()
  }

  if (existingSessionId) {
    throwIfAborted()
    const baseSession = await createBaseSessionForAttachFn({
      existingSessionId,
      metadata: opts.metadata,
      state: opts.state,
      ...(opts.sessionAttachFilePath ? { sessionAttachFilePath: opts.sessionAttachFilePath } : {}),
    })
    throwIfAborted()
    const session = opts.api.sessionSyncClient(baseSession)
    opts.configureSessionClient?.(session)

    let attachCleanupPromise: Promise<void> | null = null
    const disposeAttachedSession = (): Promise<void> => {
      attachCleanupPromise ??= session.close().catch(() => undefined)
      return attachCleanupPromise
    }
    const onAttachAbort = () => {
      void disposeAttachedSession()
    }
    opts.signal?.addEventListener('abort', onAttachAbort, { once: true })

    try {
      throwIfAborted()

      let snapshot: Metadata | null = null
      let snapshotError: unknown = null
      let daemonReportMetadata = opts.metadata
      try {
        snapshot = await session.ensureMetadataSnapshot({ timeoutMs: 30_000 })
      } catch (error) {
        throwIfAborted()
        snapshotError = error
        opts.onAttachMetadataSnapshotError?.(error)
        throwIfAborted()
      }
      throwIfAborted()

      if (snapshot) {
      const startupNowMs = nowFn()
      daemonReportMetadata = mergeSessionMetadataForStartup({
        current: normalizeLegacySessionModeMetadataCompat(snapshot),
        next: normalizeLegacySessionModeMetadataCompat(opts.metadata),
        nowMs: startupNowMs,
        permissionModeOverride: opts.startupMetadataOverrides.permissionModeOverride,
        sessionModeOverride: opts.startupMetadataOverrides.sessionModeOverride,
        modelOverride: opts.startupMetadataOverrides.modelOverride,
        metadataKeysToUnsetOnAttach: opts.metadataKeysToUnsetOnAttach,
        attachMetadataIdentityPolicy,
        mode: 'attach',
      })
      await applyAttachStartupMetadataUpdateWithRetry({
        session,
        runtimeMetadata: daemonReportMetadata,
        attachMetadataIdentityPolicy,
        signal: opts.signal,
        applyUpdate: async () => {
          await applyStartupMetadataUpdateToSessionFn({
            session,
            next: normalizeLegacySessionModeMetadataCompat(opts.metadata),
            nowMs: startupNowMs,
            permissionModeOverride: opts.startupMetadataOverrides.permissionModeOverride,
            sessionModeOverride: opts.startupMetadataOverrides.sessionModeOverride,
            modelOverride: opts.startupMetadataOverrides.modelOverride,
            metadataKeysToUnsetOnAttach: opts.metadataKeysToUnsetOnAttach,
            attachMetadataIdentityPolicy,
            mode: 'attach',
          })
        },
      })
      throwIfAborted()
      await opts.onAttachMetadataSnapshotReady?.(snapshot, session)
      throwIfAborted()
      } else {
      throwIfAborted()
      opts.onAttachMetadataSnapshotMissing?.(snapshotError)
      throwIfAborted()
      if (attachMetadataIdentityPolicy === 'replace_with_runtime_identity') {
        const startupNowMs = nowFn()
        await applyAttachStartupMetadataUpdateWithRetry({
          session,
          runtimeMetadata: {
            ...opts.metadata,
            lifecycleState: 'running',
          },
          attachMetadataIdentityPolicy,
          signal: opts.signal,
          applyUpdate: async () => {
            await applyStartupMetadataUpdateToSessionFn({
              session,
              next: normalizeLegacySessionModeMetadataCompat(opts.metadata),
              nowMs: startupNowMs,
              permissionModeOverride: opts.startupMetadataOverrides.permissionModeOverride,
              sessionModeOverride: opts.startupMetadataOverrides.sessionModeOverride,
              modelOverride: opts.startupMetadataOverrides.modelOverride,
              metadataKeysToUnsetOnAttach: opts.metadataKeysToUnsetOnAttach,
              attachMetadataIdentityPolicy,
              mode: 'attach',
            })
          },
        })
      }
      }

      throwIfAborted()
      primeAgentStateForUiFn(session, opts.uiLogPrefix)
      await deferOrCommitPendingFirstInput(session)
      throwIfAborted()
      await runStartupSideEffects(session, existingSessionId, daemonReportMetadata, 'background', false)

      return {
        session,
        reconnectionHandle: null,
        reportedSessionId: existingSessionId,
        attachedToExistingSession: true,
        commitPendingFirstInputAfterRuntimeReady,
      }
    } finally {
      opts.signal?.removeEventListener('abort', onAttachAbort)
      if (opts.signal?.aborted) {
        await disposeAttachedSession()
      }
    }
  }

  throwIfAborted()
  const response = await opts.api.getOrCreateSession({
    tag: opts.sessionTag,
    metadata: opts.metadata,
    state: opts.state,
    ...(opts.signal ? { signal: opts.signal } : {}),
  })
  throwIfAborted()

  if (!response && !opts.allowOfflineStub) {
    throw new Error('Failed to create session')
  }

  const reportedSessionId = response ? response.id : null
  let ranStartupSideEffects = false
  const runStartupSideEffectsOnce = async (
    sessionToUse: ApiSessionClient,
    sessionId: string,
    requireDaemonAck = false,
  ): Promise<void> => {
    if (ranStartupSideEffects) return
    ranStartupSideEffects = true
    await runStartupSideEffects(sessionToUse, sessionId, opts.metadata, 'await', requireDaemonAck)
  }

  const { session, reconnectionHandle } = setupOfflineReconnectionFn({
    api: opts.api as ApiClient,
    sessionTag: opts.sessionTag,
    metadata: opts.metadata,
    state: opts.state,
    response: response as Session | null,
    configureSessionClient: opts.configureSessionClient,
    onNotify: opts.offlineNotify,
    onSessionSwap: (newSession) => {
      if (opts.signal?.aborted) {
        void newSession.close().catch(() => undefined)
        return
      }
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
      if (opts.metadata.startedBy === 'daemon') {
        void runStartupSideEffectsOnce(newSession, nextId, true)
          .then(() => commitPendingFirstInput(newSession))
          .catch(() => {})
      } else {
        void commitPendingFirstInput(newSession)
          .then(() => runStartupSideEffectsOnce(newSession, nextId))
          .catch(() => {})
      }
    },
  })

  let acquiredResourceCleanupPromise: Promise<void> | null = null
  const disposeAcquiredResources = (): Promise<void> => {
    acquiredResourceCleanupPromise ??= (async () => {
      try {
        reconnectionHandle?.cancel()
      } catch {
        // Cancellation is best effort; the session close still fences local use.
      }
      await session.close().catch(() => undefined)
    })()
    return acquiredResourceCleanupPromise
  }
  const onAcquiredResourceAbort = () => {
    void disposeAcquiredResources()
  }
  opts.signal?.addEventListener('abort', onAcquiredResourceAbort, { once: true })

  try {
    throwIfAborted()
    primeAgentStateForUiFn(session, opts.uiLogPrefix)
    if (reportedSessionId) {
      if (opts.metadata.startedBy === 'daemon') {
        await runStartupSideEffectsOnce(session, reportedSessionId, true)
        throwIfAborted()
        await deferOrCommitPendingFirstInput(session)
      } else {
        await deferOrCommitPendingFirstInput(session)
        throwIfAborted()
        await runStartupSideEffectsOnce(session, reportedSessionId)
      }
    }

    return {
      session,
      reconnectionHandle,
      reportedSessionId,
      attachedToExistingSession: false,
      commitPendingFirstInputAfterRuntimeReady,
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAcquiredResourceAbort)
    if (opts.signal?.aborted) {
      await disposeAcquiredResources()
    }
  }
}
