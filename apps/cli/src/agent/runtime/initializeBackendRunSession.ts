import type { ApiClient } from '@/api/api'
import { logger } from '@/ui/logger'
import type { ApiSessionClient } from '@/api/session/sessionClient'
import type { AgentState, Metadata, SessionCreationOutcome } from '@/api/types'
import type { SessionAttachMetadataIdentityPolicy } from '@happier-dev/protocol'
import { readSessionCreationTerminalSpawnErrorDetail } from '@/api/session/sessionCreationTerminalSpawnErrorDetail'
import { createBaseSessionForAttach } from '@/agent/runtime/createBaseSessionForAttach'
import {
  applyStartupMetadataUpdateToSession,
  prepareSessionStackSkillMigration,
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
  DaemonSessionReadinessError,
} from '@/agent/runtime/startupSideEffects'
import { classifyPrimarySessionRuntimeIssue } from '@/agent/runtime/session/errors/classifyPrimarySessionRuntimeIssue'
import { retireSessionRunnerMetadata } from '@/session/metadata/sessionRunnerMetadata'
import { createSessionTurnLifecycle } from '@/agent/runtime/session/turn/lifecycle'
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents'
import { readSessionStartupSpawnNonceFromEnv } from '@/session/runtime/control/sessionControlEnvironment'
import {
  createPendingFirstInputCommitter,
} from '@/daemon/spawn/pendingFirstInput'
import { bindHerdrAgentIfNeeded } from '@/integrations/herdr/bindManagedSession'
import { readSessionCreateOriginFromEnv } from '@/session/shared/sessionCreateOrigin'
import { readSessionCreateManagerFromEnv } from '@/session/shared/sessionCreateManager'
import { readSessionCreateRolesFromEnv } from '@/session/shared/sessionCreateRoles'
import { readSessionCreateAuthoringOriginFromEnv } from '@/session/shared/sessionCreateAuthoringOrigin'
import { claimSessionRunnerOwnership, readSessionRunnerLockStatus } from '@/daemon/sessionRunnerLock'
import { configuration } from '@/configuration'
import { readTerminalHostAttachmentState, terminalMetadataMatchesHostHandle } from '@/terminal/attachment/terminalAttachmentInfo'
import { buildActiveTerminalHostHandleFromMetadata } from '@/terminal/runtime/terminalMetadata'
import { PluginTerminalHostError } from '@/plugins/runtime/context/errors'
import { readSessionCapabilitySelectionFromMetadataV1 } from '@happier-dev/protocol/reach/sessionCapabilityMetadataV1'

