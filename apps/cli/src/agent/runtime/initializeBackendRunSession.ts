import type { ApiClient } from '@/api/api'
import type { ApiSessionClient } from '@/api/session/sessionClient'
import type { AgentState, Metadata, SessionCreationOutcome } from '@/api/types'
import type { SessionAttachMetadataIdentityPolicy } from '@happier-dev/protocol'
import { readSessionCreationTerminalSpawnErrorDetail } from '@/api/session/sessionCreationTerminalSpawnErrorDetail'
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
  reportSessionToDaemonIfRunning,
  reportSessionStartupFailureToDaemonIfRunning,
  sendTerminalFallbackMessageIfNeeded,
} from '@/agent/runtime/startupSideEffects'
import { readSessionStartupSpawnNonceFromEnv } from '@/session/runtime/control/sessionControlEnvironment'
import {
  createPendingFirstInputCommitter,
} from '@/daemon/spawn/pendingFirstInput'
import { bindHerdrAgentIfNeeded } from '@/integrations/herdr/bindManagedSession'
import { readSessionCreateOriginFromEnv } from '@/session/shared/sessionCreateOrigin'
import { readSessionCreateReportsToFromEnv } from '@/session/shared/sessionCreateReportsTo'
import { readSessionCreateRolesFromEnv } from '@/session/shared/sessionCreateRoles'
import { claimSessionRunnerOwnership, readSessionRunnerLockStatus } from '@/daemon/sessionRunnerLock'
import { configuration } from '@/configuration'
import { readTerminalHostAttachmentState, terminalMetadataMatchesHostHandle } from '@/terminal/attachment/terminalAttachmentInfo'
import { buildActiveTerminalHostHandleFromMetadata } from '@/terminal/runtime/terminalMetadata'
import { PluginTerminalHostError } from '@/plugins/runtime/context/errors'

export interface InitializeBackendRunSessionOptions {
  api: Pick<ApiClient, 'getOrCreateSession' | 'sessionSyncClient'>
  sessionTag: string
  organizationPlacement?: import('@happier-dev/protocol').SessionOrganizationPlacementV1
  initialAccess?: import('@happier-dev/protocol').SessionInitialAccessDraftV1
  reportsTo?: import('@happier-dev/protocol').SessionReportsToV1
  primaryTeamId?: string | null
  teamCredentialBindings?: import('@happier-dev/protocol/teams').SessionTeamCredentialBindingIntentListV1
  metadata: Metadata
  state: AgentState
  existingSessionId?: string
  sessionAttachFilePath?: string
  sessionAttachSecret?: import('@/agent/runtime/sessionAttach').SessionAttachSecret
  sessionClientOptions?: Parameters<ApiClient['sessionSyncClient']>[1]
  uiLogPrefix: string
  /** Present only when this runner's own terminal represents the agent session. */
  terminalAgentLabel?: string
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
  /** Selected runtime permits exact retained-owned-host continuation, not fresh placement. */
  retainedTerminalRecovery?: 'adopt'
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
  const allowsRetainedHeadlessContinuation = opts.retainedTerminalRecovery === 'adopt'
    && opts.metadata.startedBy === 'daemon' && terminal?.mode === 'plain'
  let preservesRetainedTerminal = false
  const terminalAgentBindingRequiresDaemonAttachment = terminal?.mode === 'herdr'
    && (!terminal.herdr?.sessionName || !terminal.herdr.socketPath || !terminal.herdr.terminalId)
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
    if (preservesRetainedTerminal) {
      // The headless controller is not a new physical placement. Leave the
      // exact current/predecessor record untouched until actual host adoption.
      await startDaemonReport(sessionId, metadata, daemonReportMode, requireDaemonAck, sessionCreationOutcome)
      return
    }
    const bindTerminalAgent = async () => {
      if (!opts.terminalAgentLabel) return
      await bindHerdrAgentIfNeeded({
        session: sessionToUse,
        sessionId,
        agent: opts.terminalAgentLabel,
        terminal,
      })
    }
    if (startupSideEffectsOrder === 'persist-first') {
      throwIfAborted()
      await persistTerminalAttachmentInfoIfNeededFn({ sessionId, terminal, startedBy: opts.metadata.startedBy })
      throwIfAborted()
      if (!terminalAgentBindingRequiresDaemonAttachment) await bindTerminalAgent()
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
      if (terminalAgentBindingRequiresDaemonAttachment) await bindTerminalAgent()
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
    await persistTerminalAttachmentInfoIfNeededFn({ sessionId, terminal, startedBy: opts.metadata.startedBy })
    throwIfAborted()
    await bindTerminalAgent()
    throwIfAborted()
    await sendTerminalFallbackMessageIfNeededFn({ session: sessionToUse, terminal })
    throwIfAborted()
  }

