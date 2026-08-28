import type { ApiClient } from '@/api/api'
import type { ApiSessionClient } from '@/api/session/sessionClient'
import type { AgentState, Metadata, SessionCreationOutcome } from '@/api/types'
import type { SessionAttachMetadataIdentityPolicy } from '@happier-dev/protocol'
import { isSessionCreationPlacementError } from '@/api/session/sessionCreationPlacementError'
import {
  isSessionCreationCorrespondenceConflictError,
} from '@/api/session/sessionCreationCorrespondenceConflictError'
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
  reportSessionStartupFailureToDaemonIfRunning,
  sendTerminalFallbackMessageIfNeeded,
} from '@/agent/runtime/startupSideEffects'
import { readSessionStartupSpawnNonceFromEnv } from '@/session/runtime/control/sessionControlEnvironment'
import {
  createPendingFirstInputCommitter,
} from '@/daemon/spawn/pendingFirstInput'

export interface InitializeBackendRunSessionOptions {
  api: Pick<ApiClient, 'getOrCreateSession' | 'sessionSyncClient'>
  sessionTag: string
  organizationPlacement?: import('@happier-dev/protocol').SessionOrganizationPlacementV1
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
  onSessionSwap?: (newSession: ApiSessionClient) => void | Promise<void>
  configureSessionClient?: (session: ApiSessionClient) => void
  onAttachMetadataSnapshotError?: (error: unknown) => void
  onAttachMetadataSnapshotMissing?: (error: unknown | null) => void
  onAttachMetadataSnapshotReady?: (snapshot: unknown, session: ApiSessionClient) => void | Promise<void>
  startupSideEffectsOrder?: 'report-first' | 'persist-first'
  deferPendingFirstInputCommitUntilRuntimeReady?: boolean
  requireDaemonAckOnAttach?: boolean
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

export class BackendRunSessionUnavailableError extends Error {
  readonly code = 'backend_run_session_unavailable' as const

