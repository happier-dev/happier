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
  PendingFirstInputV1Schema,
  RestartAllSessionRunnersRequestV1Schema,
  RestartSessionRunnerRequestV1Schema,
  SessionConnectedServiceAuthSwitchRpcParamsSchema,
  SessionContinueWithReplayRpcParamsSchema,
  SessionForkRpcParamsSchema,
  SessionInitialGoalRequestV1Schema,
  SessionMcpSelectionV1Schema,
  SessionRunnerStatusGetRequestV1Schema,
  AsyncTtlCache,
  type ConnectedServiceBindingsV1,
  type SessionForkRpcResult,
} from '@happier-dev/protocol';
import { isPermissionMode } from '@/api/types';
import { CATALOG_AGENT_IDS } from '@/backends/types';
import type { CatalogAgentId } from '@/backends/types';
import { readCredentials } from '@/persistence';
import { createReplaySeededSession } from '@/session/replay/createReplaySeededSession';
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
import { resolveReplaySeedDraft } from '@/session/replay/resolveReplaySeedDraft';
import type {
  AccountPetCreateRequestV1,
  AccountPetCreateResponseV1,
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
import { dispatchProviderNativeFork } from '@/session/fork/providerNativeForkDispatch';
import { abandonSpawnedSessionBestEffort, awaitSpawnedSessionId, normalizeDaemonSpawnSessionEnvelope } from '@/session/services/awaitSpawnedSessionId';
import { createPromptAssetAdapterRegistry } from '@/promptAssets/createPromptAssetAdapterRegistry';
import { createPromptRegistryAdapterRegistry } from '@/promptRegistries/createPromptRegistryAdapterRegistry';
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

// Fork requests are idempotent per caller-supplied requestId: transport-level
// retries (machine RPC ack timeouts) must join the in-flight fork instead of
// committing a second provider-side fork. Results are cached briefly so a
// late retry replays the same outcome.
const SESSION_FORK_RESULT_SUCCESS_TTL_MS = 10 * 60_000;
const SESSION_FORK_RESULT_FAILURE_TTL_MS = 60_000;
const sessionForkRequestCache = new AsyncTtlCache<SessionForkRpcResult>({
  successTtlMs: SESSION_FORK_RESULT_SUCCESS_TTL_MS,
  errorTtlMs: SESSION_FORK_RESULT_FAILURE_TTL_MS,
});


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
  createAccountPet?: (request: AccountPetCreateRequestV1) => Promise<AccountPetCreateResponseV1>;
  resumeInactiveSessionWhenUsageLimitReady?: ResumeInactiveSessionWhenUsageLimitReady;
  scheduleInactiveSessionUsageLimitRecoveryCheck?: ScheduleInactiveSessionUsageLimitRecoveryCheck;
  cancelInactiveSessionUsageLimitRecoveryCheck?: CancelInactiveSessionUsageLimitRecoveryCheck;
  cancelConnectedServiceRuntimeAuthRecovery?: CancelConnectedServiceRuntimeAuthRecovery;
  notifyConnectedServiceRuntimeAuthFailure?: NotifyConnectedServiceRuntimeAuthFailure;
  retryTemporaryThrottleNow?: RetryTemporaryThrottleNow;
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
}>): Promise<NonNullable<Awaited<ReturnType<typeof fetchSessionByIdCompat>>>> {
  const attempts = typeof params.attempts === 'number' && params.attempts >= 1 ? Math.floor(params.attempts) : 6;
  const delayMs = typeof params.delayMs === 'number' && params.delayMs >= 0 ? Math.floor(params.delayMs) : 250;
  let lastError: unknown = null;

  for (let index = 0; index < attempts; index += 1) {
    try {
      const raw = await fetchSessionByIdCompat({ token: params.token, sessionId: params.sessionId });
      if (raw) return raw;
      lastError = new Error('Session fetch returned empty response');
    } catch (error) {
      if (isAuthenticationError(error)) throw error;
      lastError = error;
    }
    if (index < attempts - 1 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Failed to load forked child session ${params.sessionId}`);
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
  const { spawnSession, stopSession, requestShutdown, resolveSpawnSessionByNonce } = handlers;
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
      requestOrigin,
    } = params || {};

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
        return result;

      case 'requestToApproveDirectoryCreation':
        logger.debug(`[API MACHINE] Requesting directory creation approval for: ${result.directory}`);
        return { type: 'requestToApproveDirectoryCreation', directory: result.directory };

      case 'error':
        return result;
    }
  };

  rpcHandlerManager.registerHandler(
    RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE,
    handleSpawnHappySession,
  );
  rpcHandlerManager.registerHandler(RPC_METHODS.SPAWN_HAPPY_SESSION, async (params: any) => {
    const result = await handleSpawnHappySession(params);
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

    const resolvedSeed = await resolveReplaySeedDraft({
      credentials,
      cwd: normalizedDirectory,
      source: {
        kind: 'fork_chain',
        previousSessionId: replay.previousSessionId,
      },
      strategy: replayStrategy,
      recentMessagesCount: replay.recentMessagesCount ?? 250,
      maxSeedChars: typeof replay.maxSeedChars === 'number' ? replay.maxSeedChars : configuration.replaySeedMaxChars,
      candidateLimit: configuration.replaySeedCandidateLimit,
      maxTextChars: maxTextChars ?? undefined,
      summaryRunner: replay.summaryRunner ?? null,
      deps: params.deps?.runReplaySummaryForDialog
        ? { runReplaySummaryForDialog: params.deps.runReplaySummaryForDialog }
        : undefined,
    });
    if (!resolvedSeed) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Unable to hydrate replay dialog from transcript.',
      };
    }
    const seedDraft = resolvedSeed.seedDraft;

    if (!seedDraft.trim()) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Replay seed draft is empty',
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
      dialogCount: resolvedSeed.dialog.length,
      strategy: replay.strategy ?? 'recent_messages',
      recentMessagesCount: replay.recentMessagesCount ?? 250,
    });

    const nowMs = Date.now();
    const created = await (async () => {
      try {
        return await createReplaySeededSession({
          credentials,
          directory: normalizedDirectory,
          agentId: agent,
          tag: `replay:${replay.previousSessionId}:${resolvedSeed.sourceCutoffSeqInclusive}:${randomUUID()}`,
          metadata: {
            forkV1: {
              v: 1,
              parentSessionId: replay.previousSessionId,
              parentCutoffSeqInclusive: resolvedSeed.sourceCutoffSeqInclusive,
              createdAtMs: nowMs,
              strategy: 'replay',
              providerHint: { providerId: agent },
            },
            replaySeedV1: {
              v: 1,
              seedText: seedDraft,
              sourceSessionId: replay.previousSessionId,
              sourceCutoffSeqInclusive: resolvedSeed.sourceCutoffSeqInclusive,
              createdAtMs: nowMs,
            },
          },
        });
      } catch (error) {
        if (isAuthenticationError(error)) throw error;
        logger.debug('[API MACHINE] Failed to create replay-seeded session', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })();

    if (!created) {
      return {
        type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'Failed to create a new session for replay',
      };
    }

    const result = await spawnSession({
      directory: normalizedDirectory,
      backendTarget: { kind: 'builtInAgent', agentId: agent },
      approvedNewDirectoryCreation,
      existingSessionId: created.sessionId,
      permissionMode: normalizedPermissionMode,
      permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
      modelId: normalizedModelId,
      modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
    } satisfies SpawnSessionOptions);

    if (result.type === 'success') {
      return { type: 'success', sessionId: created.sessionId };
    }

    await archiveSessionBestEffort(credentials.token, created.sessionId);
    return result;
  });

  rpcHandlerManager.registerHandler(RPC_METHODS.SESSION_FORK, async (raw: unknown) => {
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
    } catch (error) {
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
    const baseSpawnNonce = `fork:${parentSessionId}:${effectiveCutoffSeqInclusive}:${forkRequestId || randomUUID()}`;

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

    const shouldAttemptProviderNative =
      (requestedStrategy === 'auto' || requestedStrategy === 'provider_native');

    if (shouldAttemptProviderNative) {
      let nativeForkCommitted = false;
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
        });

        if (nativeFork) {
          nativeForkCommitted = true;
          const result = await spawnSession({
            directory: normalizedDirectory,
            backendTarget: { kind: 'builtInAgent', agentId: agentRaw },
            approvedNewDirectoryCreation: true,
            spawnNonce: `${baseSpawnNonce}:native`,
            ...nativeFork.spawn,
            ...inheritedForkSpawnOverrides,
          } satisfies SpawnSessionOptions);

          // The provider-native fork already created a new vendor thread. Falling through to
          // another strategy here would orphan that thread (and any spawned child) while silently
          // returning a degraded replay session — surface spawn failures instead, for every
          // requested strategy including 'auto'.
          const resolvedSpawn = await awaitSpawnedSessionId({
            result,
            ...(resolveSpawnSessionByNonce ? { resolveSpawnSessionByNonce } : {}),
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
              const childRaw = await fetchForkChildSessionOrThrow({ token: credentials.token, sessionId: childSessionId });
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
                    parentCutoffSeqInclusive: effectiveCutoffSeqInclusive,
                    createdAtMs: Date.now(),
                    strategy: 'provider_native',
                    providerHint: nativeFork.providerHint,
                  },
                }),
                maxAttempts: 6,
              });
            } catch (error) {
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
        if (isAuthenticationError(error)) throw error;
        // Once the provider-side fork committed, falling through to another
        // strategy would orphan the forked vendor thread (and any spawned
        // child) — surface the failure for every requested strategy.
        if (requestedStrategy === 'provider_native' || nativeForkCommitted) {
          return {
            ok: false,
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: error instanceof Error ? error.message : 'Provider-native fork failed',
          };
        }
      }
    }

    const shouldAttemptAcpForkLatest =
      (requestedStrategy === 'auto' || requestedStrategy === 'acp_fork_latest') &&
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
              const forked = await (created.backend as any).forkSession({
                sessionId: vendorSessionIdRaw,
              });
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

                // The ACP fork already created a forked vendor session; degrading to replay after a
                // spawn failure would orphan it. Resolve pending accept-then-async spawns by nonce
                // and surface failures for every requested strategy including 'auto'.
                const resolvedSpawn = await awaitSpawnedSessionId({
                  result,
                  ...(resolveSpawnSessionByNonce ? { resolveSpawnSessionByNonce } : {}),
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
                    const childRaw = await fetchForkChildSessionOrThrow({ token: credentials.token, sessionId: childSessionId });
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
                          parentCutoffSeqInclusive: effectiveCutoffSeqInclusive,
                          createdAtMs: Date.now(),
                          strategy: 'acp_fork_latest',
                          providerHint: continuationShape?.providerHint ?? {
                            providerId: agentRaw,
                            vendorSessionId: forkedSessionId,
                          },
                        },
                      }),
                        maxAttempts: 6,
                      });
                  } catch (error) {
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

    const resolvedSeed = await resolveReplaySeedDraft({
      credentials,
      cwd: normalizedDirectory,
      source: {
        kind: 'fork_chain',
        previousSessionId: parentSessionId,
        ...(forkPoint.type === 'seq' ? { upToSeqInclusive: effectiveCutoffSeqInclusive } : {}),
      },
      strategy: replaySummaryRunner ? 'summary_plus_recent' : 'recent_messages',
      recentMessagesCount: configuration.replaySeedCandidateLimit,
      maxSeedChars: typeof parsed.data.replayMaxSeedChars === 'number' ? parsed.data.replayMaxSeedChars : configuration.replaySeedMaxChars,
      candidateLimit: configuration.replaySeedCandidateLimit,
      maxTextChars: maxTextChars ?? undefined,
      summaryRunner: replaySummaryRunner ?? null,
      deps: params.deps?.runReplaySummaryForDialog
        ? { runReplaySummaryForDialog: params.deps.runReplaySummaryForDialog }
        : undefined,
    });
    if (!resolvedSeed) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Unable to hydrate replay dialog from transcript.',
      };
    }
    const seedDraft = resolvedSeed.seedDraft;

    if (!seedDraft.trim()) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
        errorMessage: 'Replay seed draft is empty',
      };
    }

    const nowMs = Date.now();
    const created = await (async () => {
      try {
        return await createReplaySeededSession({
          credentials,
          directory: normalizedDirectory,
          agentId: agentRaw,
          tag: `fork:${parentSessionId}:${effectiveCutoffSeqInclusive}:${randomUUID()}`,
          metadata: {
            ...inheritedForkMetadataOverrides,
            ...(agentRaw === 'opencode'
              ? applyOpenCodeSessionAffinityMetadata({
                backendMode: openCodeParentAffinity?.backendMode ?? 'server',
                serverBaseUrl: openCodeParentAffinity?.serverBaseUrl ?? null,
                serverBaseUrlExplicit: openCodeParentAffinity?.serverBaseUrlExplicit ?? false,
              })
              : {}),
            forkV1: {
              v: 1,
              parentSessionId,
              parentCutoffSeqInclusive: effectiveCutoffSeqInclusive,
              createdAtMs: nowMs,
              strategy: 'replay',
              providerHint: { providerId: agentRaw },
            },
            replaySeedV1: {
              v: 1,
              seedText: seedDraft,
              sourceSessionId: parentSessionId,
              sourceCutoffSeqInclusive: effectiveCutoffSeqInclusive,
              createdAtMs: nowMs,
            },
          },
        });
      } catch (error) {
        if (isAuthenticationError(error)) throw error;
        logger.debug('[API MACHINE] Failed to create fork session for replay', {
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    })();

    if (!created) {
      return {
        ok: false,
        errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: 'Failed to create fork session',
      };
    }

    const spawnResult = await spawnSession({
      directory: normalizedDirectory,
      backendTarget: { kind: 'builtInAgent', agentId: agentRaw },
      approvedNewDirectoryCreation: true,
      spawnNonce: `${baseSpawnNonce}:replay`,
      existingSessionId: created.sessionId,
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
    } satisfies SpawnSessionOptions);

    if (spawnResult.type !== 'success') {
      await archiveSessionBestEffort(credentials.token, created.sessionId);
      return {
        ok: false,
        errorCode: (spawnResult as any)?.errorCode ?? SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
        errorMessage: (spawnResult as any)?.errorMessage ?? 'Failed to spawn fork session',
      };
    }

    if (created.sessionId === parentSessionId) {
      return { ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Fork spawn returned parent session id' };
    }

    return { ok: true, childSessionId: created.sessionId };

    };

    if (!forkRequestId) {
      return await executeSessionFork();
    }
    const forkRequestKey = `${parsed.data.parentSessionId}:${forkRequestId}`;
    return await sessionForkRequestCache.runDedupe(forkRequestKey, async () => {
      const cached = sessionForkRequestCache.get(forkRequestKey);
      if (cached?.kind === 'success' && sessionForkRequestCache.isFresh(cached)) {
        return cached.value;
      }
      const result = await executeSessionFork();
      sessionForkRequestCache.setSuccess(forkRequestKey, result, {
        ttlMs: result.ok === true ? SESSION_FORK_RESULT_SUCCESS_TTL_MS : SESSION_FORK_RESULT_FAILURE_TTL_MS,
      });
      return result;
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