  if (existingSessionId) {
    await claimSessionRunnerOwnership(existingSessionId)
    throwIfAborted()
    const baseSession = await createBaseSessionForAttachFn({
      existingSessionId,
      metadata: opts.metadata,
      state: opts.state,
      ...(opts.sessionAttachFilePath ? { sessionAttachFilePath: opts.sessionAttachFilePath } : {}),
      ...(opts.sessionAttachSecret ? { sessionAttachSecret: opts.sessionAttachSecret } : {}),
    })
    throwIfAborted()
    const session = opts.api.sessionSyncClient(baseSession, opts.sessionClientOptions)
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
        const startupMetadata = { ...opts.metadata }
        if (allowsRetainedHeadlessContinuation) {
          const attachment = await readTerminalHostAttachmentState({ happyHomeDir: configuration.happyHomeDir, sessionId: existingSessionId })
          const retainedHandle = snapshot.terminal ? buildActiveTerminalHostHandleFromMetadata(snapshot.terminal) : null
          if (snapshot.terminal?.controlServiceabilityV1?.retired !== true
            && (retainedHandle || attachment.status === 'unreadable'
              || (attachment.status === 'present' && attachment.info.version === 2))) {
            const ownership = await readSessionRunnerLockStatus({ happyHomeDir: configuration.happyHomeDir, sessionId: existingSessionId })
            preservesRetainedTerminal = attachment.status === 'present' && attachment.info.version === 2
              && ownership.ok && ownership.lock.pid === process.pid
              && snapshot.terminal !== undefined
              && snapshot.terminal.controlServiceabilityV1?.attachmentId === attachment.info.attachmentId
              && terminalMetadataMatchesHostHandle(snapshot.terminal, attachment.info.handle)
            if (!preservesRetainedTerminal && !(attachment.status === 'present' && attachment.info.version === 3)) {
              throw new PluginTerminalHostError('PLUGIN_TERMINAL_HOST_UNAVAILABLE',
                'Retained terminal-host startup could not confirm the current attachment and runner custody')
            }
          }
          if (preservesRetainedTerminal) delete startupMetadata.terminal
        }
        const startupNowMs = nowFn()
        daemonReportMetadata = mergeSessionMetadataForStartup({
          current: normalizeLegacySessionModeMetadataCompat(snapshot),
          next: normalizeLegacySessionModeMetadataCompat(startupMetadata),
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
              next: normalizeLegacySessionModeMetadataCompat(startupMetadata),
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
        if (allowsRetainedHeadlessContinuation) {
          const attachment = await readTerminalHostAttachmentState({ happyHomeDir: configuration.happyHomeDir, sessionId: existingSessionId })
          if (attachment.status === 'unreadable' || (attachment.status === 'present' && attachment.info.version === 2)) {
            throw new PluginTerminalHostError('PLUGIN_TERMINAL_HOST_UNAVAILABLE',
              'Retained terminal-host startup requires the current Session metadata snapshot')
          }
        }
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
    const reportsTo = opts.reportsTo ?? readSessionCreateReportsToFromEnv();
    const initialSessionRolesV1 = readSessionCreateRolesFromEnv();
    response = await opts.api.getOrCreateSession({
      ...readSessionCreateOriginFromEnv(),
      ...(reportsTo !== undefined ? { reportsTo } : {}),
      tag: opts.sessionTag,
      metadata: initialSessionRolesV1
        ? { ...opts.metadata, work: { ...opts.metadata.work, sessionRolesV1: initialSessionRolesV1 } }
        : opts.metadata,
      state: opts.state,
      ...(opts.initialAccess !== undefined ? { initialAccess: opts.initialAccess } : {}),
      ...(opts.primaryTeamId !== undefined ? { primaryTeamId: opts.primaryTeamId } : {}),
      ...(opts.teamCredentialBindings !== undefined ? { teamCredentialBindings: opts.teamCredentialBindings } : {}),
      ...(opts.organizationPlacement
        ? { organizationPlacement: opts.organizationPlacement }
        : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
  } catch (error) {
    const spawnNonce = readSessionStartupSpawnNonceFromEnv()
    const errorDetail = readSessionCreationTerminalSpawnErrorDetail(error)
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
  await claimSessionRunnerOwnership(reportedSessionId)
  throwIfAborted()
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