export interface InitializeBackendRunSessionOptions {
  credentials?: import('@/persistence').StoredCredentials
  api: Pick<ApiClient, 'getOrCreateSession' | 'sessionSyncClient'>
  sessionTag: string
  organizationPlacement?: import('@happier-dev/protocol').SessionOrganizationPlacementV1
  initialAccess?: import('@happier-dev/protocol').SessionInitialAccessDraftV1
  manager?: import('@happier-dev/protocol').SessionManagerV1
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
  /** Physical terminal startup belongs to the selected runtime rather than this controller. */
  terminalHostOwner?: 'startup' | 'runtime'
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
  const startupStartedAt = performance.now()
  let startupPhaseStartedAt = startupStartedAt
  const recordStartupPhase = (phase: 'entered' | 'birth_skills' | 'session_create' | 'runner_ownership' | 'session_client' | 'startup_side_effects'): void => {
    const now = performance.now()
    try {
      logger.infoFile('[session-construction] Startup phase', { phase,
        durationMs: Math.round(now - startupPhaseStartedAt), elapsedMs: Math.round(now - startupStartedAt),
        processUptimeMs: Math.round(process.uptime() * 1000) })
    } catch { /* Diagnostics cannot change Session custody. */ }
    startupPhaseStartedAt = now
  }
  recordStartupPhase('entered')
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
  let initializationCompleted = false
  const terminalAgentBindingRequiresDaemonAttachment = terminal?.mode === 'herdr'
    && (!terminal.herdr?.sessionName || !terminal.herdr.socketPath || !terminal.herdr.terminalId)
  const startDaemonReport = async (
    session: ApiSessionClient,
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
    try {
      await reportPromise
    } catch (error) {
      if (error instanceof DaemonSessionReadinessError && !initializationCompleted) {
        // This Session exists before the host construction lifecycle takes
        // custody. Publish while its real client is still available; the
        // outer initialization finally owns transport disposal.
        try {
          // The report can outlive a replacement runner. Reuse the required
          // snapshot reader before publishing a failure into that Session.
          await session.refreshSessionSnapshotFromServerRequired({ reason: 'startup-drain', afterCurrentRead: true })
          const matchesReportedRunner = (current: Metadata | null): current is Metadata =>
            current !== null && !preservesRetainedTerminal && metadata.hostPid === process.pid
              && current.hostPid === metadata.hostPid
              && current.hostProcessStartTimeMs === metadata.hostProcessStartTimeMs
          if (matchesReportedRunner(session.getMetadataSnapshot())) {
            const agentId = resolveAgentIdFromSessionMetadata(metadata) ?? undefined
            await createSessionTurnLifecycle({ session, agentId }).failTurn({ allocateWhenIdle: true,
              issue: classifyPrimarySessionRuntimeIssue({ cause: 'session_error', error, provider: agentId }),
            })
            // A failed report may never have given the daemon this Session id.
            // Keep startup custody until publication, using the same runner
            // tuple projection as the daemon's observed-exit owner.
            await session.updateMetadata(current => !matchesReportedRunner(current) ? current
              : retireSessionRunnerMetadata(current, { pid: process.pid,
                startTimeMs: metadata.hostProcessStartTimeMs }))
          }
        } catch {
          logger.debug('[START] Failed to settle daemon readiness failure')
        }
      }
      throw error
    }
  }
  const runStartupSideEffects = async (
    sessionToUse: ApiSessionClient,
    sessionId: string,
    metadata: Metadata,
    daemonReportMode: DaemonReportMode,
    requireDaemonAck: boolean,
    sessionCreationOutcome?: SessionCreationOutcome,
  ): Promise<void> => {
    if (preservesRetainedTerminal || opts.terminalHostOwner === 'runtime') {
      // A headless controller does not own the runtime's physical terminal.
      // Preserve retained attachment records until the actual host adopts them.
      await startDaemonReport(sessionToUse, sessionId, metadata, daemonReportMode, requireDaemonAck, sessionCreationOutcome)
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
        sessionToUse,
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
      sessionToUse,
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
        const preparedStackSkills = opts.credentials ? await prepareSessionStackSkillMigration(snapshot,
          { credentials: opts.credentials, signal: opts.signal }) : undefined
        const stackSkillMigration = preparedStackSkills?.status === 'ready' ? preparedStackSkills.migration : undefined
        const startupSelectionMetadata = stackSkillMigration ? mergeSessionMetadataForStartup({
          current: snapshot, next: startupMetadata, nowMs: startupNowMs, mode: 'attach', stackSkillMigration,
          appliedCapabilitySelection: 'preserved_process',
        }) : snapshot
        const appliedCapabilitySelection = preservesRetainedTerminal ? 'preserved_process' as const
          : readSessionCapabilitySelectionFromMetadataV1(startupSelectionMetadata)
        daemonReportMetadata = mergeSessionMetadataForStartup({
          current: normalizeLegacySessionModeMetadataCompat(snapshot),
          next: normalizeLegacySessionModeMetadataCompat(startupMetadata),
          nowMs: startupNowMs,
          permissionModeOverride: opts.startupMetadataOverrides.permissionModeOverride,
          sessionModeOverride: opts.startupMetadataOverrides.sessionModeOverride,
          modelOverride: opts.startupMetadataOverrides.modelOverride,
          capturedTeamCredentialBinding: baseSession.acceptedTeamCredentialBinding,
          acceptedTeamCredentialBinding: baseSession.acceptedTeamCredentialBinding,
          metadataKeysToUnsetOnAttach: opts.metadataKeysToUnsetOnAttach,
          attachMetadataIdentityPolicy,
          appliedCapabilitySelection,
          stackSkillMigration,
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
              capturedTeamCredentialBinding: baseSession.acceptedTeamCredentialBinding,
              metadataKeysToUnsetOnAttach: opts.metadataKeysToUnsetOnAttach,
              attachMetadataIdentityPolicy,
              appliedCapabilitySelection,
              stackSkillMigration,
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
                capturedTeamCredentialBinding: baseSession.acceptedTeamCredentialBinding,
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

      initializationCompleted = true
      return {
        session,
        reconnectionHandle: null,
        reportedSessionId: existingSessionId,
        attachedToExistingSession: true,
        commitPendingFirstInputAfterRuntimeReady,
      }
    } finally {
      opts.signal?.removeEventListener('abort', onAttachAbort)
      if (!initializationCompleted) {
        await disposeAttachedSession()
      }
    }
  }

  throwIfAborted()
  const preparedBirthSkills = opts.credentials ? await prepareSessionStackSkillMigration(opts.metadata,
    { credentials: opts.credentials, signal: opts.signal }) : undefined
  recordStartupPhase('birth_skills')
  const birthSkillMigration = preparedBirthSkills?.status === 'ready' ? preparedBirthSkills.migration : undefined
  const preparedBirthMetadata = birthSkillMigration ? mergeSessionMetadataForStartup({
    current: opts.metadata, next: opts.metadata, nowMs: nowFn(), mode: 'start', stackSkillMigration: birthSkillMigration,
  }) : opts.metadata
  const authoringOrigin = readSessionCreateAuthoringOriginFromEnv()
  const birthMetadata = authoringOrigin === undefined ? preparedBirthMetadata : {
    ...preparedBirthMetadata, work: { ...preparedBirthMetadata.work, authoringOriginV1: authoringOrigin },
  }
  let response: Awaited<ReturnType<ApiClient['getOrCreateSession']>>
  try {
    const manager = opts.manager ?? readSessionCreateManagerFromEnv();
    const initialSessionRolesV1 = readSessionCreateRolesFromEnv();
    response = await opts.api.getOrCreateSession({
      ...readSessionCreateOriginFromEnv(),
      ...(manager !== undefined ? { manager } : {}),
      tag: opts.sessionTag,
      metadata: initialSessionRolesV1
        ? { ...birthMetadata, work: { ...birthMetadata.work, sessionRolesV1: initialSessionRolesV1 } }
        : birthMetadata,
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
  recordStartupPhase('session_create')

  const reportedSessionId = response.id
  await claimSessionRunnerOwnership(reportedSessionId)
  throwIfAborted()
  recordStartupPhase('runner_ownership')
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
      birthMetadata,
      'await',
      requireDaemonAck,
      response.sessionCreationOutcome,
    )
  }

  const session = opts.api.sessionSyncClient(response)
  opts.configureSessionClient?.(session)
  recordStartupPhase('session_client')

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

    recordStartupPhase('startup_side_effects')
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
