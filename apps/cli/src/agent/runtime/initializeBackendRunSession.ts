import type { ApiClient } from '@/api/api'
import type {
  ApiSessionClient,
  SessionRuntimeActivityClientConfig,
} from '@/api/session/sessionClient'
import type { AgentState, Metadata, Session } from '@/api/types'
import {
  type SessionAttachMetadataIdentityPolicy,
} from '@happier-dev/protocol'
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
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers'
import { createSessionRuntimeActivity } from '@/session/runtimeActivity/createSessionRuntimeActivity'
import type {
  RuntimeActivityApplicability,
  SessionRuntimeActivity,
  SessionRuntimeActivityContributionHandle,
  SessionRuntimeActivitySnapshotPublisher,
} from '@/session/runtimeActivity/types'
import {
  persistTerminalAttachmentInfoIfNeeded,
  primeAgentStateForUi,
  reportSessionToDaemonIfRunning,
  sendTerminalFallbackMessageIfNeeded,
} from '@/agent/runtime/startupSideEffects'
import {
  createPendingFirstInputCommitter,
} from '@/daemon/spawn/pendingFirstInput'

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
  configureSessionClient?: (session: ApiSessionClient) => void
  onAttachMetadataSnapshotError?: (error: unknown) => void
  onAttachMetadataSnapshotMissing?: (error: unknown | null) => void
  onAttachMetadataSnapshotReady?: (snapshot: unknown, session: ApiSessionClient) => void | Promise<void>
  onDaemonSessionReported?: (opts: { sessionId: string }) => void | Promise<void>
  startupSideEffectsOrder?: 'report-first' | 'persist-first'
  /**
   * Providers whose runtime controls are constructed from the attached session can defer daemon
   * registration until those controls exist. The initializer starts the report in the background
   * so provider construction is never blocked on a daemon reconciliation that needs the provider.
   */
  waitForDaemonReportReadiness?: () => Promise<void>
  /** Participating provider leaves declare their complete Runtime Activity contribution here. */
  runtimeActivityPreparation?: BackendRunRuntimeActivityPreparation
  /**
   * Adopt an already configured backend-run Activity lifecycle. Fast-start callers use this to
   * make sealed contributor handles available before concurrent session initialization begins.
   * The common initializer still owns attachment, session-swap rebinding, failure cleanup, and
   * the disposal callback returned to the caller.
   */
  runtimeActivityLifecycle?: BackendRunRuntimeActivityLifecycle
  /** Keep daemon-carried first input durable until the provider installs its input consumer. */
  deferPendingFirstInputCommitUntilRuntimeReady?: boolean
}

export interface InitializeBackendRunSessionResult {
  session: ApiSessionClient
  reconnectionHandle: { cancel: () => void } | null
  reportedSessionId: string | null
  attachedToExistingSession: boolean
  disposeRuntimeActivity?: () => Promise<void>
  commitPendingFirstInputAfterRuntimeReady?: (() => Promise<void>) | null
}

type DaemonReportMode = 'await' | 'background'

type InitializeBackendRunSessionDeps = {
  createBaseSessionForAttachFn?: typeof createBaseSessionForAttach
  setupOfflineReconnectionFn?: typeof setupOfflineReconnection
  applyStartupMetadataUpdateToSessionFn?: typeof applyStartupMetadataUpdateToSession
  primeAgentStateForUiFn?: typeof primeAgentStateForUi
  reportSessionToDaemonIfRunningFn?: (
    ...args: Parameters<typeof reportSessionToDaemonIfRunning>
  ) => Promise<unknown>
  persistTerminalAttachmentInfoIfNeededFn?: typeof persistTerminalAttachmentInfoIfNeeded
  sendTerminalFallbackMessageIfNeededFn?: typeof sendTerminalFallbackMessageIfNeeded
  nowFn?: () => number
  createSessionRuntimeActivityFn?: typeof createSessionRuntimeActivity
}

export type BackendRunRuntimeActivityPreparation = Readonly<{
  runtimeActivityApplicability: RuntimeActivityApplicability
  configureAgentRuntime?(
    contributionHandle: SessionRuntimeActivityContributionHandle,
  ): void | Promise<void>
  resolvePublisher(session: ApiSessionClient): SessionRuntimeActivitySnapshotPublisher | null
}>