  constructor() {
    super('Unable to start the Agent because the Happier server did not create a durable Session. Check the connection and retry.')
    this.name = 'BackendRunSessionUnavailableError'
  }
}

const HANDOFF_ATTACH_METADATA_PUBLISH_WAIT_MS = 5_000
const HANDOFF_ATTACH_METADATA_PUBLISH_MAX_ATTEMPTS = 3

type InitializeBackendRunSessionDeps = {
  createBaseSessionForAttachFn?: typeof createBaseSessionForAttach
  applyStartupMetadataUpdateToSessionFn?: typeof applyStartupMetadataUpdateToSession
  primeAgentStateForUiFn?: typeof primeAgentStateForUi
  reportSessionToDaemonIfRunningFn?: typeof reportSessionToDaemonIfRunning
  reportSessionStartupFailureToDaemonIfRunningFn?: typeof reportSessionStartupFailureToDaemonIfRunning
  persistTerminalAttachmentInfoIfNeededFn?: typeof persistTerminalAttachmentInfoIfNeeded
  sendTerminalFallbackMessageIfNeededFn?: (
    opts: Parameters<typeof sendTerminalFallbackMessageIfNeeded>[0],
  ) => void | Promise<void>
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
  const applyStartupMetadataUpdateToSessionFn = deps.applyStartupMetadataUpdateToSessionFn ?? applyStartupMetadataUpdateToSession
  const primeAgentStateForUiFn = deps.primeAgentStateForUiFn ?? primeAgentStateForUi
  const reportSessionToDaemonIfRunningFn = deps.reportSessionToDaemonIfRunningFn ?? reportSessionToDaemonIfRunning
  const reportSessionStartupFailureToDaemonIfRunningFn =
    deps.reportSessionStartupFailureToDaemonIfRunningFn
    ?? reportSessionStartupFailureToDaemonIfRunning
  const persistTerminalAttachmentInfoIfNeededFn = deps.persistTerminalAttachmentInfoIfNeededFn ?? persistTerminalAttachmentInfoIfNeeded
  const sendTerminalFallbackMessageIfNeededFn = deps.sendTerminalFallbackMessageIfNeededFn ?? sendTerminalFallbackMessageIfNeeded
  const nowFn = deps.nowFn ?? (() => Date.now())
  const throwIfAborted = (): void => throwIfSignalAborted(opts.signal)
  throwIfAborted()
  const startupSideEffectsOrder = opts.startupSideEffectsOrder ?? 'report-first'
  const pendingFirstInputCommitter = createPendingFirstInputCommitter()
  let commitPendingFirstInputAfterRuntimeReady: (() => Promise<void>) | null = null
  const commitPendingFirstInput = async (session: ApiSessionClient): Promise<void> => {
    throwIfAborted()
    await pendingFirstInputCommitter.commit(session)
    throwIfAborted()
  }
  const deferOrCommitPendingFirstInput = async (
    session: ApiSessionClient,
  ): Promise<(() => Promise<void>) | null> => {
    if (
      !opts.deferPendingFirstInputCommitUntilRuntimeReady
      || !pendingFirstInputCommitter.hasPendingInput
    ) {
      await commitPendingFirstInput(session)
      return null
    }

    let commitPromise: Promise<void> | null = null
    return () => {
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
    sessionCreationOutcome?: SessionCreationOutcome,
  ): Promise<void> => {
    throwIfAborted()
    const reportPromise = reportSessionToDaemonIfRunningFn({
      sessionId,
      metadata,
      ...(sessionCreationOutcome ? { sessionCreationOutcome } : {}),
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
    sessionCreationOutcome?: SessionCreationOutcome,
  ): Promise<void> => {
    if (startupSideEffectsOrder === 'persist-first') {
      throwIfAborted()
      await persistTerminalAttachmentInfoIfNeededFn({ sessionId, terminal })
      throwIfAborted()
      await sendTerminalFallbackMessageIfNeededFn({ session: sessionToUse, terminal })
      throwIfAborted()
      await startDaemonReport(
        sessionId,
        metadata,
        daemonReportMode,
        requireDaemonAck,
        sessionCreationOutcome,
      )
      throwIfAborted()
      return
    }

    throwIfAborted()
    await startDaemonReport(
      sessionId,
      metadata,
      daemonReportMode,
      requireDaemonAck,
      sessionCreationOutcome,
    )
    throwIfAborted()
    await persistTerminalAttachmentInfoIfNeededFn({ sessionId, terminal })
    throwIfAborted()
    await sendTerminalFallbackMessageIfNeededFn({ session: sessionToUse, terminal })
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
    let attachCompleted = false

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
      commitPendingFirstInputAfterRuntimeReady =
        await deferOrCommitPendingFirstInput(session)
      throwIfAborted()
      const requireDaemonAckOnAttach =
        opts.requireDaemonAckOnAttach === true
      if (commitPendingFirstInputAfterRuntimeReady) {
        const commit = commitPendingFirstInputAfterRuntimeReady
        commitPendingFirstInputAfterRuntimeReady = async () => {
          await commit()
          throwIfAborted()
          await runStartupSideEffects(
            session,
            existingSessionId,
            daemonReportMetadata,
            requireDaemonAckOnAttach ? 'await' : 'background',
            requireDaemonAckOnAttach,
          )
        }
      } else {
        await runStartupSideEffects(
          session,
          existingSessionId,
          daemonReportMetadata,
          requireDaemonAckOnAttach ? 'await' : 'background',
          requireDaemonAckOnAttach,
        )
      }

      attachCompleted = true
      return {
        session,
        reconnectionHandle: null,
        reportedSessionId: existingSessionId,
        attachedToExistingSession: true,
        commitPendingFirstInputAfterRuntimeReady,
      }
    } finally {
      opts.signal?.removeEventListener('abort', onAttachAbort)
      if (!attachCompleted) {
        await disposeAttachedSession()
      }
    }
  }

  throwIfAborted()
  let response: Awaited<ReturnType<ApiClient['getOrCreateSession']>>
  try {
    response = await opts.api.getOrCreateSession({
      tag: opts.sessionTag,
      metadata: opts.metadata,
      state: opts.state,
      ...(opts.organizationPlacement
        ? { organizationPlacement: opts.organizationPlacement }
        : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  } catch (error) {
    const spawnNonce = readSessionStartupSpawnNonceFromEnv()
    const errorDetail = isSessionCreationPlacementError(error)
      ? {
          kind: 'session_creation_organization_invalid' as const,
          code: 'organization_invalid' as const,
        }
      : isSessionCreationCorrespondenceConflictError(error)
        ? {
            kind: 'session_creation_correspondence_conflict' as const,
            code: 'creation_conflict' as const,
          }
        : null
    if (
      !opts.signal?.aborted
      && opts.metadata.startedBy === 'daemon'
      && spawnNonce
      && errorDetail
    ) {
      try {
        await reportSessionStartupFailureToDaemonIfRunningFn({
          spawnNonce,
          errorDetail,
        })
      } catch {
        // An injected report seam must not mask the original exact server
        // refusal or cause a second error owner.
      }
    }
    throw error
  }
  throwIfAborted()

  if (!response) {
    throw new BackendRunSessionUnavailableError()
  }

  const reportedSessionId = response.id
  let ranStartupSideEffects = false
  const runStartupSideEffectsOnce = async (
    sessionToUse: ApiSessionClient,
    sessionId: string,
    requireDaemonAck = false,
  ): Promise<void> => {
    if (ranStartupSideEffects) return
    ranStartupSideEffects = true
    await runStartupSideEffects(
      sessionToUse,
      sessionId,
      opts.metadata,
      'await',
      requireDaemonAck,
      response.sessionCreationOutcome,
    )
  }

  const session = opts.api.sessionSyncClient(response)
  opts.configureSessionClient?.(session)

  let acquiredResourceCleanupPromise: Promise<void> | null = null
  const disposeAcquiredResources = (): Promise<void> => {
    acquiredResourceCleanupPromise ??= (async () => {
      await session.close().catch(() => undefined)
    })()
    return acquiredResourceCleanupPromise
  }
  const onAcquiredResourceAbort = () => {
    void disposeAcquiredResources()
  }
  opts.signal?.addEventListener('abort', onAcquiredResourceAbort, { once: true })
  let initializationCompleted = false

  try {
    throwIfAborted()
    primeAgentStateForUiFn(session, opts.uiLogPrefix)
    if (reportedSessionId) {
      commitPendingFirstInputAfterRuntimeReady =
        await deferOrCommitPendingFirstInput(session)
      throwIfAborted()
      if (commitPendingFirstInputAfterRuntimeReady) {
        const commit = commitPendingFirstInputAfterRuntimeReady
        commitPendingFirstInputAfterRuntimeReady = async () => {
          await commit()
          throwIfAborted()
          await runStartupSideEffectsOnce(
            session,
            reportedSessionId,
            opts.metadata.startedBy === 'daemon',
          )
        }
      } else {
        await runStartupSideEffectsOnce(
          session,
          reportedSessionId,
          opts.metadata.startedBy === 'daemon',
        )
      }
    }

    initializationCompleted = true
    return {
      session,
      reconnectionHandle: null,
      reportedSessionId,
      attachedToExistingSession: false,
      commitPendingFirstInputAfterRuntimeReady,
    }
  } finally {
    opts.signal?.removeEventListener('abort', onAcquiredResourceAbort)
    if (!initializationCompleted) {
      await disposeAcquiredResources()
    }
  }
}
