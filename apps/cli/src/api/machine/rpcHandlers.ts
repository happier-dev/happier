import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { logger } from '@/ui/logger';
import { readNonBlankOpaqueIdentifier } from '@/utils/opaqueIdentifiers';
import { readBugReportLogTail } from '@/diagnostics/bugReportMachineDiagnostics';
import { collectBugReportMachineDiagnosticsSnapshotForBugReport } from '@/diagnostics/bugReportMachineDiagnosticsRecipe';

import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionOptions,
  type SpawnSessionResult,
} from '@/rpc/handlers/registerSessionHandlers';
import { resolveCanonicalCodexBackendMode } from '@/rpc/handlers/codexBackendMode';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  AcpConfigOptionOverridesV1Schema,
  AgentRuntimeDescriptorV1Schema,
  BackendTargetRefSchema,
  ConnectedServiceBindingsV1Schema,
  PendingFirstInputV1Schema,
  RestartAllSessionRunnersRequestV1Schema,
  RestartSessionRunnerRequestV1Schema,
  SessionAgentTransitionRequestV1Schema,
  rejectUndispatchedSessionAgentTransition,
  SessionConnectedServiceAuthSwitchRpcParamsSchema,
  SessionAgentTransitionBriefPreviewRequestV1Schema,
  SessionContinuationInspectionRequestV1Schema,
  SessionContinueWithReplayRpcParamsSchema,
  SessionForkRpcParamsSchema,
  SessionInitialGoalRequestV1Schema,
  SessionMcpSelectionV1Schema,
  SessionRunnerStatusGetRequestV1Schema,
  SessionSpawnSourceContextV1Schema,
  getActionSpec,
  type ConnectedServiceBindingsV1,
  type SessionForkRpcResult,
  type SessionHandoffStartRequest,
  type SessionSpawnSourceContextV1,
} from '@happier-dev/protocol';
import { isPermissionMode } from '@/api/types';
import { CATALOG_AGENT_IDS } from '@/backends/types';
import type { CatalogAgentId } from '@/backends/types';
import { readCredentials } from '@/persistence';
import { runSessionAgentTransition } from '@/session/agentTransition/sessionAgentTransitionCoordinator';
import { previewSessionAgentTransitionBrief } from '@/session/agentTransition/previewSessionAgentTransitionBrief';
import { inspectSessionContinuation } from '@/session/agentTransition/sessionContinuationInspection';
import { buildReplaySeededSpawnRecipe } from '@/session/replay/buildReplaySeededSpawnRecipe';
import { resolveReplaySourceContextAuthority } from '@/session/replay/resolveReplaySourceContextAuthority';
import { readReplaySeededCreationFailure } from '@/session/replay/replaySeededCreationFailure';
import {
  createSpawnedSession,
  readPersistedReplaySeedSourceRecipe,
  replaySeedSourceRecipeConflicts,
} from '@/session/services/createSpawnedSession';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { resolveForkCutoffSeqInclusive } from '@/session/fork/resolveForkCutoffSeqInclusive';
import { createConnectedServiceForkLaunchContext } from '@/session/fork/connectedServiceForkLaunchContext';
import { resolveForkInheritedOverridesFromMetadata } from '@/session/fork/resolveForkInheritedOverridesFromMetadata';
import type { SessionHandoffLocalMetadataSource } from '@/session/handoff/metadata/runtimeLocalSessionHandoffMetadata';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { archiveSessionByIdBestEffort } from '@/session/services/setSessionArchivedState';
import { listExecutionRunMarkers } from '@/daemon/executionRunRegistry';
import { listProcessSnapshot } from '@/daemon/processSnapshotCache';
import {
  StopSessionResultSchema,
  type StopSessionResult,
} from '@/daemon/sessions/stopSessionContract';
import type { DaemonExecutionRunEntry, DaemonExecutionRunProcessInfo } from '@happier-dev/protocol';

import type { RpcHandlerManager } from '../rpc/RpcHandlerManager';
import type { MemoryWorkerHandle } from '@/daemon/memory/memoryWorker';
import { registerMachineMemoryRpcHandlers } from './rpcHandlers.memory';
import { registerMachineTerminalRpcHandlers } from './rpcHandlers.terminal';
import { registerMachineMcpServersRpcHandlers } from './rpcHandlers.mcpServers';
import { registerMachineDirectSessionsRpcHandlers } from './rpcHandlers.directSessions';
import { registerMachineConnectedServiceQuotaRpcHandlers } from './rpcHandlers.connectedServiceQuotas';
import {
  registerMachineSessionHandoffRpcHandlers,
  type SessionHandoffDirectPeerTransferHandle,
} from './rpcHandlers.sessionHandoff';
import { registerMachinePromptAssetsRpcHandlers } from './rpcHandlers.promptAssets';
import {
  registerMachinePromptAssetTransferRpcHandlers,
  type MachinePromptAssetTransferRpcRegistration,
} from './rpcHandlers.promptAssetTransfers';
import { registerMachinePromptRegistriesRpcHandlers } from './rpcHandlers.promptRegistries';
import {
  registerMachinePromptRegistryTransferRpcHandlers,
  type MachinePromptRegistryTransferRpcRegistration,
} from './rpcHandlers.promptRegistryTransfers';
import { registerMachineSessionGoalRpcHandlers } from './rpcHandlers.sessionGoals';
import { registerMachineServerWorkRpcHandlers } from './rpcHandlers.serverWork';
import type { DaemonServerWorkScheduler } from '@/daemon/serverWork';
import type {
  CancelConnectedServiceRuntimeAuthRecovery,
  CancelInactiveSessionUsageLimitRecoveryCheck,
  NotifyConnectedServiceRuntimeAuthFailure,
  ResumeInactiveSessionWhenUsageLimitReady,
  RetryTemporaryThrottleNow,
  ScheduleInactiveSessionUsageLimitRecoveryCheck,
} from '@/session/actions/createCliActionDeps';
import { registerPetRpcHandlers } from '@/pets/rpc/registerPetRpcHandlers';
import { runReplaySummaryForDialog } from '@/session/replay/summary/runReplaySummaryForDialog';
import { configuration } from '@/configuration';
import type { FilesystemAccessPolicy } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { resolveFilesystemPolicyDefaultDirectory } from '@/rpc/handlers/fileSystem/accessPolicy/filesystemAccessPolicy';
import { isAcpForkEligibleForProvider } from '@/agent/acp/acpForkEligibility';
import type {
  AccountPetCreateRequestV1,
  AccountPetCreateResponseV1,
  ActionOperationSnapshotV1,
  DirectSessionTranscriptDeltaEphemeral,
  MachineTransferReceiveEnvelope,
  MachineTransferSendEnvelope,
  TransferEndpointCandidate,
} from '@happier-dev/protocol';
import {
  applyOpenCodeSessionAffinityMetadata,
  buildOpenCodeSessionEnvironmentVariables,
  readOpenCodeSessionAffinityFromMetadata,
} from '@/backends/opencode/utils/opencodeSessionAffinity';
import { inferAgentIdFromSessionMetadata, resolveVendorResumeIdFromSessionMetadata } from '@happier-dev/agents';
import { getAcpForkContinuationHandler } from '@/backends/catalog';
import {
  isProviderNativeForkFailedBeforeDispatchError,
  isProviderNativeForkIndeterminateError,
} from '@/backends/forking/providerNativeForkHandler';
import { dispatchProviderNativeFork } from '@/session/fork/providerNativeForkDispatch';
import { abandonSpawnedSessionBestEffort, awaitSpawnedSessionId, normalizeDaemonSpawnSessionEnvelope } from '@/session/services/awaitSpawnedSessionId';
import { createPromptAssetAdapterRegistry } from '@/promptAssets/createPromptAssetAdapterRegistry';
import { createPromptRegistryAdapterRegistry } from '@/promptRegistries/createPromptRegistryAdapterRegistry';
import { createActionOperationStore } from '@/daemon/actionOperations/actionOperationStore';
import { createActionOperationRunner } from '@/daemon/actionOperations/actionOperationRunner';
import { createTrackedSessionHandoffStart } from '@/daemon/actionOperations/trackedSessionHandoffStart';
import { registerActionOperationRpcHandlers } from '@/daemon/actionOperations/actionOperationRpcHandlers';
import {
  projectCoreActionOperationDomainRef,
} from '@/daemon/actionOperations/coreActionOperationProjection';
import { createSessionHandoffCoordinator } from '@/session/handoff/orchestration/sessionHandoffCoordinator';
import { bindSessionHandoffTarget } from '@/session/handoff/orchestration/sessionHandoffTargetBinding';
import { buildTrackedSessionHandoffMachineCall } from '@/session/handoff/trackedSessionHandoffMachineCall';
import { callMachineRpc } from '@/session/transport/rpc/machineRpc';
import {
  normalizeSpawnSessionDirectory,
  SpawnSessionExecutionAuthorizationSchema,
} from '@/rpc/handlers/spawnSessionOptionsContract';
import {
  getDaemonSessionRunnerStatus,
  requestDaemonSessionConnectedServiceAuthSwitch,
  restartAllDaemonSessionRunners,
  requestDaemonSessionRunnerRestart,
} from '@/daemon/controlClient';

import { isAuthenticationError } from '@/api/client/httpStatusError';

// Fork requests are idempotent per caller-supplied requestId: a transport-level
// retry (machine RPC ack timeout) joins the fork already running instead of
// committing a second provider-side fork.
//
// Only the IN-FLIGHT work is held here. Idempotency for a retry that arrives
// after the first attempt finished — including one that arrives after this
// daemon restarted — is owned durably by the creation tag: the attempt id is
// what the tag is derived from, and the server's tag-keyed get-or-create rejoins
// the row the first attempt made. A process-local result cache could not answer
// that at all, and caching a FAILURE additionally made Retry inert for as long
// as the entry lived, with nothing on screen saying so.
const inFlightSessionForks = new Map<string, Promise<SessionForkRpcResult>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveEstablishedForkLineageCutoff(params: Readonly<{
  metadata: Readonly<Record<string, unknown>>;
  parentSessionId: string;
  requestId: string;
  fallbackCutoffSeqInclusive: number;
}>): number {
  const forkV1 = params.metadata.forkV1;
  const cutoff = isRecord(forkV1) ? forkV1.parentCutoffSeqInclusive : null;
  if (
    !isRecord(forkV1)
    || forkV1.v !== 1
    || forkV1.parentSessionId !== params.parentSessionId
    || forkV1.requestId !== params.requestId
    || typeof cutoff !== 'number'
    || !Number.isInteger(cutoff)
    || cutoff < 0
  ) {
    return params.fallbackCutoffSeqInclusive;
  }

  // requestId is a durable logical-attempt identity. Retrying a latest fork
  // may observe a newer parent head, but must not alter the child lineage that
  // this same request already established.
  return cutoff;
}