export type BackendRunRuntimeActivityLifecycle = Readonly<{
  clientConfig(): SessionRuntimeActivityClientConfig
  attachSession(session: ApiSessionClient): Promise<void>
  dispose(): Promise<void>
}>

export async function createBackendRunRuntimeActivityLifecycle(
  preparation: BackendRunRuntimeActivityPreparation | undefined,
  createActivity: typeof createSessionRuntimeActivity = createSessionRuntimeActivity,
): Promise<BackendRunRuntimeActivityLifecycle> {
  let currentActivity: SessionRuntimeActivity | null = null
  let disposed = false
  let transitionTail = Promise.resolve()
  let executionRunContributionHandle: SessionRuntimeActivityClientConfig['executionRunContributionHandle'] | null = null
  const runtimeActivityApplicability = preparation?.runtimeActivityApplicability ?? 'not_applicable'

  const createConfiguredActivity = async (): Promise<SessionRuntimeActivity> => {
    const activity = createActivity(runtimeActivityApplicability)
    try {
      executionRunContributionHandle = activity.executionRunsContributionHandle
      await executionRunContributionHandle.report(
        { state: 'idle', activeCount: 0 },
        'execution-run-startup-empty',
      )
      const agentRuntimeContributionHandle = activity.agentRuntimeContributionHandle
      if (runtimeActivityApplicability === 'supported') {
        if (!agentRuntimeContributionHandle || !preparation?.configureAgentRuntime) {
          throw new Error('Supported Runtime Activity requires exactly one configured agent-runtime producer')
        }
        await preparation.configureAgentRuntime(agentRuntimeContributionHandle)
      } else if (preparation?.configureAgentRuntime) {
        throw new Error(
          `${runtimeActivityApplicability} Runtime Activity cannot configure an agent-runtime producer`,
        )
      }
      return activity
    } catch (error) {
      await activity.dispose().catch(() => {})
      throw error
    }
  }

  currentActivity = await createConfiguredActivity()

  const enqueueTransition = (operation: () => Promise<void>): Promise<void> => {
    const result = transitionTail.then(operation)
    transitionTail = result.catch(() => {})
    return result
  }

  return {
    clientConfig: () => {
      if (!executionRunContributionHandle) {
        throw new Error('Session runtime Activity execution-run contributor is unavailable')
      }
      return { executionRunContributionHandle }
    },
    attachSession: (session) => enqueueTransition(async () => {
      if (disposed || currentActivity === null) {
        throw new Error('Prepared session runtime activity lifecycle is disposed')
      }

      const publisher = preparation?.resolvePublisher(session)
        ?? session.getRuntimeActivitySnapshotPublisher?.()
        ?? null
      if (publisher !== null) {
        await currentActivity.bindPublisher(publisher)
      }
    }),
    dispose: () => enqueueTransition(async () => {
      if (disposed) return
      disposed = true
      const activity = currentActivity
      currentActivity = null
      if (activity !== null) {
        await activity.dispose()
      }
    }),
  }
}

function normalizeExistingSessionId(existingSessionId: string | undefined): string {
  return readNonBlankOpaqueIdentifier(existingSessionId) ?? ''
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
  if (opts.runtimeActivityLifecycle && opts.runtimeActivityPreparation) {
    await opts.runtimeActivityLifecycle.dispose().catch(() => {})
    throw new Error('Provide either a prepared runtime Activity lifecycle or contributor preparation, not both')
  }
  const preparedRuntimeActivity = opts.runtimeActivityLifecycle
    ?? await createBackendRunRuntimeActivityLifecycle(
      opts.runtimeActivityPreparation,
      deps.createSessionRuntimeActivityFn ?? createSessionRuntimeActivity,
    )
  const startupSideEffectsOrder = opts.startupSideEffectsOrder ?? 'report-first'
  const pendingFirstInputCommitter = createPendingFirstInputCommitter()
  let commitPendingFirstInputAfterRuntimeReady: (() => Promise<void>) | null = null
  const deferOrCommitPendingFirstInput = async (session: ApiSessionClient): Promise<void> => {
    if (
      !opts.deferPendingFirstInputCommitUntilRuntimeReady
      || !pendingFirstInputCommitter.hasPendingInput
    ) {
      await pendingFirstInputCommitter.commit(session)
      return
    }

    let commitPromise: Promise<void> | null = null
    commitPendingFirstInputAfterRuntimeReady = () => {
      commitPromise ??= pendingFirstInputCommitter.commit(session)
      return commitPromise
    }
  }

  try {

  const existingSessionId = normalizeExistingSessionId(opts.existingSessionId)
  const attachMetadataIdentityPolicy =
    opts.attachMetadataIdentityPolicy
    ?? readSessionAttachMetadataIdentityPolicyFromEnv()
    ?? null
  const terminal = opts.metadata.terminal
  const startDaemonReport = async (sessionId: string, metadata: Metadata, mode: DaemonReportMode): Promise<void> => {
    const reportPromise = (async () => {
      await opts.waitForDaemonReportReadiness?.()
      await reportSessionToDaemonIfRunningFn(
        { sessionId, metadata },
        opts.onDaemonSessionReported
          ? {
              onReported: async () => {
                await opts.onDaemonSessionReported?.({ sessionId })
              },
            }
          : undefined,
      )
    })()
    if (mode === 'background') {
      void reportPromise.catch(() => {})
      return
    }
    await reportPromise
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
    const session = opts.api.sessionSyncClient(
      baseSession,
      preparedRuntimeActivity.clientConfig(),
    )
    await preparedRuntimeActivity.attachSession(session)
    opts.configureSessionClient?.(session)

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
    await deferOrCommitPendingFirstInput(session)
    await runStartupSideEffects(session, existingSessionId, daemonReportMetadata, 'background')

    return {
      session,
      reconnectionHandle: null,
      reportedSessionId: existingSessionId,
      attachedToExistingSession: true,
      disposeRuntimeActivity: preparedRuntimeActivity?.dispose,
      commitPendingFirstInputAfterRuntimeReady,
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
    await runStartupSideEffects(
      sessionToUse,
      sessionId,
      opts.metadata,
      opts.waitForDaemonReportReadiness ? 'background' : 'await',
    )
  }

  const { session, reconnectionHandle } = setupOfflineReconnectionFn({
    api: opts.api as ApiClient,
    sessionTag: opts.sessionTag,
    metadata: opts.metadata,
    state: opts.state,
    response: response as Session | null,
    runtimeActivity: preparedRuntimeActivity.clientConfig(),
    configureSessionClient: opts.configureSessionClient,
    onNotify: opts.offlineNotify,
    onSessionSwap: async (newSession) => {
      await preparedRuntimeActivity.attachSession(newSession)
      if (opts.onSessionSwap) {
        try {
          await Promise.resolve(opts.onSessionSwap(newSession)).catch(() => {})
        } catch {
          // Swallow hook failures; reconnection should continue.
        }
      }

      // If startup began offline (no session id yet), rerun UI priming and startup side effects once the
      // real session arrives. Do not do this for normal online starts (reportedSessionId is set).
      if (reportedSessionId) return
      if (ranStartupSideEffects) return
      const nextId = readNonBlankOpaqueIdentifier((newSession as any)?.sessionId) ?? ''
      if (!nextId || nextId.startsWith('offline-')) return

      primeAgentStateForUiFn(newSession, opts.uiLogPrefix)
      void pendingFirstInputCommitter.commit(newSession)
        .then(() => runStartupSideEffectsOnce(newSession, nextId))
        .catch(() => {})
    },
  })

  await preparedRuntimeActivity.attachSession(session)

  primeAgentStateForUiFn(session, opts.uiLogPrefix)
  if (reportedSessionId) {
    await deferOrCommitPendingFirstInput(session)
    await runStartupSideEffectsOnce(session, reportedSessionId)
  }

  return {
    session,
    reconnectionHandle,
    reportedSessionId,
    attachedToExistingSession: false,
    disposeRuntimeActivity: preparedRuntimeActivity?.dispose,
    commitPendingFirstInputAfterRuntimeReady,
  }
  } catch (error) {
    await preparedRuntimeActivity?.dispose().catch(() => {})
    throw error
  }
}