function parseSessionConnectedServiceAuthSwitchRpcParams(raw: unknown): Readonly<{
  sessionId: string;
  agentId: string;
  bindings: ConnectedServiceBindingsV1;
  rematerializeServiceId?: string;
  expectedGroupGenerationByServiceId?: Readonly<Record<string, number>>;
}> | null {
  const parsed = SessionConnectedServiceAuthSwitchRpcParamsSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

type MachineStopSessionHandlerResult = StopSessionResult | boolean;

function normalizeMachineStopSessionResult(result: MachineStopSessionHandlerResult): StopSessionResult {
  if (typeof result === 'boolean') {
    // Compatibility for older in-process registrars: boolean success proves only
    // request acceptance. Current daemon registrations return the strict result.
    return result ? { status: 'requested' } : { status: 'not_found' };
  }
  return StopSessionResultSchema.parse(result);
}

export type MachineRpcHandlers = {
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  spawnSessionForHandoff?: (
    options: SpawnSessionOptions,
    hooks: import('@/rpc/handlers/registerSessionHandlers').SpawnSessionRunnerAcceptanceHooks,
  ) => Promise<SpawnSessionResult>;
  resolveSpawnSessionByNonce?: (spawnNonce: string) => Promise<
    import('@happier-dev/protocol').SpawnSessionNonceResolution
  >;
  abandonSpawnSessionByNonce?: (spawnNonce: string) => Promise<
    | { status: 'completed'; sessionId: string }
    | { status: 'pending' | 'not_found' | 'unsupported' | 'failed' }
  >;
  stopSession: (sessionId: string) => Promise<MachineStopSessionHandlerResult>;
  isSessionActive?: (sessionId: string) => Promise<boolean>;
  loadLocalSessionMetadata?: (sessionId: string) => Promise<SessionHandoffLocalMetadataSource | null>;
  requestShutdown: () => void;
  memory?: MemoryWorkerHandle;
  daemonServerWorkScheduler?: Pick<DaemonServerWorkScheduler, 'getSnapshot'>;
  machineTransferChannel?: Readonly<{
    onEnvelope: (listener: (payload: MachineTransferReceiveEnvelope) => void) => () => void;
    sendEnvelope: (payload: MachineTransferSendEnvelope) => void;
  }>;
  directPeerTransfer?: SessionHandoffDirectPeerTransferHandle;
};

export type MachineRpcHandlerDeps = Readonly<{
  runReplaySummaryForDialog?: typeof runReplaySummaryForDialog;
  promptAssetsHomedir?: () => string;
  promptAssetsHappierHomeDir?: () => string;
  machineRpcWorkingDirectory?: string;
  filesystemAccessPolicy?: FilesystemAccessPolicy;
  emitDirectSessionTranscriptUpdate?: (payload: DirectSessionTranscriptDeltaEphemeral) => void;
  emitActionOperationRevision?: (snapshot: ActionOperationSnapshotV1) => void;
  createAccountPet?: (request: AccountPetCreateRequestV1) => Promise<AccountPetCreateResponseV1>;
  resumeInactiveSessionWhenUsageLimitReady?: ResumeInactiveSessionWhenUsageLimitReady;
  scheduleInactiveSessionUsageLimitRecoveryCheck?: ScheduleInactiveSessionUsageLimitRecoveryCheck;
  cancelInactiveSessionUsageLimitRecoveryCheck?: CancelInactiveSessionUsageLimitRecoveryCheck;
  cancelConnectedServiceRuntimeAuthRecovery?: CancelConnectedServiceRuntimeAuthRecovery;
  notifyConnectedServiceRuntimeAuthFailure?: NotifyConnectedServiceRuntimeAuthFailure;
  retryTemporaryThrottleNow?: RetryTemporaryThrottleNow;
  getActionOperationScope?: () => Promise<Readonly<{ accountId: string; machineId: string }>>;
}>;

export type MachineRpcLifecycleRegistration = Readonly<{
  promptAssetTransfers: MachinePromptAssetTransferRpcRegistration;
  promptRegistryTransfers: MachinePromptRegistryTransferRpcRegistration;
  dispose: () => Promise<void>;
}>;

async function fetchForkChildSessionOrThrow(params: Readonly<{
  token: string;
  sessionId: string;
  attempts?: number;
  delayMs?: number;
  signal?: AbortSignal;
}>): Promise<NonNullable<Awaited<ReturnType<typeof fetchSessionByIdCompat>>>> {
  const attempts = typeof params.attempts === 'number' && params.attempts >= 1 ? Math.floor(params.attempts) : 6;
  const delayMs = typeof params.delayMs === 'number' && params.delayMs >= 0 ? Math.floor(params.delayMs) : 250;
  let lastError: unknown = null;

  for (let index = 0; index < attempts; index += 1) {
    throwIfTrackedActionAborted(params.signal);
    try {
      const raw = await fetchSessionByIdCompat({ token: params.token, sessionId: params.sessionId });
      throwIfTrackedActionAborted(params.signal);
      if (raw) return raw;
      lastError = new Error('Session fetch returned empty response');
    } catch (error) {
      if (isAuthenticationError(error)) throw error;
      lastError = error;
    }
    if (index < attempts - 1 && delayMs > 0) {
      await waitForTrackedActionDelay(delayMs, params.signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to load forked child session ${params.sessionId}`);
}

function throwIfTrackedActionAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Action operation cancelled');
  error.name = 'AbortError';
  throw error;
}

function isTrackedActionAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

async function waitForTrackedActionDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
    return;
  }
  throwIfTrackedActionAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      const error = new Error('Action operation cancelled');
      error.name = 'AbortError';
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function cleanupForkChildBestEffort(stopSession: (sessionId: string) => Promise<boolean>, sessionId: string): Promise<void> {
  try {
    await stopSession(sessionId);
  } catch {
    // Best-effort only: the important part is surfacing the original fork failure.
  }
}

async function archiveSessionBestEffort(token: string, sessionId: string): Promise<void> {
  await archiveSessionByIdBestEffort({ token, sessionId });
}

async function toCanonicalPath(path: string): Promise<string | null> {
  const normalized = String(path ?? '').trim();
  if (!normalized) return null;
  try {
    return await realpath(normalized);
  } catch {
    return null;
  }
}

function isKnownAgentId(value: string): value is CatalogAgentId {
  return (CATALOG_AGENT_IDS as readonly string[]).includes(value);
}

function isPathInside(targetPath: string, allowedDir: string): boolean {
  const rel = relative(allowedDir, targetPath);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function parseEnvBoundedInt(
  name: string,
  bounds: Readonly<{ min: number; max: number }>,
  fallback: number | null,
): number | null {
  const rawValue = process.env[name];
  if (typeof rawValue !== 'string' || rawValue.trim().length === 0) return fallback;
  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(parsedValue)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, parsedValue));
}

export function registerMachineRpcHandlers(params: Readonly<{
  rpcHandlerManager: RpcHandlerManager;
  handlers: MachineRpcHandlers;
  deps?: MachineRpcHandlerDeps;
}>): MachineRpcLifecycleRegistration {
  const { rpcHandlerManager, handlers } = params;
  const { spawnSession, stopSession, requestShutdown, resolveSpawnSessionByNonce, abandonSpawnSessionByNonce } = handlers;
  const stopSessionConfirmed = async (sessionId: string): Promise<boolean> => (
    normalizeMachineStopSessionResult(await stopSession(sessionId)).status === 'stopped'
  );
  const memoryWorker = handlers.memory ?? null;
  const accessPolicy = params.deps?.filesystemAccessPolicy;
  const machineRpcWorkingDirectory = params.deps?.machineRpcWorkingDirectory;
  const effectiveMachineRpcWorkingDirectory =
    machineRpcWorkingDirectory && accessPolicy
      ? resolveFilesystemPolicyDefaultDirectory({
        defaultDirectory: machineRpcWorkingDirectory,
        accessPolicy,
      })
      : machineRpcWorkingDirectory;
  let actionOperationRuntime: Readonly<{
    runner: ReturnType<typeof createActionOperationRunner>;
    getScope: NonNullable<MachineRpcHandlerDeps['getActionOperationScope']>;
  }> | null = null;

  if (params.deps?.getActionOperationScope) {
    const actionOperationStore = createActionOperationStore({
      onRevision: params.deps.emitActionOperationRevision,
    });
    const actionOperationRunner = createActionOperationRunner({ store: actionOperationStore });
    registerActionOperationRpcHandlers({
      rpcHandlerManager,
      store: actionOperationStore,
      runner: actionOperationRunner,
      getScope: params.deps.getActionOperationScope,
    });
    actionOperationRuntime = {
      runner: actionOperationRunner,
      getScope: params.deps.getActionOperationScope,
    };
  }

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH, async (raw: unknown) => {
    const parsed = parseSessionConnectedServiceAuthSwitchRpcParams(raw);
    if (!parsed) {
      return { ok: false, errorCode: 'unsupported_service' };
    }
    return await requestDaemonSessionConnectedServiceAuthSwitch(parsed);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART, async (raw: unknown) => {
    const parsed = RestartSessionRunnerRequestV1Schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error('Invalid daemon session runner restart request');
    }
    return await requestDaemonSessionRunnerRestart(parsed.data);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_ALL, async (raw: unknown) => {
    const parsed = RestartAllSessionRunnersRequestV1Schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error('Invalid daemon session runner restart-all request');
    }
    return await restartAllDaemonSessionRunners(parsed.data);
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET, async (raw: unknown) => {
    const parsed = SessionRunnerStatusGetRequestV1Schema.safeParse(raw);
    if (!parsed.success) {
      throw new Error('Invalid daemon session runner status request');
    }
    return await getDaemonSessionRunnerStatus(parsed.data);
  });

  /**
   * `sourceContext` creation for the machine-RPC spawn ingress.
   *
   * The UI's ordinary creation path reaches the daemon here, not through the
   * `session.spawn_new` Action, so this ingress has to honour the typed recipe
   * too. It builds the recipe through the single Replay recipe owner and commits
   * the row through the single canonical creator, exactly like the two Replay
   * ingresses in this file; only the ingress-specific spawn options differ, and
   * they are merged inside the direct transport.
   */
  const spawnSourceContextSeededSession = async (args: Readonly<{
    sourceContext: SessionSpawnSourceContextV1;
    directory: string;
    backendTarget: SpawnSessionOptions['backendTarget'];
    baseSpawnOptions: SpawnSessionOptions;
    approvedNewDirectoryCreation: unknown;
    spawnNonce: string | undefined;
  }>): Promise<SpawnSessionResult> => {
    // Predecessor Replay creation metadata (`flavor`, `forkV1.providerHint`) has
    // only built-in Agent vocabulary, matching the other two Replay ingresses.
    // Fail closed rather than persist a lineage this tree cannot express.
    if (args.backendTarget?.kind !== 'builtInAgent') {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Continuing from an existing session requires a built-in agent target',
      };
    }
    const agentId = args.backendTarget.agentId;

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_MISSING_ENCRYPTION_KEY,
        errorMessage: 'This daemon is not provisioned with dataKey credentials and cannot decrypt transcripts for replay.',
      };
    }

    const validateResolvedSourceContextChild = async (sessionId: string): Promise<SpawnSessionResult> => {
      let child: Awaited<ReturnType<typeof fetchSessionByIdCompat>>;
      try {
        child = await fetchSessionByIdCompat({ token: credentials.token, sessionId });
      } catch (error) {
        if (isAuthenticationError(error)) throw error;
        return {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
          errorMessage: 'The earlier source-context Session could not be authenticated yet',
        };
      }
      if (!child) {
        return {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
          errorMessage: 'The earlier source-context Session could not be authenticated yet',
        };
      }
      const ownerMetadata = tryDecryptSessionMetadata({ credentials, rawSession: child });
      const persistedSourceRecipe = readPersistedReplaySeedSourceRecipe(
        ownerMetadata as Readonly<Record<string, unknown>> | null,
      );
      if (!persistedSourceRecipe) {
        return {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
          errorMessage: 'The earlier source-context Session could not be authenticated yet',
        };
      }
      if (replaySeedSourceRecipeConflicts(persistedSourceRecipe, args.sourceContext)) {
        // The predecessor SpawnSessionResult has no creation_conflict arm. Keep
        // its stable invalid-request projection while refusing before child use;
        // this ingress delegates comparison to the creator-owned helper.
        return {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
          errorMessage: 'Existing Session was created from a different source recipe',
        };
      }
      return { type: 'success', sessionId };
    };

    // The caller-owned nonce is the existing creation identity. Resolve it
    // before rebuilding a latest source recipe: a lost response may already
    // have a child whose original cutoff must remain authoritative.
    if (args.spawnNonce && resolveSpawnSessionByNonce) {
      try {
        const resolved = await resolveSpawnSessionByNonce(args.spawnNonce);
        if (resolved.status === 'success') {
          return await validateResolvedSourceContextChild(resolved.sessionId);
        }
        if (resolved.status === 'pending') {
          return { type: 'success', spawnNonce: args.spawnNonce, sessionIdStatus: 'pending' };
        }
        if (resolved.status === 'error') {
          return {
            type: 'error',
            errorCode: resolved.errorCode,
            errorMessage: resolved.errorMessage,
            ...(resolved.errorDetail ? { errorDetail: resolved.errorDetail } : {}),
          };
        }
        // `not_found` and `unsupported` have no child evidence. Continue through
        // the canonical create-or-rejoin owner with the same stable tag.
      } catch (error) {
        if (isAuthenticationError(error)) throw error;
        return {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT,
          errorMessage: 'The earlier source-context session launch could not be resolved',
        };
      }
    }

    // No resolved child exists only on this creation path. Validate current
    // source ownership before composing the recipe; retry/rejoin above instead
    // validates the persisted child lineage without rereading the source head.
    const sourceAuthority = await resolveReplaySourceContextAuthority({
      credentials,
      sourceSessionId: args.sourceContext.sourceSessionId,
    });
    if (sourceAuthority.status !== 'owned') {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: sourceAuthority.status === 'not_owned'
          ? 'The source Session must be owned by the current Account'
          : 'The source Session is unavailable',
      };
    }

    const recipe = await buildReplaySeededSpawnRecipe({
      credentials,
      cwd: args.directory,
      source: {
        sourceSessionId: args.sourceContext.sourceSessionId,
        forkPoint: args.sourceContext.forkPoint,
      },
      providerHintAgentId: agentId,
      strategy: 'recent_messages',
      ...(params.deps?.runReplaySummaryForDialog
        ? { deps: { runReplaySummaryForDialog: params.deps.runReplaySummaryForDialog } }
        : {}),
    });
    if (!recipe.ok) {
      return {
        type: 'error',
        errorCode: recipe.errorCode,
        errorMessage: recipe.errorMessage,
      };
    }

    // Retry identity stays this ingress's existing durable per-attempt key.
    const creationTag = args.spawnNonce
      ?? `sourceContext:${args.sourceContext.sourceSessionId}:${recipe.recipe.cutoffSeqInclusive}:${randomUUID()}`;

    // The canonical creator commits the row and then attaches this launch to it through
    // `existingSessionId`, so it — not this ingress — owns the fresh materialization identity
    // a connected-service binding needs on a brand-new row. Hand it the bindings this spawn
    // actually carries so it can make that decision.
    const connectedServices = ConnectedServiceBindingsV1Schema.safeParse(
      args.baseSpawnOptions.connectedServices,
    );

    try {
      const created = await createSpawnedSession({
        credentials,
        directory: args.directory,
        backendTarget: args.backendTarget,
        ...(connectedServices.success ? { connectedServices: connectedServices.data } : {}),
        ...(args.spawnNonce ? { spawnNonce: args.spawnNonce } : {}),
        // The public RPC already parsed this input. Keep it host-private below
        // the ingress so the canonical creator can validate an atomic rejoin
        // against original `latest` semantics without widening any wire shape.
        sourceContext: args.sourceContext,
        replaySeededCreation: {
          tag: creationTag,
          agentId,
          metadata: recipe.recipe.metadata,
          sourceRecipe: {
            sourceSessionId: args.sourceContext.sourceSessionId,
            cutoffSeqInclusive: recipe.recipe.cutoffSeqInclusive,
          },
        },
        directTransport: {
          spawn: async (request) => await spawnSession({
            ...args.baseSpawnOptions,
            existingSessionId: request.existingSessionId,
            ...(request.connectedServiceMaterializationIdentityV1
              ? { connectedServiceMaterializationIdentityV1: request.connectedServiceMaterializationIdentityV1 }
              : {}),
            approvedNewDirectoryCreation: args.approvedNewDirectoryCreation as boolean | undefined,
          } satisfies SpawnSessionOptions),
        },
      });
      return { type: 'success', sessionId: created.sessionId };
    } catch (error) {
      if (isAuthenticationError(error)) throw error;
      const failure = readReplaySeededCreationFailure(error);
      if (failure.stage === 'spawn') {
        // The canonical creator already settled the orphaned row.
        return failure.spawnResult as SpawnSessionResult;
      }
      logger.debug('[API MACHINE] Failed to create source-context session', {
        error: failure.errorMessage,
      });
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'Failed to create a new session from the requested source',
      };
    }
  };

  // Both public spawn RPCs delegate to this single nonce/custody owner. Their
  // response projections intentionally differ below for released-client compatibility.
  const handleSpawnHappySession = async (params: any): Promise<SpawnSessionResult> => {
    const {
      directory,
      spawnNonce,
      pendingFirstInput,
      sessionId,
      machineId,
      approvedNewDirectoryCreation,
      backendTarget,
      environmentVariables,
      profileId,
      terminal,
      resume,
      connectedServices,
      connectedServicesUpdatedAt,
      transcriptStorage,
      attachMetadataIdentityPolicy,
      permissionMode,
      permissionModeUpdatedAt,
      agentModeId,
      agentModeUpdatedAt,
      modelId,
      modelUpdatedAt,
      accountSettingsVersionHint,
      initialTranscriptAfterSeq,
      executionAuthorization,
      initialGoal,
      sessionConfigOptionOverrides,
      windowsRemoteSessionLaunchMode,
      windowsRemoteSessionConsole,
      experimentalCodexAcp,
      codexBackendMode,
      agentRuntimeDescriptorV1,
      mcpSelection,
      sourceContext,
      requestOrigin,
    } = params || {};

    // Required semantics, never an ignorable hint: a present-but-invalid recipe
    // is refused here rather than dropped, because a dropped one would create an
    // ordinary blank Session and report success.
    const normalizedSourceContext = (() => {
      if (sourceContext === undefined || sourceContext === null) return undefined;
      const parsed = SessionSpawnSourceContextV1Schema.safeParse(sourceContext);
      return parsed.success ? parsed.data : null;
    })();
    if (normalizedSourceContext === null) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Invalid sourceContext',
      };
    }

    const normalizedModelId = typeof modelId === 'string' && modelId.trim().length > 0 ? modelId : undefined;
    const normalizedPermissionMode =
      typeof permissionMode === 'string' && isPermissionMode(permissionMode) ? permissionMode : undefined;
    const normalizedPermissionModeUpdatedAt =
      normalizedPermissionMode && typeof permissionModeUpdatedAt === 'number' ? permissionModeUpdatedAt : undefined;
    const normalizedAgentModeId =
      typeof agentModeId === 'string' && agentModeId.trim().length > 0 ? agentModeId : undefined;
    const normalizedAgentModeUpdatedAt =
      normalizedAgentModeId && typeof agentModeUpdatedAt === 'number' ? agentModeUpdatedAt : undefined;
    const normalizedAccountSettingsVersionHint =
      typeof accountSettingsVersionHint === 'number'
      && Number.isInteger(accountSettingsVersionHint)
      && accountSettingsVersionHint >= 0
        ? accountSettingsVersionHint
        : undefined;
    const normalizedInitialTranscriptAfterSeq =
      typeof initialTranscriptAfterSeq === 'number'
      && Number.isInteger(initialTranscriptAfterSeq)
      && initialTranscriptAfterSeq >= 0
        ? initialTranscriptAfterSeq
        : undefined;
    const normalizedExecutionAuthorization = (() => {
      if (executionAuthorization === undefined) return undefined;
      const parsed = SpawnSessionExecutionAuthorizationSchema.safeParse(executionAuthorization);
      return parsed.success ? parsed.data : undefined;
    })();
    const normalizedInitialGoal = (() => {
      if (initialGoal === undefined) return undefined;
      const parsed = SessionInitialGoalRequestV1Schema.safeParse(initialGoal);
      return parsed.success ? parsed.data : undefined;
    })();
    const normalizedEnvironmentVariables = environmentVariables && typeof environmentVariables === 'object'
      ? environmentVariables as Record<string, string>
      : undefined;
    const normalizedResume = typeof resume === 'string' ? resume : undefined;
    const normalizedPendingFirstInput = (() => {
      const parsed = PendingFirstInputV1Schema.safeParse(pendingFirstInput);
      return parsed.success ? parsed.data : undefined;
    })();
    const normalizedSpawnNonce = typeof spawnNonce === 'string' && spawnNonce.trim().length > 0 ? spawnNonce : undefined;
    const normalizedTranscriptStorage =
      transcriptStorage === 'persisted' || transcriptStorage === 'direct' ? transcriptStorage : undefined;
    const normalizedAttachMetadataIdentityPolicy =
      attachMetadataIdentityPolicy === 'preserve_current_identity'
      || attachMetadataIdentityPolicy === 'replace_with_runtime_identity'
        ? attachMetadataIdentityPolicy
        : undefined;
    const normalizedBackendTarget = (() => {
      const parsed = BackendTargetRefSchema.safeParse(backendTarget);
      if (!parsed.success) return undefined;
      if (parsed.data.kind === 'builtInAgent') {
        const agentId = parsed.data.agentId.trim();
        if (!isKnownAgentId(agentId)) {
          return null;
        }
        return {
          kind: 'builtInAgent' as const,
          agentId,
        };
      }
      return {
        kind: 'configuredAcpBackend' as const,
        backendId: parsed.data.backendId.trim(),
      };
    })();
    if (normalizedBackendTarget === null) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Unknown backend target',
      };
    }
    const normalizedMcpSelection = (() => {
      if (mcpSelection === undefined) return undefined;
      const parsed = SessionMcpSelectionV1Schema.safeParse(mcpSelection);
      return parsed.success ? parsed.data : undefined;
    })();
    const normalizedSessionConfigOptionOverrides = (() => {
      if (sessionConfigOptionOverrides === undefined) return undefined;
      const parsed = AcpConfigOptionOverridesV1Schema.safeParse(sessionConfigOptionOverrides);
      return parsed.success ? parsed.data : undefined;
    })();
    const normalizedAgentRuntimeDescriptorV1 = (() => {
      if (agentRuntimeDescriptorV1 === undefined) return undefined;
      const parsed = AgentRuntimeDescriptorV1Schema.safeParse(agentRuntimeDescriptorV1);
      return parsed.success ? parsed.data : undefined;
    })();
    const normalizedCodexBackendMode = resolveCanonicalCodexBackendMode({
      codexBackendMode,
      experimentalCodexAcp,
      agentRuntimeDescriptorV1: normalizedAgentRuntimeDescriptorV1,
    });
    const envKeys = normalizedEnvironmentVariables ? Object.keys(normalizedEnvironmentVariables) : [];
    const maxEnvKeysToLog = 20;
    const envKeySample = envKeys.slice(0, maxEnvKeysToLog);
    const resolvedDirectory = typeof directory === 'string' ? normalizeSpawnSessionDirectory(directory, process.env) : directory;

    // Attribution telemetry (WAVE-E-F01): a live incident showed spawn/resume daemon activity fire
    // on merely OPENING an inactive session route, with no obvious caller. Emit ONE info line per
    // spawn/resume request carrying the caller-source fields already on the RPC (requestType, ids,
    // spawnNonce, terminal, backendTarget) plus an OPTIONAL `requestOrigin` string a UI/MCP caller
    // may thread. Source metadata only — never secrets/env values.
    const normalizedRequestOrigin =
      typeof requestOrigin === 'string' && requestOrigin.trim().length > 0 ? requestOrigin.trim() : undefined;
    logger.info('[API MACHINE] spawn/resume request received', {
      requestType: params?.type === 'resume-session' ? 'resume-session' : 'spawn',
      sessionId,
      machineId,
      spawnNonce: normalizedSpawnNonce,
      terminal,
      backendTarget: normalizedBackendTarget,
      hasResume: normalizedResume !== undefined,
      requestOrigin: normalizedRequestOrigin,
    });

    logger.debug('[API MACHINE] Spawning session', {
      directory: resolvedDirectory,
      sessionId,
      machineId,
      backendTarget: normalizedBackendTarget,
      approvedNewDirectoryCreation,
      profileId,
      terminal,
      permissionMode: normalizedPermissionMode,
      permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
      accountSettingsVersionHint: normalizedAccountSettingsVersionHint,
      agentModeId: normalizedAgentModeId,
      agentModeUpdatedAt: normalizedAgentModeUpdatedAt,
      modelId: normalizedModelId,
      modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
      sessionConfigOptionOverrides: normalizedSessionConfigOptionOverrides,
      environmentVariableCount: envKeys.length,
      environmentVariableKeySample: envKeySample,
      environmentVariableKeysTruncated: envKeys.length > maxEnvKeysToLog,
      hasMcpSelection: normalizedMcpSelection !== undefined,
      mcpSelectionForceIncludeCount: normalizedMcpSelection?.forceIncludeServerIds.length ?? 0,
      mcpSelectionForceExcludeCount: normalizedMcpSelection?.forceExcludeServerIds.length ?? 0,
      hasResume: normalizedResume !== undefined,
      hasInitialTranscriptAfterSeq: normalizedInitialTranscriptAfterSeq !== undefined,
      hasInitialGoal: normalizedInitialGoal !== undefined,
      codexBackendMode: normalizedCodexBackendMode,
    });

    const buildBaseSpawnOptions = (spawnDirectory: string): SpawnSessionOptions => ({
      directory: spawnDirectory,
      spawnNonce: normalizedSpawnNonce,
      pendingFirstInput: normalizedPendingFirstInput,
      machineId,
      backendTarget: normalizedBackendTarget,
      environmentVariables: normalizedEnvironmentVariables,
      profileId,
      terminal,
      resume: normalizedResume,
      connectedServices,
      connectedServicesUpdatedAt,
      transcriptStorage: normalizedTranscriptStorage,
      attachMetadataIdentityPolicy: normalizedAttachMetadataIdentityPolicy,
      permissionMode: normalizedPermissionMode,
      permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
      accountSettingsVersionHint: normalizedAccountSettingsVersionHint,
      initialTranscriptAfterSeq: normalizedInitialTranscriptAfterSeq,
      executionAuthorization: normalizedExecutionAuthorization,
      initialGoal: normalizedInitialGoal,
      agentModeId: normalizedAgentModeId,
      agentModeUpdatedAt: normalizedAgentModeUpdatedAt,
      modelId: normalizedModelId,
      modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
      sessionConfigOptionOverrides: normalizedSessionConfigOptionOverrides,
      windowsRemoteSessionLaunchMode,
      windowsRemoteSessionConsole,
      mcpSelection: normalizedMcpSelection,
      ...(normalizedAgentRuntimeDescriptorV1 ? { agentRuntimeDescriptorV1: normalizedAgentRuntimeDescriptorV1 } : {}),
      ...(normalizedCodexBackendMode ? { codexBackendMode: normalizedCodexBackendMode } : {}),
    });

    // Handle resume-session type for inactive session resumption
    if (params?.type === 'resume-session') {
      const { sessionId: existingSessionId } = params;
      logger.debug(`[API MACHINE] Resuming inactive session ${existingSessionId}`);

      if (normalizedSourceContext) {
        // Resume attaches to an existing Session; there is no child to seed, so
        // accepting the recipe here would silently discard it.
        return {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
          errorMessage: 'sourceContext is not supported when resuming an existing session',
        };
      }

      if (!resolvedDirectory) {
        return {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
          errorMessage: 'Directory is required',
        };
      }
      if (!existingSessionId) {
        return {
          type: 'error',
          errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
          errorMessage: 'Session ID is required for resume',
        };
      }

      const baseSpawnOptions = buildBaseSpawnOptions(resolvedDirectory);
      const result = await spawnSession({
        ...baseSpawnOptions,
        existingSessionId,
        approvedNewDirectoryCreation: true,
      });

      if (result.type === 'error') {
        return result;
      }

      // Resume reuses the existing session id, but the caller still needs the exact
      // accepted identity (and whether a fresh or pre-existing runner accepted it)
      // before it can release durable pending custody.
      return result;
    }

    if (!resolvedDirectory) {
      return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST, errorMessage: 'Directory is required' };
    }

    const baseSpawnOptions = buildBaseSpawnOptions(resolvedDirectory);

    if (normalizedSourceContext) {
      return await spawnSourceContextSeededSession({
        sourceContext: normalizedSourceContext,
        directory: resolvedDirectory,
        backendTarget: normalizedBackendTarget,
        baseSpawnOptions,
        approvedNewDirectoryCreation,
        spawnNonce: normalizedSpawnNonce,
      });
    }

    const rawResult = await spawnSession({
      ...baseSpawnOptions,
      sessionId,
      approvedNewDirectoryCreation,
    });
    const result = normalizeDaemonSpawnSessionEnvelope(rawResult) ?? rawResult;

    switch (result.type) {
      case 'success':
        if (result.sessionId) {
          logger.debug(`[API MACHINE] Spawned session ${result.sessionId}`);
        } else {
          logger.debug('[API MACHINE] Spawn accepted; session identity pending', {
            spawnNonce: result.spawnNonce,
          });
        }
        return {
          ...result,
          ...(pendingFirstInput !== undefined
            ? {
                pendingFirstInputAccepted:
                  normalizedPendingFirstInput !== undefined
                  && result.runnerAcceptance !== 'preexisting_or_adopted',
              }
            : {}),
        };

      case 'requestToApproveDirectoryCreation':
        logger.debug(`[API MACHINE] Requesting directory creation approval for: ${result.directory}`);
        return { type: 'requestToApproveDirectoryCreation', directory: result.directory };

      case 'error':
        return result;
    }
  };

  const handleTrackedSpawnHappySession = async (raw: unknown) => {
    const record = raw && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Readonly<Record<string, unknown>>
      : null;
    const requestId = readNonBlankOpaqueIdentifier(record?.spawnNonce);
    if (!actionOperationRuntime || !requestId) return await handleSpawnHappySession(raw);

    let receiptSettled = false;
    let resolveReceipt!: (value: Awaited<ReturnType<typeof handleSpawnHappySession>>) => void;
    let rejectReceipt!: (error: unknown) => void;
    const receipt = new Promise<Awaited<ReturnType<typeof handleSpawnHappySession>>>((resolve, reject) => {
      resolveReceipt = (value) => { receiptSettled = true; resolve(value); };
      rejectReceipt = (error) => { receiptSettled = true; reject(error); };
    });
    const scope = await actionOperationRuntime.getScope();
    void actionOperationRuntime.runner.executeHistorical({
      request: { actionId: 'session.spawn_new', input: {}, requestId, scope: {} },
      scope,
      title: getActionSpec('session.spawn_new').title,
      cancellation: abandonSpawnSessionByNonce ? 'supported' : 'unsupported',
      domainRef: { kind: 'spawnAttempt', id: requestId },
      execute: async ({ signal, update }) => {
        update({ progress: { kind: 'phase', phase: 'creating', label: 'Creating session' } });
        const initial = await handleSpawnHappySession(raw);
        resolveReceipt(initial);
        if (initial.type !== 'success' || initial.sessionId) return initial;
        try {
          const settled = await awaitSpawnedSessionId({
            result: initial,
            resolveSpawnSessionByNonce,
            signal,
          });
          if (settled.type === 'success') {
            update({ progress: { kind: 'phase', phase: 'custody_confirmed', label: 'Session custody confirmed' } });
          }
          return settled;
        } catch (error) {
          if (!signal.aborted || !isTrackedActionAbort(error) || !abandonSpawnSessionByNonce) throw error;
          const cancellation = await abandonSpawnSessionByNonce(requestId);
          if (cancellation.status === 'completed') throw error;
          throw new Error('Spawn cancellation was not acknowledged');
        }
      },
      projectResult: (result) => {
        if (result.type === 'success' && result.sessionId) return { ok: true, result };
        if (result.type === 'error') {
          return { ok: false, errorCode: result.errorCode, error: result.errorMessage };
        }
        return { ok: false, errorCode: 'spawn_custody_unresolved', error: 'Spawn custody did not resolve to a session' };
      },
    }).catch((error) => {
      if (!receiptSettled) rejectReceipt(error);
    });
    return await receipt;
  };

  rpcHandlerManager.registerHandler(
    RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    handleTrackedSpawnHappySession,
  );
  rpcHandlerManager.registerHandler(RPC_METHODS.SPAWN_HAPPY_SESSION, async (params: any) => {
    const result = await handleTrackedSpawnHappySession(params);
    if (result.type !== 'success' || result.sessionId) {
      return result;
    }
    const settled = await awaitSpawnedSessionId({
      result,
      resolveSpawnSessionByNonce,
    });
    if (settled.type === 'success') {
      logger.debug(`[API MACHINE] Spawned session ${settled.sessionId}`);
      return { type: 'success' as const, sessionId: settled.sessionId };
    }
    return settled;
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SPAWN_SESSION_RESOLVE, async (params: unknown) => {
    const spawnNonce =
      params && typeof params === 'object' && typeof (params as { spawnNonce?: unknown }).spawnNonce === 'string'
        ? (params as { spawnNonce: string }).spawnNonce.trim()
        : '';
    if (!spawnNonce) {
      return { status: 'not_found' as const };
    }
    if (!handlers.resolveSpawnSessionByNonce) {
      return { status: 'unsupported' as const };
    }
    try {
      return await handlers.resolveSpawnSessionByNonce(spawnNonce);
    } catch {
      return { status: 'unsupported' as const };
    }
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_SPAWN_SESSION_ABANDON, async (params: unknown) => {
    const spawnNonce =
      params && typeof params === 'object' && typeof (params as { spawnNonce?: unknown }).spawnNonce === 'string'
        ? (params as { spawnNonce: string }).spawnNonce.trim()
        : '';
    if (!spawnNonce) return { status: 'not_found' as const };
    if (!handlers.abandonSpawnSessionByNonce) return { status: 'unsupported' as const };
    try {
      return await handlers.abandonSpawnSessionByNonce(spawnNonce);
    } catch {
      return { status: 'failed' as const };
    }
  });

  if (memoryWorker) {
    registerMachineMemoryRpcHandlers({
      rpcHandlerManager,
      memoryWorker,
    });
  }
  if (handlers.daemonServerWorkScheduler) {
    registerMachineServerWorkRpcHandlers({
      rpcHandlerManager,
      daemonServerWorkScheduler: handlers.daemonServerWorkScheduler,
    });
  }

  registerMachineTerminalRpcHandlers({
    rpcHandlerManager,
    deps: {
      ...(effectiveMachineRpcWorkingDirectory ? { workingDirectory: effectiveMachineRpcWorkingDirectory } : {}),
      ...(accessPolicy ? { accessPolicy } : {}),
    },
  });
  registerMachineMcpServersRpcHandlers({ rpcHandlerManager });
  const promptAssetAdapterRegistry = createPromptAssetAdapterRegistry({
    homedir: params.deps?.promptAssetsHomedir,
    happierHomeDir: params.deps?.promptAssetsHappierHomeDir,
  });
  const promptRegistryAdapterRegistry = createPromptRegistryAdapterRegistry();
  registerMachinePromptAssetsRpcHandlers({
    rpcHandlerManager,
    adapterRegistry: promptAssetAdapterRegistry,
  });
  const promptAssetTransfers = registerMachinePromptAssetTransferRpcHandlers({
    rpcHandlerManager,
    adapterRegistry: promptAssetAdapterRegistry,
  });
  registerMachinePromptRegistriesRpcHandlers({
    rpcHandlerManager,
    registry: promptRegistryAdapterRegistry,
    assetRegistry: promptAssetAdapterRegistry,
    deps: {
      homedir: params.deps?.promptAssetsHomedir,
      happierHomeDir: params.deps?.promptAssetsHappierHomeDir,
    },
  });
  const promptRegistryTransfers = registerMachinePromptRegistryTransferRpcHandlers({
    rpcHandlerManager,
    registry: promptRegistryAdapterRegistry,
  });
  registerMachineDirectSessionsRpcHandlers({
    rpcHandlerManager,
    spawnSession,
    stopSession: stopSessionConfirmed,
    emitDirectSessionTranscriptUpdate: params.deps?.emitDirectSessionTranscriptUpdate,
  });
  registerMachineConnectedServiceQuotaRpcHandlers({
    rpcHandlerManager,
  });
  registerMachineSessionGoalRpcHandlers({
    rpcHandlerManager,
    deps: {
      ...(params.deps?.resumeInactiveSessionWhenUsageLimitReady
        ? { resumeInactiveSessionWhenUsageLimitReady: params.deps.resumeInactiveSessionWhenUsageLimitReady }
        : {}),
      ...(params.deps?.scheduleInactiveSessionUsageLimitRecoveryCheck
        ? { scheduleInactiveSessionUsageLimitRecoveryCheck: params.deps.scheduleInactiveSessionUsageLimitRecoveryCheck }
        : {}),
      ...(params.deps?.cancelInactiveSessionUsageLimitRecoveryCheck
        ? { cancelInactiveSessionUsageLimitRecoveryCheck: params.deps.cancelInactiveSessionUsageLimitRecoveryCheck }
        : {}),
      ...(params.deps?.cancelConnectedServiceRuntimeAuthRecovery
        ? { cancelConnectedServiceRuntimeAuthRecovery: params.deps.cancelConnectedServiceRuntimeAuthRecovery }
        : {}),
      ...(params.deps?.notifyConnectedServiceRuntimeAuthFailure
        ? { notifyConnectedServiceRuntimeAuthFailure: params.deps.notifyConnectedServiceRuntimeAuthFailure }
        : {}),
      ...(params.deps?.retryTemporaryThrottleNow
        ? { retryTemporaryThrottleNow: params.deps.retryTemporaryThrottleNow }
        : {}),
    },
  });
  registerPetRpcHandlers({
    rpcHandlerManager,
    createAccountPet: params.deps?.createAccountPet,
  });
  registerMachineSessionHandoffRpcHandlers({
    rpcHandlerManager,
    ...(actionOperationRuntime ? {
      wrapStartHandler: (startUntracked) => createTrackedSessionHandoffStart({
        runner: actionOperationRuntime.runner,
        getScope: actionOperationRuntime.getScope,
        startUntracked: async (request) => await startUntracked(request),
        coordinate: async (request, context, startSource) => {
          const scope = await actionOperationRuntime.getScope();
          if (request.sourceMachineId !== scope.machineId) {
            return {
              ok: false,
              errorCode: 'machine_mismatch',
              error: 'Session handoff source does not match this daemon',
            };
          }
          const credentials = await readCredentials().catch(() => null);
          if (!credentials) {
            return { ok: false, errorCode: 'not_authenticated', error: 'Authentication is required' };
          }
          const rawSession = await fetchSessionByIdCompat({
            token: credentials.token,
            sessionId: request.sessionId,
          }).catch(() => null);
          const sourceMetadata = rawSession
            ? tryDecryptSessionMetadata({ credentials, rawSession }) as Record<string, unknown> | null
            : null;
          const connectedServices = sourceMetadata
            && Object.prototype.hasOwnProperty.call(sourceMetadata, 'connectedServices')
            ? sourceMetadata.connectedServices
            : undefined;
          const targetRpc = async (method: string, payload: unknown): Promise<unknown> => await callMachineRpc(buildTrackedSessionHandoffMachineCall({
            credentials,
            machineId: request.targetMachineId,
            method,
            request: payload,
          }));
          const coordinator = createSessionHandoffCoordinator({
            transportStrategy: request.negotiatedTransportStrategy
              ?? (request.preferredTransportStrategies.includes('direct_peer') ? 'direct_peer' : 'server_routed_stream'),
            probeTargetCapability: async () => await targetRpc(RPC_METHODS.DAEMON_SESSION_HANDOFF_CAPABILITY_V2_GET, {}),
            startSource,
            prepareTarget: async (payload) => await targetRpc(RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_V2, payload),
            getTargetPrepareResult: async (payload) => await targetRpc(
              RPC_METHODS.DAEMON_SESSION_HANDOFF_PREPARE_TARGET_RESULT_GET_V2,
              payload,
            ),
            getTargetStatus: async (payload) => await targetRpc(RPC_METHODS.DAEMON_SESSION_HANDOFF_STATUS_GET, payload),
            resumeTarget: async (payload) => await targetRpc(RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_RESUME_V2, payload),
            confirmTarget: async (payload) => await targetRpc(RPC_METHODS.DAEMON_SESSION_HANDOFF_TARGET_CONFIRM_V2, payload),
            bindTarget: async (input) => await bindSessionHandoffTarget({ credentials, ...input }),
            commitTarget: async (payload) => await targetRpc(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT_V2, payload),
            cleanupSource: async (payload) => await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_COMMIT, payload),
            abortTarget: async (payload) => await targetRpc(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT_V2, payload),
            abortSource: async (payload) => await rpcHandlerManager.invokeLocal(RPC_METHODS.DAEMON_SESSION_HANDOFF_ABORT, payload),
            wait: async (signal) => await waitForTrackedActionDelay(250, signal),
          });
          const admitted = await coordinator.admit({
            sessionId: request.sessionId,
            sourceMachineId: request.sourceMachineId,
            targetMachineId: request.targetMachineId,
            ...(request.targetPath ? { targetPath: request.targetPath } : {}),
            sessionStorageMode: request.sessionStorageMode,
            ...(request.targetSessionStorageMode ? { targetSessionStorageMode: request.targetSessionStorageMode } : {}),
            ...(request.workspaceTransfer ? { workspaceTransfer: request.workspaceTransfer } : {}),
            ...(connectedServices !== undefined ? { connectedServices } : {}),
          });
          return await admitted.execute(context);
        },
      }),
    } : {}),
    ...(handlers.spawnSessionForHandoff ? { spawnSessionForHandoff: handlers.spawnSessionForHandoff } : {}),
    stopSessionForHandoff: async (sessionId) => {
      const isActive = await handlers.isSessionActive?.(sessionId) ?? false;
      if (!isActive) {
        return 'already_inactive';
      }
      return await stopSessionConfirmed(sessionId) ? 'stopped' : 'failed';
    },
    ...(handlers.loadLocalSessionMetadata ? { loadLocalSessionMetadata: handlers.loadLocalSessionMetadata } : {}),
    ...(handlers.machineTransferChannel ? { machineTransferChannel: handlers.machineTransferChannel } : {}),
    ...(handlers.directPeerTransfer ? { directPeerTransfer: handlers.directPeerTransfer } : {}),
  });

	  rpcHandlerManager.registerHandler(RPC_METHODS.SESSION_CONTINUE_WITH_REPLAY, async (raw: unknown) => {
    const parsed = SessionContinueWithReplayRpcParamsSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Invalid params',
      };
    }

    const {
      directory,
      agent,
      approvedNewDirectoryCreation,
      permissionMode,
      permissionModeUpdatedAt,
      modelId,
      modelUpdatedAt,
      replay,
    } = parsed.data;

    if (!isKnownAgentId(agent)) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Unknown agent id',
      };
    }

    const maxTextChars = parseEnvBoundedInt('HAPPIER_REPLAY_MAX_TEXT_CHARS', { min: 1, max: 50_000 }, null);

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_MISSING_ENCRYPTION_KEY,
        errorMessage: 'This daemon is not provisioned with dataKey credentials and cannot decrypt transcripts for replay.',
      };
    }

    const replayStrategy = (replay.strategy ?? 'recent_messages') === 'summary_plus_recent' ? 'summary_plus_recent' : 'recent_messages';
    const normalizedDirectory = normalizeSpawnSessionDirectory(directory, process.env);

    const recipe = await buildReplaySeededSpawnRecipe({
      credentials,
      cwd: normalizedDirectory,
      source: {
        sourceSessionId: replay.previousSessionId,
        forkPoint: { type: 'latest' },
      },
      providerHintAgentId: agent,
      strategy: replayStrategy,
      recentMessagesCount: replay.recentMessagesCount ?? 250,
      ...(typeof replay.maxSeedChars === 'number' ? { maxSeedChars: replay.maxSeedChars } : {}),
      candidateLimit: configuration.replaySeedCandidateLimit,
      ...(typeof maxTextChars === 'number' ? { maxTextChars } : {}),
      summaryRunner: replay.summaryRunner ?? null,
      ...(params.deps?.runReplaySummaryForDialog
        ? { deps: { runReplaySummaryForDialog: params.deps.runReplaySummaryForDialog } }
        : {}),
    });
    if (!recipe.ok) {
      return {
        type: 'error',
        errorCode: recipe.errorCode,
        errorMessage: recipe.errorMessage,
      };
    }

    const normalizedModelId = typeof modelId === 'string' && modelId.trim().length > 0 ? modelId : undefined;
    const normalizedPermissionMode =
      typeof permissionMode === 'string' && isPermissionMode(permissionMode) ? permissionMode : undefined;
    const normalizedPermissionModeUpdatedAt =
      normalizedPermissionMode && typeof permissionModeUpdatedAt === 'number' ? permissionModeUpdatedAt : undefined;
    logger.debug('[API MACHINE] Continuing session with replay', {
      directory: normalizedDirectory,
      agent,
      approvedNewDirectoryCreation,
      permissionMode: normalizedPermissionMode,
      permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
      modelId: normalizedModelId,
      modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
      previousSessionId: replay.previousSessionId,
      cutoffSeqInclusive: recipe.recipe.cutoffSeqInclusive,
      strategy: replay.strategy ?? 'recent_messages',
      recentMessagesCount: replay.recentMessagesCount ?? 250,
    });

    // This legacy ingress keeps its existing per-attempt retry identity.
    const creationTag = `replay:${replay.previousSessionId}:${recipe.recipe.cutoffSeqInclusive}:${randomUUID()}`;

    try {
      const created = await createSpawnedSession({
        credentials,
        directory: normalizedDirectory,
        backendTarget: { kind: 'builtInAgent', agentId: agent },
        ...(typeof approvedNewDirectoryCreation === 'boolean' ? { approvedNewDirectoryCreation } : {}),
        ...(normalizedPermissionMode ? { permissionMode: normalizedPermissionMode } : {}),
        ...(typeof normalizedPermissionModeUpdatedAt === 'number'
          ? { permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt }
          : {}),
        ...(normalizedModelId ? { modelId: normalizedModelId } : {}),
        ...(typeof modelUpdatedAt === 'number' ? { modelUpdatedAt } : {}),
        replaySeededCreation: {
          tag: creationTag,
          agentId: agent,
          metadata: recipe.recipe.metadata,
          sourceRecipe: {
            sourceSessionId: replay.previousSessionId,
            cutoffSeqInclusive: recipe.recipe.cutoffSeqInclusive,
          },
        },
        // This ingress runs inside the daemon; launch through the in-process
        // spawn handler rather than self-calling the control server over HTTP.
        directTransport: {
          spawn: async (request) => await spawnSession({
            directory: normalizedDirectory,
            backendTarget: { kind: 'builtInAgent', agentId: agent },
            approvedNewDirectoryCreation,
            existingSessionId: request.existingSessionId,
            permissionMode: normalizedPermissionMode,
            permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
            modelId: normalizedModelId,
            modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
          } satisfies SpawnSessionOptions),
        },
      });
      return { type: 'success', sessionId: created.sessionId };
    } catch (error) {
      if (isAuthenticationError(error)) throw error;
      const failure = readReplaySeededCreationFailure(error);
      if (failure.stage === 'spawn') {
        // The canonical creator already settled the orphaned row.
        return failure.spawnResult as SpawnSessionResult;
      }
      logger.debug('[API MACHINE] Failed to create replay-seeded session', {
        error: failure.errorMessage,
      });
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'Failed to create a new session for replay',
      };
    }
  });

  const executeSessionForkRpcUntracked = async (raw: unknown, signal?: AbortSignal): Promise<SessionForkRpcResult> => {
    throwIfTrackedActionAborted(signal);
    const parsed = SessionForkRpcParamsSchema.safeParse(raw);
    if (!parsed.success) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Invalid params',
      };
    }

    const { parentSessionId, forkPoint } = parsed.data;
    const requestedStrategy = typeof parsed.data.strategy === 'string' ? parsed.data.strategy : 'auto';

    if (forkPoint.type === 'seq') {
      const seq = typeof forkPoint.upToSeqInclusive === 'number' && Number.isFinite(forkPoint.upToSeqInclusive)
        ? Math.trunc(forkPoint.upToSeqInclusive)
        : NaN;
      if (!Number.isFinite(seq) || seq <= 0) {
        return {
          ok: false,
          errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
          errorMessage: 'Cannot fork from an uncommitted message (missing seq).',
        };
      }
    }

    const forkRequestId = readNonBlankOpaqueIdentifier(parsed.data.requestId) ?? '';
    const executeSessionFork = async (): Promise<SessionForkRpcResult> => {

    throwIfTrackedActionAborted(signal);

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Not authenticated',
      };
    }

    let parentSession: Awaited<ReturnType<typeof fetchSessionByIdCompat>> | null = null;
    try {
      parentSession = await fetchSessionByIdCompat({ token: credentials.token, sessionId: parentSessionId });
      throwIfTrackedActionAborted(signal);
    } catch (error) {
      if (isTrackedActionAbort(error)) throw error;
      if (isAuthenticationError(error)) throw error;
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: error instanceof Error ? error.message : 'Failed to load parent session',
      };
    }
    if (!parentSession) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Session not found',
      };
    }

    const parentMetadata = tryDecryptSessionMetadata({
      credentials,
      rawSession: parentSession,
    });
    if (!parentMetadata) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Unable to decrypt session metadata',
      };
    }

    const directory = typeof parentMetadata.path === 'string' && parentMetadata.path.trim().length > 0
      ? parentMetadata.path.trim()
      : '';
    if (!directory) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Session metadata missing path',
      };
    }
    const normalizedDirectory = normalizeSpawnSessionDirectory(directory, process.env);

    const unknownAgentId = '__unknown__' as CatalogAgentId;
    const agentRaw = inferAgentIdFromSessionMetadata(parentMetadata, unknownAgentId);
    if (agentRaw === unknownAgentId || !isKnownAgentId(agentRaw)) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Session metadata missing agent flavor',
      };
    }

    const openCodeParentAffinity =
      agentRaw === 'opencode'
        ? readOpenCodeSessionAffinityFromMetadata(parentMetadata)
        : null;
    const inheritedForkOverrides = resolveForkInheritedOverridesFromMetadata(parentMetadata, agentRaw);
    const connectedServiceForkLaunchContext = createConnectedServiceForkLaunchContext({
      inherited: inheritedForkOverrides,
    });
    const inheritedForkSpawnOverrides = {
      ...inheritedForkOverrides.spawn,
      ...connectedServiceForkLaunchContext.spawn,
    } satisfies Partial<SpawnSessionOptions>;
    const inheritedForkMetadataOverrides = {
      ...inheritedForkOverrides.metadata,
      ...connectedServiceForkLaunchContext.metadata,
    };

    const targetSeqInclusive = forkPoint.type === 'seq'
      ? forkPoint.upToSeqInclusive
      : (typeof (parentSession as any)?.seq === 'number' && Number.isFinite((parentSession as any).seq) ? Math.max(0, Math.floor((parentSession as any).seq)) : 0);

    // Branch-and-edit semantics: when the fork target is a user message, the child session should
    // start from the state *before* that user message, while restoring the message as an editable draft.
    // Providers with native fork support (e.g. OpenCode) still need the original user-message seq
    // to resolve vendor message ids correctly.
    const cutoffSeqInclusive = forkPoint.type === 'seq'
      ? (() => {
        // Default to inclusive cutoff; adjust to exclusive for user messages when detectable.
        return targetSeqInclusive;
      })()
      : targetSeqInclusive;

    const resolvedCutoff = forkPoint.type === 'seq'
      ? await resolveForkCutoffSeqInclusive({
        credentials,
        parentSessionId,
        parentRawSession: parentSession,
        targetSeqInclusive,
      }).catch((error) => {
        if (isAuthenticationError(error)) throw error;
        return null;
      })
      : null;

    const effectiveCutoffSeqInclusive =
      forkPoint.type === 'seq' && resolvedCutoff
        ? resolvedCutoff.cutoffSeqInclusive
        : cutoffSeqInclusive;

    // Spawn request coalescing dedupes identical spawn fingerprints within a short window. Forking must
    // be able to create multiple sessions quickly (e.g. multi-level fork chains), so provide a
    // fork-specific nonce to guarantee unique spawn keys without leaking extra env vars to the child.
    // The nonce is also per-strategy: spawnSession is idempotent by nonce, so a later strategy reusing
    // an earlier strategy's nonce would ack that earlier spawn instead of spawning its own child.
    //
    // With a caller attempt id this identity is DURABLE — the same request yields
    // the same value in a later process — so it is what both the spawn nonce and
    // the creation tag are built from. The cutoff is deliberately left out of it:
    // a `latest` retry can resolve a different head, and that must still be the
    // same attempt rather than a second child. Callers with no attempt identity
    // keep the content-plus-uuid form, which is per-attempt by construction.
    const forkAttemptIdentity = forkRequestId
      ? `fork:${parentSessionId}:${forkRequestId}`
      : `fork:${parentSessionId}:${effectiveCutoffSeqInclusive}:${randomUUID()}`;
    const baseSpawnNonce = forkAttemptIdentity;

    // Compensation for an ACCEPTED (pending) fork spawn whose resolution failed:
    // the child process may still register a session later; clean it up in the
    // background instead of leaving an orphan.
    const abandonAcceptedForkSpawnBestEffort = (input: Readonly<{
      spawnResult: SpawnSessionResult;
      reason: string;
    }>): void => {
      if (!resolveSpawnSessionByNonce) return;
      const normalized = normalizeDaemonSpawnSessionEnvelope(input.spawnResult) ?? input.spawnResult;
      if (normalized.type !== 'success' || normalized.sessionId) return;
      const spawnNonce = typeof normalized.spawnNonce === 'string' ? normalized.spawnNonce.trim() : '';
      if (!spawnNonce) return;
      abandonSpawnedSessionBestEffort({
        spawnNonce,
        reason: input.reason,
        resolveSpawnSessionByNonce,
        stopSession: stopSessionConfirmed,
        archiveSession: (sessionId) => archiveSessionBestEffort(credentials.token, sessionId),
      });
    };

    const maxTextChars = parseEnvBoundedInt('HAPPIER_REPLAY_MAX_TEXT_CHARS', { min: 1, max: 50_000 }, null);

    // `native` is the generic user intent the fork strategy modal sends. It
    // enables exactly the native attempts `auto` enables, in the same order.
    const genericNativeIntent = requestedStrategy === 'auto' || requestedStrategy === 'native';

    const shouldAttemptProviderNative =
      (genericNativeIntent || requestedStrategy === 'provider_native');

    if (shouldAttemptProviderNative) {
      try {
        const nativeFork = await dispatchProviderNativeFork({
          credentials,
          agentId: agentRaw,
          parentSessionId,
          parentRawSession: parentSession,
          parentMetadata,
          directory: normalizedDirectory,
          forkPoint: forkPoint.type === 'seq'
            ? { type: 'seq', upToSeqInclusive: targetSeqInclusive }
            : { type: 'latest' },
          targetSeqInclusive,
          ...(signal ? { signal } : {}),
        });
        throwIfTrackedActionAborted(signal);

        if (nativeFork) {
          const result = await spawnSession({
            directory: normalizedDirectory,
            backendTarget: { kind: 'builtInAgent', agentId: agentRaw },
            approvedNewDirectoryCreation: true,
            spawnNonce: `${baseSpawnNonce}:native`,
            ...nativeFork.spawn,
            ...inheritedForkSpawnOverrides,
          } satisfies SpawnSessionOptions);
          throwIfTrackedActionAborted(signal);

          // The provider-native fork already created a new vendor thread. Falling through to
          // another strategy here would orphan that thread (and any spawned child) while silently
          // returning a degraded replay session — surface spawn failures instead, for every
          // requested strategy including 'auto'.
          const resolvedSpawn = await awaitSpawnedSessionId({
            result,
            ...(resolveSpawnSessionByNonce ? { resolveSpawnSessionByNonce } : {}),
            // A provider-native fork has already mutated provider state. Keep
            // its child under daemon lifecycle custody until terminal nonce
            // evidence arrives; a generic 90-second deadline must not abandon it.
            timeoutMs: null,
            ...(signal ? { signal } : {}),
          });
          if (resolvedSpawn.type !== 'success') {
            abandonAcceptedForkSpawnBestEffort({
              spawnResult: result,
              reason: `provider_native fork resolution failed: ${resolvedSpawn.errorCode}`,
            });
            return {
              ok: false,
              errorCode: resolvedSpawn.errorCode,
              errorMessage: resolvedSpawn.errorMessage,
            };
          }

          {
            const childSessionId = resolvedSpawn.sessionId;
            if (childSessionId === parentSessionId) {
              return { ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Fork spawn returned parent session id' };
            }
            try {
              const childRaw = await fetchForkChildSessionOrThrow({
                token: credentials.token,
                sessionId: childSessionId,
                ...(signal ? { signal } : {}),
              });
              await updateSessionMetadataWithRetry({
                token: credentials.token,
                credentials,
                sessionId: childSessionId,
                rawSession: childRaw,
                updater: (metadata) => ({
                  ...metadata,
                  ...inheritedForkMetadataOverrides,
                  ...nativeFork.metadata,
                  ...connectedServiceForkLaunchContext.metadata,
                  forkV1: {
                    v: 1,
                    parentSessionId,
                    parentCutoffSeqInclusive: forkRequestId
                      ? resolveEstablishedForkLineageCutoff({
                        metadata,
                        parentSessionId,
                        requestId: forkRequestId,
                        fallbackCutoffSeqInclusive: effectiveCutoffSeqInclusive,
                      })
                      : effectiveCutoffSeqInclusive,
                    createdAtMs: Date.now(),
                    strategy: 'provider_native',
                    ...(forkRequestId ? { requestId: forkRequestId } : {}),
                    providerHint: nativeFork.providerHint,
                  },
                }),
                maxAttempts: 6,
              });
            } catch (error) {
              if (isTrackedActionAbort(error)) throw error;
              if (isAuthenticationError(error)) throw error;
              await cleanupForkChildBestEffort(stopSessionConfirmed, childSessionId);
              await archiveSessionBestEffort(credentials.token, childSessionId);
              return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: error instanceof Error ? error.message : 'Failed to load forked child session metadata',
              };
            }
            return { ok: true, childSessionId };
          }
        }
      } catch (error) {
        if (isTrackedActionAbort(error)) throw error;
        if (isAuthenticationError(error)) throw error;
        if (isProviderNativeForkIndeterminateError(error)) {
          return {
            ok: false,
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: error.message,
          };
        }
        if (isProviderNativeForkFailedBeforeDispatchError(error)) {
          return {
            ok: false,
            errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
            errorMessage: error.message,
          };
        }
        // `null` is the provider-native handler's only unsupported outcome.
        // A thrown error is a failed attempt and must never silently fall
        // through to another effectful fork strategy.
        return {
          ok: false,
          errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
          errorMessage: error instanceof Error ? error.message : 'Provider-native fork failed',
        };
      }
    }

    const shouldAttemptAcpForkLatest =
      (genericNativeIntent || requestedStrategy === 'acp_fork_latest') &&
      (forkPoint.type === 'latest') &&
      isAcpForkEligibleForProvider({ providerId: agentRaw, metadata: parentMetadata });

    if (shouldAttemptAcpForkLatest) {
      // Best-effort ACP fork: only applies when the parent session can be resumed as an ACP session.
      // If unsupported, fall back to replay fork below.
      let acpForkCommitted = false;
      try {
        const vendorSessionIdRaw = resolveVendorResumeIdFromSessionMetadata(agentRaw as any, parentMetadata) ?? '';

        if (vendorSessionIdRaw) {
          const { createCatalogAcpBackend } = await import('@/agent/acp/createCatalogAcpBackend');
          const created = await createCatalogAcpBackend(agentRaw as any, {
            cwd: normalizedDirectory,
            mcpServers: {},
            permissionHandler: {
              handleToolCall: async () => ({ decision: 'denied' as const }),
            },
          } as any);

          try {
            if (typeof created.backend.loadSession === 'function' && typeof (created.backend as any).forkSession === 'function') {
              await created.backend.loadSession(vendorSessionIdRaw as any);
              throwIfTrackedActionAborted(signal);
              const forked = await (created.backend as any).forkSession({
                sessionId: vendorSessionIdRaw,
              });
              throwIfTrackedActionAborted(signal);
              const forkedSessionId = typeof forked?.sessionId === 'string' ? String(forked.sessionId).trim() : '';
              if (forkedSessionId) {
                acpForkCommitted = true;
                const acpForkContinuation = await getAcpForkContinuationHandler(agentRaw);
                const continuationShape = acpForkContinuation
                  ? await acpForkContinuation({
                    agentId: agentRaw,
                    parentMetadata,
                    vendorSessionId: forkedSessionId,
                  })
                  : null;

                const result = await spawnSession({
                  directory: normalizedDirectory,
                  backendTarget: { kind: 'builtInAgent', agentId: agentRaw },
                  approvedNewDirectoryCreation: true,
                  spawnNonce: `${baseSpawnNonce}:acp`,
                  resume: forkedSessionId,
                  ...(continuationShape?.spawn ?? {}),
                  ...inheritedForkSpawnOverrides,
                } satisfies SpawnSessionOptions);
                throwIfTrackedActionAborted(signal);

                // The ACP fork already created a forked vendor session; degrading to replay after a
                // spawn failure would orphan it. Resolve pending accept-then-async spawns by nonce
                // and surface failures for every requested strategy including 'auto'.
                const resolvedSpawn = await awaitSpawnedSessionId({
                  result,
                  ...(resolveSpawnSessionByNonce ? { resolveSpawnSessionByNonce } : {}),
                  // ACP session/fork has the same provider-owned completion
                  // custody as provider-native fork above.
                  timeoutMs: null,
                  ...(signal ? { signal } : {}),
                });
                if (resolvedSpawn.type !== 'success') {
                  abandonAcceptedForkSpawnBestEffort({
                    spawnResult: result,
                    reason: `acp_fork_latest fork resolution failed: ${resolvedSpawn.errorCode}`,
                  });
                  return {
                    ok: false,
                    errorCode: resolvedSpawn.errorCode,
                    errorMessage: resolvedSpawn.errorMessage,
                  };
                }

                {
                  const childSessionId = resolvedSpawn.sessionId;
                  if (childSessionId === parentSessionId) {
                    return { ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Fork spawn returned parent session id' };
                  }
                  try {
                    const childRaw = await fetchForkChildSessionOrThrow({
                      token: credentials.token,
                      sessionId: childSessionId,
                      ...(signal ? { signal } : {}),
                    });
                    await updateSessionMetadataWithRetry({
                      token: credentials.token,
                      credentials,
                      sessionId: childSessionId,
                      rawSession: childRaw,
                      updater: (metadata) => ({
                        ...metadata,
                        ...inheritedForkMetadataOverrides,
                        ...(continuationShape?.metadata ?? {}),
                        ...connectedServiceForkLaunchContext.metadata,
                        forkV1: {
                          v: 1,
                          parentSessionId,
                          parentCutoffSeqInclusive: forkRequestId
                            ? resolveEstablishedForkLineageCutoff({
                              metadata,
                              parentSessionId,
                              requestId: forkRequestId,
                              fallbackCutoffSeqInclusive: effectiveCutoffSeqInclusive,
                            })
                            : effectiveCutoffSeqInclusive,
                          createdAtMs: Date.now(),
                          strategy: 'acp_fork_latest',
                          ...(forkRequestId ? { requestId: forkRequestId } : {}),
                          providerHint: continuationShape?.providerHint ?? {
                            providerId: agentRaw,
                            vendorSessionId: forkedSessionId,
                          },
                        },
                      }),
                        maxAttempts: 6,
                      });
                  } catch (error) {
                    if (isTrackedActionAbort(error)) throw error;
                    if (isAuthenticationError(error)) throw error;
                    await cleanupForkChildBestEffort(stopSessionConfirmed, childSessionId);
                    await archiveSessionBestEffort(credentials.token, childSessionId);
                    return {
                      ok: false,
                      errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                      errorMessage: error instanceof Error ? error.message : 'Failed to load forked child session metadata',
                    };
                  }
                  return { ok: true, childSessionId };
                }
              }
            }
          } finally {
            await created.backend.dispose().catch(() => {});
          }
        }
      } catch (error) {
        if (isTrackedActionAbort(error)) throw error;
        if (isAuthenticationError(error)) throw error;
        // Once the ACP fork committed a forked vendor session, falling back to
        // replay would orphan it — surface the failure instead.
        if (requestedStrategy === 'acp_fork_latest' || acpForkCommitted) {
          return {
            ok: false,
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: error instanceof Error ? error.message : 'ACP fork failed',
          };
        }
        // Not committed: ignore and fall back to replay fork below.
      }
    }

    if (requestedStrategy !== 'auto' && requestedStrategy !== 'replay') {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Requested fork strategy is not supported',
      };
    }

    const replaySummaryRunner = parsed.data.replaySummaryRunner;

    const recipe = await buildReplaySeededSpawnRecipe({
      credentials,
      cwd: normalizedDirectory,
      source: {
        sourceSessionId: parentSessionId,
        // "Latest" is resolved ONCE, by this lifecycle, and this is that
        // answer. Leaving the retrieval to re-resolve it made the child's
        // CONTENT and its recorded LINEAGE answer to two different reads of
        // the same live parent: a row committed between them entered the seed
        // while the boundary still named the admitted cutoff.
        forkPoint: { type: 'seq', upToSeqInclusive: effectiveCutoffSeqInclusive },
      },
      providerHintAgentId: agentRaw,
      // Persisted lineage keeps naming the exact fork point this lifecycle
      // already admitted, which for a `latest` fork is not the cutoff seed
      // retrieval resolves for itself.
      lineageCutoffSeqInclusive: effectiveCutoffSeqInclusive,
      requestId: forkRequestId || null,
      strategy: replaySummaryRunner ? 'summary_plus_recent' : 'recent_messages',
      // No count bound: the seed is bounded by CHARACTERS. Passing the page-size
      // knob here as a message count is what capped the window at 500 turns in
      // front of a 120k-character budget.
      recentMessagesCount: null,
      ...(typeof parsed.data.replayMaxSeedChars === 'number'
        ? { maxSeedChars: parsed.data.replayMaxSeedChars }
        : {}),
      candidateLimit: configuration.replaySeedCandidateLimit,
      ...(typeof maxTextChars === 'number' ? { maxTextChars } : {}),
      summaryRunner: replaySummaryRunner ?? null,
      ...(params.deps?.runReplaySummaryForDialog
        ? { deps: { runReplaySummaryForDialog: params.deps.runReplaySummaryForDialog } }
        : {}),
      extraMetadata: {
        ...inheritedForkMetadataOverrides,
        ...(agentRaw === 'opencode'
          ? applyOpenCodeSessionAffinityMetadata({
            backendMode: openCodeParentAffinity?.backendMode ?? 'server',
            serverBaseUrl: openCodeParentAffinity?.serverBaseUrl ?? null,
            serverBaseUrlExplicit: openCodeParentAffinity?.serverBaseUrlExplicit ?? false,
          })
          : {}),
      },
    });
    throwIfTrackedActionAborted(signal);
    if (!recipe.ok) {
      return {
        ok: false,
        errorCode: recipe.errorCode,
        errorMessage: recipe.errorMessage,
      };
    }

    // The row tag IS the attempt identity, not a separate random one. Diverging
    // the two meant a retry acked the first attempt's spawn by nonce while asking
    // the server for a brand-new row under a fresh tag.
    const creationTag = forkAttemptIdentity;

    let childSessionId: string;
    try {
      const created = await createSpawnedSession({
        credentials,
        directory: normalizedDirectory,
        backendTarget: { kind: 'builtInAgent', agentId: agentRaw },
        approvedNewDirectoryCreation: true,
        spawnNonce: `${baseSpawnNonce}:replay`,
        replaySeededCreation: {
          tag: creationTag,
          agentId: agentRaw,
          metadata: recipe.recipe.metadata,
          sourceRecipe: {
            sourceSessionId: parentSessionId,
            cutoffSeqInclusive: effectiveCutoffSeqInclusive,
          },
        },
        connectedServiceChildLaunch: connectedServiceForkLaunchContext,
        // In-daemon ingress: launch through the in-process spawn handler and
        // merge this ingress's own spawn options here.
        directTransport: {
          spawn: async (request) => await spawnSession({
            directory: normalizedDirectory,
            backendTarget: { kind: 'builtInAgent', agentId: agentRaw },
            approvedNewDirectoryCreation: true,
            spawnNonce: `${baseSpawnNonce}:replay`,
            existingSessionId: request.existingSessionId,
            ...(agentRaw === 'opencode'
              ? {
                environmentVariables: buildOpenCodeSessionEnvironmentVariables({
                  backendMode: openCodeParentAffinity?.backendMode ?? 'server',
                  serverBaseUrl: openCodeParentAffinity?.serverBaseUrl ?? null,
                  serverBaseUrlExplicit: openCodeParentAffinity?.serverBaseUrlExplicit ?? false,
                }),
              }
              : {}),
            ...inheritedForkSpawnOverrides,
          } satisfies SpawnSessionOptions),
        },
        ...(signal ? { signal } : {}),
      });
      childSessionId = created.sessionId;
    } catch (error) {
      if (isTrackedActionAbort(error)) throw error;
      if (isAuthenticationError(error)) throw error;
      const failure = readReplaySeededCreationFailure(error);
      if (failure.stage === 'spawn') {
        // The canonical creator already settled the orphaned row; this ingress
        // keeps reporting the launch envelope exactly as it always has.
        return {
          ok: false,
          errorCode: (failure.spawnResponse as any)?.errorCode ?? SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
          errorMessage: (failure.spawnResponse as any)?.errorMessage ?? 'Failed to spawn fork session',
        };
      }
      logger.debug('[API MACHINE] Failed to create fork session for replay', {
        error: failure.errorMessage,
      });
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'Failed to create fork session',
      };
    }

    if (childSessionId === parentSessionId) {
      return { ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Fork spawn returned parent session id' };
    }

    return { ok: true, childSessionId };

    };

    if (!forkRequestId) {
      return await executeSessionFork();
    }
    const forkRequestKey = `${parsed.data.parentSessionId}:${forkRequestId}`;
    const running = inFlightSessionForks.get(forkRequestKey);
    if (running) return await running;

    const forkPromise = executeSessionFork();
    inFlightSessionForks.set(forkRequestKey, forkPromise);
    try {
      return await forkPromise;
    } finally {
      if (inFlightSessionForks.get(forkRequestKey) === forkPromise) {
        inFlightSessionForks.delete(forkRequestKey);
      }
    }
  };
  rpcHandlerManager.registerHandler(RPC_METHODS.SESSION_FORK, async (raw: unknown) => {
    const parsed = SessionForkRpcParamsSchema.safeParse(raw);
    const requestId = parsed.success ? readNonBlankOpaqueIdentifier(parsed.data.requestId) : null;
    if (!actionOperationRuntime || !parsed.success || !requestId) {
      return await executeSessionForkRpcUntracked(raw);
    }
    const scope = await actionOperationRuntime.getScope();
    return await actionOperationRuntime.runner.executeHistorical({
      request: {
        actionId: 'session.fork',
        input: parsed.data,
        requestId,
        scope: { sessionId: parsed.data.parentSessionId },
      },
      scope,
      title: getActionSpec('session.fork').title,
      cancellation: 'supported',
      scopeSessionId: parsed.data.parentSessionId,
      domainRef: projectCoreActionOperationDomainRef('session.fork', requestId, parsed.data),
      execute: async ({ signal }) => await executeSessionForkRpcUntracked(parsed.data, signal),
      projectResult: (result) => result.ok
        ? { ok: true, result }
        : { ok: false, errorCode: result.errorCode, error: result.errorMessage },
    });
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST, async () => {
    const markers = await listExecutionRunMarkers();

    let processIndex = new Map<number, DaemonExecutionRunProcessInfo>();
    try {
      const processes = await listProcessSnapshot();
	      processIndex = new Map(
	        processes.map((proc) => [
	          proc.pid,
	          {
	            pid: proc.pid,
	            name: typeof proc.name === 'string' ? proc.name : undefined,
	            cpu: typeof (proc as any).cpu === 'number' ? (proc as any).cpu : undefined,
	            memory: typeof (proc as any).memory === 'number' ? (proc as any).memory : undefined,
	          },
	        ]),
	      );
    } catch {
      // best-effort; omit process stats if ps-list fails
    }

    const runs: DaemonExecutionRunEntry[] = markers.map((marker) => {
      const process = processIndex.get(marker.pid);
      return process ? { ...marker, process } : marker;
    });

    return { runs };
  });

  // Register stop session handler
  rpcHandlerManager.registerHandler(RPC_METHODS.STOP_SESSION, async (params: any) => {
    const { sessionId } = params || {};

    if (!sessionId) {
      throw new Error('Session ID is required');
    }

    const result = normalizeMachineStopSessionResult(await stopSession(sessionId));
    logger.debug(`[API MACHINE] Stop session ${sessionId}: ${result.status}`);
    return result;
  });

  // Same-Session cross-Agent continuation.
  //
  // Both operations live on the DAEMON machine RPC and nowhere else. The
  // session-process registrar (`registerSessionHandlers`) cannot own them: the
  // transition stops the very runtime that would be handling the call, and
  // inspection must answer for an inactive Session that has no runtime at all.
  // Registering them in both places would create two decision-makers for one
  // operation, one of which cannot survive its own effect.
  rpcHandlerManager.registerHandler(RPC_METHODS.SESSION_AGENT_TRANSITION, async (raw: unknown) => {
    // Both rejections here happen BEFORE the coordinator is dispatched, so
    // nothing addressed the Session. They are built through the single arm
    // owner rather than as literals, so this handler cannot drift into naming
    // an arm the coordinator's effect stages forbid.
    const parsed = SessionAgentTransitionRequestV1Schema.safeParse(raw);
    if (!parsed.success) {
      return rejectUndispatchedSessionAgentTransition('unsupported_operation');
    }
    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
      return rejectUndispatchedSessionAgentTransition('forbidden');
    }
    return await runSessionAgentTransition({ credentials, request: parsed.data });
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.SESSION_CONTINUATION_INSPECT, async (raw: unknown) => {
    const parsed = SessionContinuationInspectionRequestV1Schema.safeParse(raw);
    if (!parsed.success) {
      return { type: 'unavailable', reason: 'operation_unavailable' };
    }
    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
      return { type: 'unavailable', reason: 'unsupported_session' };
    }
    return await inspectSessionContinuation({ credentials, request: parsed.data });
  });

  rpcHandlerManager.registerHandler(
    RPC_METHODS.SESSION_AGENT_TRANSITION_BRIEF_PREVIEW,
    async (raw: unknown) => {
      const parsed = SessionAgentTransitionBriefPreviewRequestV1Schema.safeParse(raw);
      if (!parsed.success) {
        return { type: 'unavailable', reason: 'unsupported_session' };
      }
      const credentials = await readCredentials().catch(() => null);
      // A process with no credentials cannot read the Session at all, which is
      // the same standing as a Session this machine cannot address. It is
      // deliberately NOT `empty`: reporting "nothing was carried over" because
      // we could not look is the one answer this surface must never give.
      if (!credentials) {
        return { type: 'unavailable', reason: 'unsupported_session' };
      }
      return await previewSessionAgentTransitionBrief({ credentials, request: parsed.data });
    },
  );

  // Register stop daemon handler
  rpcHandlerManager.registerHandler(RPC_METHODS.STOP_DAEMON, () => {
    logger.debug('[API MACHINE] Received stop-daemon RPC request');

    // Trigger shutdown callback after a delay
    setTimeout(() => {
      logger.debug('[API MACHINE] Initiating daemon shutdown from RPC');
      requestShutdown();
    }, 100);

    return { message: 'Daemon stop request acknowledged, starting shutdown sequence...' };
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.SESSION_LOG_TAIL, async (params: any) => {
    const maxBytes = typeof params?.maxBytes === 'number' && Number.isFinite(params.maxBytes)
      ? Math.min(Math.max(Math.floor(params.maxBytes), 1024), 1_000_000)
      : 200_000;
    const path = typeof params?.path === 'string' && params.path.trim().length > 0 ? params.path.trim() : '';
    if (!path) {
      return {
        success: false,
        error: 'Session log path is required',
      };
    }
    if (!path.toLowerCase().endsWith('.log')) {
      return {
        success: false,
        error: 'Session log path must point to a .log file',
      };
    }

    const canonicalRequestedPath = await toCanonicalPath(path);
    if (!canonicalRequestedPath) {
      return {
        success: false,
        error: 'Session log path is unavailable on this machine',
      };
    }

    const canonicalHappyHomeDir = await toCanonicalPath(resolve(configuration.happyHomeDir));
    if (!canonicalHappyHomeDir) {
      return {
        success: false,
        error: 'Happy home directory is unavailable for log validation',
      };
    }

    const allowedRoots = [
      resolve(canonicalHappyHomeDir, 'logs'),
      resolve(canonicalHappyHomeDir, 'stacks'),
    ];
    if (!allowedRoots.some((dir) => isPathInside(canonicalRequestedPath, dir))) {
      return {
        success: false,
        error: 'Requested log path is outside allowed Happier directories',
      };
    }

    try {
      const fileStat = await stat(canonicalRequestedPath);
      const tail = await readBugReportLogTail(canonicalRequestedPath, maxBytes);
      return {
        success: true,
        path: canonicalRequestedPath,
        tail,
        truncated: fileStat.size > maxBytes,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.BUGREPORT_COLLECT_DIAGNOSTICS, async () => {
    return await collectBugReportMachineDiagnosticsSnapshotForBugReport();
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.BUGREPORT_GET_LOG_TAIL, async (params: any) => {
    const maxBytes = typeof params?.maxBytes === 'number' && Number.isFinite(params.maxBytes)
      ? Math.min(Math.max(Math.floor(params.maxBytes), 1024), 1_000_000)
      : 200_000;
    const path = typeof params?.path === 'string' && params.path.trim().length > 0 ? params.path.trim() : '';
    const diagnostics = await collectBugReportMachineDiagnosticsSnapshotForBugReport();
    const allowedPaths = new Set<string>();
    if (diagnostics.daemonState?.daemonLogPath) {
      allowedPaths.add(diagnostics.daemonState.daemonLogPath.trim());
    }
    for (const entry of diagnostics.daemonLogs) {
      if (typeof entry.path === 'string' && entry.path.trim().length > 0) {
        allowedPaths.add(entry.path.trim());
      }
    }
    for (const entry of diagnostics.stackContext?.logCandidates ?? []) {
      if (typeof entry === 'string' && entry.trim().length > 0) {
        allowedPaths.add(entry.trim());
      }
    }

    const canonicalAllowedPaths = new Set<string>();
    for (const candidatePath of allowedPaths) {
      const canonicalPath = await toCanonicalPath(candidatePath);
      if (canonicalPath) {
        canonicalAllowedPaths.add(canonicalPath);
      }
    }

    let canonicalRequestedPath: string | null = null;
    if (path) {
      canonicalRequestedPath = await toCanonicalPath(path);
      if (!canonicalRequestedPath || !canonicalAllowedPaths.has(canonicalRequestedPath)) {
        return {
          ok: false,
          error: 'Requested log path is not allowed for bug report diagnostics',
        };
      }
    }

    const fallbackPath = Array.from(canonicalAllowedPaths)[0] ?? null;
    const targetPath = canonicalRequestedPath ?? fallbackPath;
    if (!targetPath) {
      return {
        ok: false,
        error: 'No daemon log path available',
      };
    }

    try {
      const tail = await readBugReportLogTail(targetPath, maxBytes);
      return {
        ok: true,
        path: targetPath,
        tail,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.BUGREPORT_UPLOAD_ARTIFACT, async (params: any) => {
    // Upload is intentionally delegated to UI/service clients via pre-signed URLs.
    // Keep the RPC for capability negotiation and future transport optimizations.
    return {
      ok: false,
      error: 'Daemon-side upload is not enabled; upload via report service pre-signed URL from UI.',
      uploadUrl: typeof params?.uploadUrl === 'string' ? params.uploadUrl : null,
    };
  });

  return {
    promptAssetTransfers,
    promptRegistryTransfers,
    dispose: async () => {
      await Promise.all([
        promptAssetTransfers.dispose(),
        promptRegistryTransfers.dispose(),
      ]);
    },
  };
}
