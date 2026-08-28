/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { isPidPresent, isPidProvablyAbsent } from '@happier-dev/cli-common/process';
import type { ActionExecuteResult } from '@happier-dev/protocol';
import { logger } from '@/ui/logger';
import {
  clearReplaceableDaemonLock,
  daemonStateMatchesOwner,
  inspectDaemonLockOwner,
  readDaemonLockOwnerIdentity,
  readDaemonLockPid,
  readDaemonState,
} from '@/persistence';
import {
  daemonProcessMatchesCurrentScope,
  isDaemonCommandForCurrentRuntimeRoot,
  isDaemonProcessForCurrentRuntimeRoot,
} from '@/daemon/ownership/daemonProcessScopeIdentity';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import { Metadata, type SessionCreationOutcome } from '@/api/types';
import { projectPath } from '@/projectPath';
import { readFileSync, statSync } from 'fs';
import { configuration } from '@/configuration';
import type { SpawnDaemonSessionRequest } from '@/rpc/handlers/spawnSessionOptionsContract';
import {
  FOREGROUND_AGENT_RUNTIME_ADMISSION_PATH,
  FOREGROUND_AGENT_RUNTIME_CLAIM_PATH,
  FOREGROUND_AGENT_RUNTIME_RELEASE_PATH,
  ForegroundAgentRuntimeAdmissionRequestV1Schema,
  ForegroundAgentRuntimeAdmissionResponseV1Schema,
  ForegroundAgentRuntimeClaimRequestV1Schema,
  ForegroundAgentRuntimeClaimResponseV1Schema,
  ForegroundAgentRuntimeReleaseRequestV1Schema,
  ForegroundAgentRuntimeReleaseResponseV1Schema,
  type ForegroundAgentRuntimeAdmissionRequestV1,
  type ForegroundAgentRuntimeAdmissionResponseV1,
  type ForegroundAgentRuntimeClaimRequestV1,
  type ForegroundAgentRuntimeClaimResponseV1,
  type ForegroundAgentRuntimeReleaseRequestV1,
} from './agentRuntime/foregroundAdmissionContract';
import {
  createProviderErrorV1,
  normalizeSpawnSessionNonceResolution,
  RestartAllSessionRunnersRequestV1Schema,
  RestartAllSessionRunnersResultV1Schema,
  RestartSessionRunnerRequestV1Schema,
  RestartSessionRunnerRequestV2Schema,
  RestartSessionRunnerResultV1Schema,
  SessionRunnerStatusGetRequestV1Schema,
  SessionRunnerRuntimeStateV1Schema,
  SessionRunnerRuntimeStatusV2Schema,
  type ConnectedServiceBindingsV1,
  type ConnectedAccountServiceKey,
  type ConnectedServiceId,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageSnapshotV1,
  type RestartAllSessionRunnersRequestV1,
  type RestartAllSessionRunnersResultV1,
  type RestartSessionRunnerRequestV1,
  type RestartSessionRunnerRequestV2,
  type RestartSessionRunnerResultV1,
  type SessionRunnerStatusGetRequestV1,
  type SessionRunnerRuntimeStateV1,
  type SessionRunnerRuntimeStatusV2,
  type SessionRunnerRestartModeV1,
  type SessionMetadataPublisherPreconditionV1,
  type SshTunnelEnsureRequest,
  type SshTunnelEnsureResponse,
  type SshTunnelListResponse,
  type SshTunnelMutationResponse,
  type SshTunnelProbeResponse,
  type SessionUsageLimitRecoveryResumePromptModeV1,
  type SpawnSessionNonceResolution,
} from '@happier-dev/protocol';
import {
  StopSessionResultSchema,
  type StopSessionResult,
} from './sessions/stopSessionContract';
import type {
  ProviderAccountUsageAdoptionV1,
} from './connectedServices/accountUsage/adoption';
import type {
  ConnectedServiceDaemonAuthBridgeRefreshResult,
} from './connectedServices/daemonAuthBridgeTypes';
import type {
  ConnectedServiceTurnLifecycleRequestBody,
  ConnectedServiceTurnLifecycleResult,
} from './connectedServices/connectedServiceTurnLifecycleContract';
import { deriveConnectedServiceRunMaterializeToken } from './connectedServices/runs/capabilityToken';
import {
  CONNECTED_SERVICE_RUN_MATERIALIZE_PATH,
  CONNECTED_SERVICE_RUN_GENERATION_CURRENT_PATH,
  CONNECTED_SERVICE_RUN_RELEASE_PATH,
  type ConnectedServiceRunMaterializeRequest,
  type ConnectedServiceRunReleaseRequest,
  type ConnectedServiceRunGenerationCurrentRequest,
  type ExecutionRunConnectedServicesRegistrationV1,
} from './connectedServices/runs/materializeContract';
import { resolveComparableCliVersion } from './resolveComparableCliVersion';
import { DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS } from './spawn/sessionWebhookTimeoutPolicy';
import type {
  PersistedTakeoverAdmissionPhase,
  TakeoverAdmissionMode,
} from './spawn/persistedTakeoverAdmission';
import { buildDaemonControlHttpHeaders } from './controlHttp';
import {
  PluginDevelopmentSourceRootReviewSchema,
  PluginInstallationReviewSchema,
  type PluginChangeDecision,
  type PluginChangeDecisionResult,
  type PluginChangeListResult,
  type PluginChangePendingReviewResult,
  type PluginChangeRequest,
  type PluginChangeRequestResult,
  type PluginChangeStatusRequest,
  type PluginChangeStatusResult,
  type PluginChangeTerminalResult,
  type PluginPendingChangeEntry,
} from '@/plugins/daemon/changeContract';
import {
  PLUGIN_ACTION_EXECUTE_PATH,
  PLUGIN_CATALOG_READ_PATH,
  PLUGIN_CHANGE_DECISION_PATH,
  PLUGIN_CHANGE_LIST_PATH,
  PLUGIN_CHANGE_REQUEST_PATH,
  PLUGIN_CHANGE_STATUS_PATH,
} from '@/plugins/daemon/controlRoutes';
import type { PluginActionExecutionAttempt } from '@/plugins/projection/actions/execute';
import {
  SIGNED_ROOT_ACTION_EXECUTE_PATH,
  type SignedRootActionExecuteRequest,
} from './externalActions/signedRootActionControl';
import type { PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';

export type DaemonControlRequestOptions = {
  timeoutMs?: number | null;
  signal?: AbortSignal;
  target?: Readonly<{
    pid: number;
    httpPort: number;
    controlToken?: string;
  }>;
};

type DaemonPostAuthScope = 'daemon-control' | 'connected-service-run-materialize';

type DaemonPostOptions = DaemonControlRequestOptions & {
  authScope?: DaemonPostAuthScope;
  authTokenOverride?: string;
};

const DEFAULT_DAEMON_HTTP_TIMEOUT_MS = 10_000;
const DEFAULT_DAEMON_SPAWN_HTTP_TIMEOUT_MS = DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS;
const DEFAULT_DAEMON_PING_TIMEOUT_MS = 3_000;
const DEFAULT_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS = 12_000;
const DEFAULT_DAEMON_SHUTDOWN_SPAWN_DRAIN_GRACE_MS = 10_000;
const DAEMON_STATE_FRESHNESS_GRACE_MS = 60_000;
const DAEMON_HTTP_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_HTTP_TIMEOUT';
const DAEMON_SPAWN_HTTP_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_SPAWN_HTTP_TIMEOUT';
const DAEMON_PING_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_PING_TIMEOUT_MS';
const DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS';
const DAEMON_SHUTDOWN_SPAWN_DRAIN_GRACE_ENV_KEY = 'HAPPIER_DAEMON_SHUTDOWN_SPAWN_DRAIN_GRACE_MS';
const EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_ENV_KEY = 'HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS';
const DEFAULT_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS = 120_000;

function serializeSpawnDaemonSessionRequestForLocalControl(
  request: SpawnDaemonSessionRequest,
): Record<string, unknown> {
  const backendTarget = request.backendTarget;
  if (
    backendTarget?.kind === 'backend'
    && backendTarget.sourceKind === 'built_in'
    && !backendTarget.configuredBackendId
  ) {
    return {
      ...request,
      backendTarget: {
        kind: 'builtInAgent',
        agentId: backendTarget.backendId,
      },
    };
  }
  return request as unknown as Record<string, unknown>;
}

function resolveDaemonStateFreshnessAgeMs(state: unknown): number | null {
  if (state && typeof state === 'object') {
    const lastHeartbeatAt = (state as any).lastHeartbeatAt;
    if (typeof lastHeartbeatAt === 'number' && Number.isFinite(lastHeartbeatAt)) {
      return Math.max(0, Date.now() - lastHeartbeatAt);
    }

    const startedAt = (state as any).startedAt;
    if (typeof startedAt === 'number' && Number.isFinite(startedAt)) {
      return Math.max(0, Date.now() - startedAt);
    }
  }

  // Fall back to file mtime if startedAt is missing; helps avoid deleting freshly written state.
  try {
    const stat = statSync(configuration.daemonStateFile);
    if (Number.isFinite(stat.mtimeMs)) {
      return Math.max(0, Date.now() - stat.mtimeMs);
    }
  } catch {
    // ignore
  }

  return null;
}

function resolvePositiveIntValue(
  raw: string | number | undefined,
  fallback: number,
  bounds: { min: number; max: number },
): number {
  if (raw === undefined) return fallback;
  const parsed =
    typeof raw === 'number'
      ? raw
      : raw.trim().length > 0
        ? Number.parseInt(raw, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(bounds.max, Math.max(bounds.min, Math.trunc(parsed)));
}

function resolveDaemonControlTimeoutMs(
  path: string,
  options: DaemonControlRequestOptions,
): number | null {
  if (options.timeoutMs === null) {
    return null;
  }
  if (options.timeoutMs !== undefined) {
    return resolvePositiveIntValue(options.timeoutMs, DEFAULT_DAEMON_HTTP_TIMEOUT_MS, {
      min: 100,
      max: path === CONNECTED_SERVICE_RUN_MATERIALIZE_PATH ? 600_000 : 300_000,
    });
  }

  if (path === '/spawn-session') {
    const rawSpawnTimeout = process.env[DAEMON_SPAWN_HTTP_TIMEOUT_ENV_KEY];
    if (rawSpawnTimeout !== undefined && String(rawSpawnTimeout).trim().length > 0) {
      return resolvePositiveIntValue(rawSpawnTimeout, DEFAULT_DAEMON_SPAWN_HTTP_TIMEOUT_MS, {
        min: 100,
        max: 300_000,
      });
    }
    return resolvePositiveIntValue(process.env[DAEMON_HTTP_TIMEOUT_ENV_KEY], DEFAULT_DAEMON_SPAWN_HTTP_TIMEOUT_MS, {
      min: 100,
      max: 300_000,
    });
  }

  return resolvePositiveIntValue(process.env[DAEMON_HTTP_TIMEOUT_ENV_KEY], DEFAULT_DAEMON_HTTP_TIMEOUT_MS, {
    min: 100,
    max: 300_000,
  });
}

export function resolveExecutionRunConnectedServiceMaterializeTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolvePositiveIntValue(
    env[EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_ENV_KEY],
    DEFAULT_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS,
    { min: 1_000, max: 600_000 },
  );
}

function resolveDaemonPingTimeoutMs(): number {
  return resolvePositiveIntValue(process.env[DAEMON_PING_TIMEOUT_ENV_KEY], DEFAULT_DAEMON_PING_TIMEOUT_MS, {
    min: 100,
    max: 300_000,
  });
}

function resolveDaemonStopWaitForDeathTimeoutMs(): number {
  const rawExplicit = process.env[DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_ENV_KEY];
  if (rawExplicit !== undefined && String(rawExplicit).trim().length > 0) {
    return resolvePositiveIntValue(rawExplicit, DEFAULT_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS, {
      min: 0,
      max: 300_000,
    });
  }

  const rawDrainGrace = process.env[DAEMON_SHUTDOWN_SPAWN_DRAIN_GRACE_ENV_KEY];
  const drainGraceMs = resolvePositiveIntValue(rawDrainGrace, DEFAULT_DAEMON_SHUTDOWN_SPAWN_DRAIN_GRACE_MS, {
    min: 0,
    max: 120_000,
  });

  return Math.max(DEFAULT_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS, drainGraceMs + 2_000);
}

export type DaemonRunningInspection =
  | { status: 'not-running' }
  | { status: 'starting'; pid: number }
  | { status: 'starting'; state: NonNullable<Awaited<ReturnType<typeof readDaemonState>>> }
  | { status: 'running'; state: NonNullable<Awaited<ReturnType<typeof readDaemonState>>> };

async function inspectDaemonLockStartupProgress(): Promise<{ status: 'starting'; pid: number } | null> {
  const owner = await inspectDaemonLockOwner();
  if (owner.status === 'starting') {
    if (owner.evidence === 'live-unclassified') {
      logger.debug('[DAEMON RUN] Daemon lock is held by a live process whose incarnation cannot be classified safely, treating startup as in progress');
    } else {
      logger.debug('[DAEMON RUN] Daemon lock is held by a live daemon before state was written, treating startup as in progress');
    }
    return { status: 'starting', pid: owner.pid };
  }
  return null;
}

export async function inspectDaemonRunningStateAndCleanupStaleState(): Promise<DaemonRunningInspection> {
  const state = await readDaemonState();
  if (!state) {
    const lockStartup = await inspectDaemonLockStartupProgress();
    if (lockStartup) return lockStartup;
    return { status: 'not-running' };
  }

  if (state.controlToken && (!state.httpPort || typeof state.httpPort !== 'number')) {
    logger.debug('[DAEMON RUN] Daemon state missing httpPort, cleaning up state');
    await cleanupDaemonState();
    return { status: 'not-running' };
  }

  try {
    process.kill(state.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') {
      logger.debug('[DAEMON RUN] Daemon PID is definitively not running, treating daemon as replaceable without client cleanup');
      return { status: 'not-running' };
    }

    logger.debug('[DAEMON RUN] Daemon PID liveness is inconclusive, keeping state fail-closed');
    return { status: 'starting', state };
  }

  try {
    if (state.controlToken) {
      const ping = await daemonPost('/ping', undefined, { timeoutMs: resolveDaemonPingTimeoutMs() });

      if (ping && typeof ping === 'object' && (ping as any).success === false) {
        logger.debug('[DAEMON RUN] Daemon /ping rejected control token, cleaning up state');
        await cleanupDaemonState();
        return { status: 'not-running' };
      }

      if (ping?.error) {
        logger.debug('[DAEMON RUN] Daemon /ping unreachable while PID is alive, treating daemon as busy/unknown and keeping state');
        return { status: 'starting', state };
      }
    }

    return { status: 'running', state };
  } catch {
    const ageMs = resolveDaemonStateFreshnessAgeMs(state);
    if (ageMs !== null && ageMs <= DAEMON_STATE_FRESHNESS_GRACE_MS) {
      logger.debug('[DAEMON RUN] Daemon PID is not running but state is still fresh, keeping state while startup arbitration settles');
      return { status: 'starting', state };
    }

    logger.debug('[DAEMON RUN] Daemon PID is not running and state is stale, treating daemon as replaceable without client cleanup');
    return { status: 'not-running' };
  }
}

async function daemonPost(path: string, body?: any, options: DaemonPostOptions = {}): Promise<{ error?: string } | any> {
  const state = options.target ?? await readDaemonState();
  if (!state?.httpPort) {
    const errorMessage = 'No daemon running, no state file found';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    };
  }

  if (!isPidPresent(state.pid)) {
    const errorMessage = 'Daemon is not running, file is stale';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    };
  }

  try {
    const timeout = resolveDaemonControlTimeoutMs(path, options);
    const authToken = options.authTokenOverride
      ?? (options.authScope === 'connected-service-run-materialize'
        ? deriveConnectedServiceRunMaterializeToken(state.controlToken)
        : state.controlToken);
    const headers = buildDaemonControlHttpHeaders(authToken);
    const timeoutSignal = timeout === null ? null : AbortSignal.timeout(timeout);
    const requestSignal = options.signal && timeoutSignal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : options.signal ?? timeoutSignal ?? undefined;
    const response = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
      ...(requestSignal ? { signal: requestSignal } : {}),
    });
    
    const rawBody = await response.text();
    let parsedBody: unknown = null;
    if (rawBody.trim().length > 0) {
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = rawBody;
      }
    }

    if (!response.ok) {
      const responseObject =
        parsedBody && typeof parsedBody === 'object' ? (parsedBody as Record<string, unknown>) : null;
      // If the daemon control server returns a structured payload (e.g. {success:false,...}),
      // preserve it so callers can act on fields like requiresUserApproval/errorCode.
      if (responseObject && typeof responseObject.success === 'boolean') {
        return responseObject;
      }

      const remoteErrorCode =
        responseObject && typeof responseObject.errorCode === 'string' ? responseObject.errorCode : undefined;

      const remoteErrorMessage =
        responseObject && typeof responseObject.error === 'string'
          ? responseObject.error
          : responseObject && typeof responseObject.message === 'string'
            ? responseObject.message
            : undefined;

      const detailSuffix = [remoteErrorCode, remoteErrorMessage].filter(Boolean).join(': ');
      const errorMessage = `Request failed: ${path}, HTTP ${response.status}${detailSuffix ? ` (${detailSuffix})` : ''}`;
      logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
      return {
        error: errorMessage,
        errorCode: remoteErrorCode,
        response: parsedBody,
      };
    }
    
    return parsedBody ?? {};
  } catch (error) {
    const errorMessage = `Request failed: ${path}, ${error instanceof Error ? error.message : 'Unknown error'}`;
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    }
  }
}

export async function notifyDaemonSessionStarted(
  sessionId: string,
  metadata: Metadata,
  options: DaemonControlRequestOptions & Readonly<{
    sessionCreationOutcome?: SessionCreationOutcome;
    persistedTakeoverAdmission?: Readonly<{
      mode: TakeoverAdmissionMode;
      operationId: string;
      attemptId: string;
      phase: PersistedTakeoverAdmissionPhase;
      publisherPrecondition: SessionMetadataPublisherPreconditionV1;
    }>;
  }> = {},
): Promise<Readonly<{
  status?: 'ok';
  error?: string;
  errorCode?: string;
  response?: unknown;
}>> {
  const {
    sessionCreationOutcome,
    persistedTakeoverAdmission,
    ...requestOptions
  } = options;
  return await daemonPost('/session-started', {
    sessionId,
    metadata,
    ...(sessionCreationOutcome ? { sessionCreationOutcome } : {}),
    ...(persistedTakeoverAdmission ? { persistedTakeoverAdmission } : {}),
  }, requestOptions);
}

/**
 * Reports a terminal pre-Session startup failure over the same authenticated
 * callback as a successful Session report. No Session identity or metadata is
 * available (or fabricated) on this branch.
 */
export async function notifyDaemonSessionStartupFailure(
  input: Readonly<{
    spawnNonce: string;
    errorDetail: import('@happier-dev/protocol').SessionCreationTerminalSpawnErrorDetail;
  }>,
  options: DaemonControlRequestOptions = {},
): Promise<Readonly<{
  status?: 'ok';
  error?: string;
  errorCode?: string;
  response?: unknown;
}>> {
  const spawnNonce = input.spawnNonce.trim();
  if (!spawnNonce) {
    return { error: 'Session startup failure correlation is unavailable' };
  }
  return await daemonPost('/session-started', {
    result: 'failure',
    spawnNonce,
    errorDetail: input.errorDetail,
  }, options);
}

function parseDaemonPluginChangeReviewResult(
  result: unknown,
): PluginChangePendingReviewResult | null | undefined {
  if (!result || typeof result !== 'object') return undefined;
  const record = result as Readonly<Record<string, unknown>>;
  if (record.kind === 'sourceRootReviewRequired') {
    const pendingChangeId = typeof record.pendingChangeId === 'string'
      ? record.pendingChangeId.trim()
      : '';
    const review = PluginDevelopmentSourceRootReviewSchema.safeParse(record.review);
    if (!pendingChangeId || !review.success) return null;
    return {
      kind: 'sourceRootReviewRequired',
      pendingChangeId,
      review: review.data,
    };
  }
  if (record.kind === 'reviewRequired') {
    const pendingChangeId = typeof record.pendingChangeId === 'string'
      ? record.pendingChangeId.trim()
      : '';
    const review = PluginInstallationReviewSchema.safeParse(record.review);
    if (!pendingChangeId || !review.success) return null;
    return {
      kind: 'reviewRequired',
      pendingChangeId,
      review: review.data,
    };
  }
  return undefined;
}

export async function requestDaemonPluginChange(
  request: PluginChangeRequest,
  options: DaemonControlRequestOptions = {},
): Promise<PluginChangeRequestResult | Readonly<{ kind: 'unavailable'; code: string }>> {
  const result = await daemonPost(PLUGIN_CHANGE_REQUEST_PATH, request, {
    ...options,
    timeoutMs: options.timeoutMs ?? 300_000,
  });
  if (result && typeof result === 'object' && typeof result.error === 'string') {
    return { kind: 'unavailable', code: result.errorCode ?? 'daemon_unavailable' };
  }
  const review = parseDaemonPluginChangeReviewResult(result);
  if (review === null) return { kind: 'unavailable', code: 'daemon_invalid_response' };
  if (review) return review;
  return result as PluginChangeRequestResult;
}

export async function decideDaemonPluginChange(
  decision: PluginChangeDecision,
  options: DaemonControlRequestOptions = {},
): Promise<PluginChangeDecisionResult | Readonly<{ kind: 'unavailable'; code: string }>> {
  const result = await daemonPost(PLUGIN_CHANGE_DECISION_PATH, decision, {
    ...options,
    timeoutMs: options.timeoutMs ?? 300_000,
  });
  if (result && typeof result === 'object' && typeof result.error === 'string') {
    return { kind: 'unavailable', code: result.errorCode ?? 'daemon_unavailable' };
  }
  const review = parseDaemonPluginChangeReviewResult(result);
  if (review === null) return { kind: 'unavailable', code: 'daemon_invalid_response' };
  if (review) return review;
  return result as PluginChangeDecisionResult;
}

export async function readDaemonPluginChangeStatus(
  request: PluginChangeStatusRequest,
  options: DaemonControlRequestOptions = {},
): Promise<PluginChangeStatusResult> {
  const result = await daemonPost(PLUGIN_CHANGE_STATUS_PATH, request, {
    ...options,
    timeoutMs: options.timeoutMs ?? 30_000,
  });
  if (result && typeof result === 'object' && typeof result.error === 'string') {
    return { kind: 'daemonUnavailable' };
  }
  const review = parseDaemonPluginChangeReviewResult(result);
  if (review) return review;
  if (!result || typeof result !== 'object') return { kind: 'daemonUnavailable' };
  const record = result as Readonly<Record<string, unknown>>;
  const pendingChangeId = typeof record.pendingChangeId === 'string'
    ? record.pendingChangeId.trim()
    : '';
  const terminalResult = record.result;
  if (record.kind === 'applying' && pendingChangeId) {
    return { kind: 'applying', pendingChangeId };
  }
  if (
    record.kind === 'terminal'
    && pendingChangeId
    && terminalResult
    && typeof terminalResult === 'object'
    && 'kind' in terminalResult
    && typeof terminalResult.kind === 'string'
  ) {
    return {
      kind: 'terminal',
      pendingChangeId,
      result: terminalResult as PluginChangeTerminalResult,
    };
  }
  if (record.kind === 'expired' || record.kind === 'daemonUnavailable') {
    return { kind: record.kind };
  }
  return { kind: 'daemonUnavailable' };
}

/**
 * Enumerates the daemon's outstanding plugin-change decisions.
 *
 * A daemon that is not reachable holds no in-memory pending changes by
 * definition, so an unreachable or malformed response is an empty listing
 * rather than an error: there is nothing for a present user to decide.
 */
export async function listDaemonPluginChanges(
  options: DaemonControlRequestOptions = {},
): Promise<PluginChangeListResult> {
  const result = await daemonPost(PLUGIN_CHANGE_LIST_PATH, {}, {
    ...options,
    timeoutMs: options.timeoutMs ?? 15_000,
  });
  if (!result || typeof result !== 'object' || typeof result.error === 'string') {
    return { changes: [] };
  }
  const changes = (result as Readonly<Record<string, unknown>>).changes;
  if (!Array.isArray(changes)) return { changes: [] };
  return {
    changes: changes.flatMap((entry): readonly PluginPendingChangeEntry[] => {
      const review = parseDaemonPluginChangeReviewResult(entry);
      if (review) return [review];
      if (!entry || typeof entry !== 'object') return [];
      const record = entry as Readonly<Record<string, unknown>>;
      const pendingChangeId = typeof record.pendingChangeId === 'string'
        ? record.pendingChangeId.trim()
        : '';
      return record.kind === 'applying' && pendingChangeId
        ? [{ kind: 'applying', pendingChangeId }]
        : [];
    }),
  };
}

export async function requestDaemonPluginActionExecution(request: Readonly<{
  actionId: string;
  input: unknown;
  surface: 'cli' | 'mcp' | 'agent';
  defaultSessionId?: string;
  /** Host-stamped turn admission fence; never Action input or SDK surface. */
  expectedContributorImmutableGenerationId?: string;
}>, options: DaemonControlRequestOptions = {}): Promise<PluginActionExecutionAttempt> {
  const result = await daemonPost(PLUGIN_ACTION_EXECUTE_PATH, request, {
    ...options,
    timeoutMs: options.timeoutMs ?? 300_000,
  });
  if (result && typeof result === 'object' && typeof result.error === 'string') {
    return {
      matched: true,
      result: {
        ok: false,
        errorCode: result.errorCode ?? 'daemon_unavailable',
        error: result.error,
      },
    };
  }
  return result as PluginActionExecutionAttempt;
}

export async function requestDaemonSignedRootActionExecution(
  request: SignedRootActionExecuteRequest,
  options: DaemonControlRequestOptions = {},
): Promise<ActionExecuteResult> {
  const result = await daemonPost(SIGNED_ROOT_ACTION_EXECUTE_PATH, request, {
    ...options,
    timeoutMs: options.timeoutMs ?? 300_000,
  });
  if (options.signal?.aborted) {
    return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
  }
  if (result && typeof result === 'object' && typeof result.error === 'string') {
    return {
      ok: false,
      errorCode: result.errorCode ?? 'daemon_unavailable',
      error: result.error,
    };
  }
  return result as ActionExecuteResult;
}

export async function readDaemonPluginCatalog(
  options: DaemonControlRequestOptions = {},
): Promise<
  | Readonly<{
      kind: 'available';
      plugins: readonly PluginCatalogEntry[];
      tools: readonly ProjectedPluginToolCatalogEntry[];
    }>
  | Readonly<{ kind: 'unavailable'; code: string }>
> {
  const result = await daemonPost(PLUGIN_CATALOG_READ_PATH, {}, options);
  if (result && typeof result === 'object' && typeof result.error === 'string') {
    return { kind: 'unavailable', code: result.errorCode ?? 'daemon_unavailable' };
  }
  const parsed = result as
    | Readonly<{
        kind: 'available';
        plugins: readonly PluginCatalogEntry[];
        tools?: readonly ProjectedPluginToolCatalogEntry[];
      }>
    | Readonly<{ kind: 'unavailable'; code: string }>;
  return parsed.kind === 'available'
    ? {
        ...parsed,
        tools: Array.isArray(parsed.tools) ? parsed.tools : Object.freeze([]),
      }
    : parsed;
}

const DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH_TIMEOUT_ENV_KEY =
  'HAPPIER_DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH_HTTP_TIMEOUT_MS';
// The daemon may consume a 60s safe-boundary wait and a separate 60s bounded
// application window. The HTTP caller must leave enough transport/materialization
// margin for that canonical operation to settle before timing out.
const DEFAULT_DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH_TIMEOUT_MS = 180_000;

export function resolveDaemonSessionConnectedServiceAuthSwitchTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolvePositiveIntValue(
    env[DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH_TIMEOUT_ENV_KEY],
    DEFAULT_DAEMON_SESSION_CONNECTED_SERVICE_AUTH_SWITCH_TIMEOUT_MS,
    { min: 1_000, max: 300_000 },
  );
}

export async function requestDaemonSessionConnectedServiceAuthSwitch(
  body: Readonly<{
    sessionId: string;
    agentId: string;
    bindings: ConnectedServiceBindingsV1;
    rematerializeServiceId?: ConnectedAccountServiceKey;
    expectedGroupGenerationByServiceId?: Readonly<Record<string, number>>;
    accountSettingsVersionHint?: number;
  }>,
  options: DaemonControlRequestOptions = {},
): Promise<unknown> {
  const result = await daemonPost('/connected-service-auth/session/switch', {
    sessionId: body.sessionId,
    agentId: body.agentId,
    bindings: body.bindings,
    ...(body.rematerializeServiceId === undefined
      ? {}
      : { rematerializeServiceId: body.rematerializeServiceId }),
    ...(body.expectedGroupGenerationByServiceId === undefined
      ? {}
      : { expectedGroupGenerationByServiceId: body.expectedGroupGenerationByServiceId }),
    ...(body.accountSettingsVersionHint === undefined
      ? {}
      : { accountSettingsVersionHint: body.accountSettingsVersionHint }),
  }, {
    timeoutMs: resolveDaemonSessionConnectedServiceAuthSwitchTimeoutMs(),
    ...options,
  });
  if (result?.error) {
    throw new Error(String(result.error));
  }
  return (result as { result?: unknown } | null)?.result;
}

export async function requestDaemonSessionConnectedServiceRuntimeAuthRefresh(
  body: Readonly<{
    sessionId: string;
    serviceId: string;
    refreshAttemptId: string;
    selection: unknown;
    planType?: string | null;
    failingAccessTokenFingerprint?: string | null;
    expectedCredentialRevision: string;
    reason?: string | null;
  }>,
  options: DaemonControlRequestOptions = {},
): Promise<ConnectedServiceDaemonAuthBridgeRefreshResult> {
  const result = await daemonPost('/connected-service-auth/session/refresh-runtime-auth', {
    sessionId: body.sessionId,
    serviceId: body.serviceId,
    refreshAttemptId: body.refreshAttemptId,
    selection: body.selection,
    ...(body.planType === undefined ? {} : { planType: body.planType }),
    ...(body.failingAccessTokenFingerprint === undefined
      ? {}
      : { failingAccessTokenFingerprint: body.failingAccessTokenFingerprint }),
    expectedCredentialRevision: body.expectedCredentialRevision,
    ...(body.reason === undefined ? {} : { reason: body.reason }),
  }, options);
  if (result?.error || result?.errorCode) {
    if (!result?.errorCode && typeof result?.error === 'string' && /abort|timed?\s*out|timeout/iu.test(result.error)) {
      return {
        status: 'pending',
        refreshAttemptId: body.refreshAttemptId,
      };
    }
    throw new Error(String(result.errorCode ?? result.error));
  }
  return (result as { result: ConnectedServiceDaemonAuthBridgeRefreshResult }).result;
}

export async function notifyDaemonConnectedServiceRuntimeAuthFailure(
  body: Readonly<{
    reportId: string;
    sessionId: string;
    switchesThisTurn?: number;
    resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
    classification: unknown;
  }>,
  options: DaemonControlRequestOptions = {},
): Promise<{ error?: string } | any> {
  return await daemonPost('/connected-service-runtime-auth/failure', {
    reportId: body.reportId,
    sessionId: body.sessionId,
    switchesThisTurn: body.switchesThisTurn ?? 0,
    ...(body.resumePromptMode ? { resumePromptMode: body.resumePromptMode } : {}),
    classification: body.classification,
  }, options);
}

export async function notifyDaemonConnectedServiceTurnLifecycle(
  body: ConnectedServiceTurnLifecycleRequestBody,
  options: DaemonControlRequestOptions = {},
): Promise<ConnectedServiceTurnLifecycleResult | { error?: string }> {
  const response = await daemonPost('/connected-service-turn-lifecycle', {
    sessionId: body.sessionId,
    ...(body.turnId ? { turnId: body.turnId } : {}),
    event: body.event,
    ...(body.terminalStatus ? { terminalStatus: body.terminalStatus } : {}),
    ...(body.connectedServiceSelectionsEnvRaw
      ? { connectedServiceSelectionsEnvRaw: body.connectedServiceSelectionsEnvRaw }
      : {}),
    ...(body.requestedAction
      ? { requestedAction: body.requestedAction }
      : {}),
    ...(body.activeTurnId !== undefined
      ? { activeTurnId: body.activeTurnId }
      : {}),
  }, options);
  if (
    response
    && typeof response === 'object'
    && response.ok === true
    && Object.prototype.hasOwnProperty.call(response, 'result')
  ) {
    return response.result;
  }
  return response;
}

export async function notifyDaemonConnectedServiceUsageLimitWaitResumeCancel(
  body: Readonly<{ sessionId: string; attemptId: string }>,
  options: DaemonControlRequestOptions = {},
): Promise<{ error?: string } | any> {
  return await daemonPost('/connected-service-usage-limit/wait-resume-cancel', body, options);
}

export async function notifyDaemonConnectedServiceQuotaRecoveryCreditConsume(
  body: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    idempotencyKey: string;
    providerCreditId?: string;
  }>,
  options: DaemonControlRequestOptions = {},
): Promise<{ error?: string } | any> {
  return await daemonPost('/connected-service-quota-recovery-credit/consume', {
    serviceId: body.serviceId,
    profileId: body.profileId,
    idempotencyKey: body.idempotencyKey,
    ...(body.providerCreditId ? { providerCreditId: body.providerCreditId } : {}),
  }, options);
}

export async function notifyDaemonProviderAccountUsageSnapshot(
  body: Readonly<{
    sessionId: string;
    snapshot: ProviderAccountUsageSnapshotV1;
    source?: ConnectedServiceUsageSourceV1 | null;
    deriveCredentialFingerprintFromSource?: true;
    credentialFingerprint?: string | null;
    policyDisposition?: 'evidence_only';
  }>,
  options: DaemonControlRequestOptions = {},
): Promise<{ error?: string } | any> {
  return await daemonPost('/provider-account-usage-snapshot', {
    sessionId: body.sessionId,
    snapshot: body.snapshot,
    ...(body.source ? { source: body.source } : {}),
    ...(body.deriveCredentialFingerprintFromSource
      ? { deriveCredentialFingerprintFromSource: true as const }
      : {}),
    ...(body.credentialFingerprint !== undefined ? { credentialFingerprint: body.credentialFingerprint } : {}),
    ...(body.policyDisposition ? { policyDisposition: body.policyDisposition } : {}),
  }, options);
}

export async function notifyDaemonProviderAccountUsageAdoption(
  body: Readonly<{
    sessionId: string;
    adoption: ProviderAccountUsageAdoptionV1;
  }>,
  options: DaemonControlRequestOptions = {},
): Promise<{ error?: string } | any> {
  return await daemonPost('/provider-account-usage-adoption', {
    sessionId: body.sessionId,
    adoption: body.adoption,
  }, options);
}

export async function listDaemonSessions(): Promise<any[]> {
  const result = await daemonPost('/list');
  return result.children || [];
}

export async function stopDaemonSession(sessionId: string): Promise<StopSessionResult> {
  const result = await daemonPost('/stop-session', { sessionId });
  return StopSessionResultSchema.parse(result);
}

export async function spawnDaemonSession(request: SpawnDaemonSessionRequest): Promise<any>;
export async function spawnDaemonSession(directory: string, sessionId?: string): Promise<any>;
export async function spawnDaemonSession(
  requestOrDirectory: SpawnDaemonSessionRequest | string,
  sessionId?: string,
): Promise<any> {
  const request = typeof requestOrDirectory === 'string'
    ? { directory: requestOrDirectory, ...(sessionId ? { sessionId } : {}) }
    : requestOrDirectory;
  const result = await daemonPost('/spawn-session', serializeSpawnDaemonSessionRequestForLocalControl(request));
  return result;
}

export type DaemonSpawnSessionResolveStatus = SpawnSessionNonceResolution;

export async function resolveDaemonSpawnSessionByNonce(spawnNonce: string): Promise<DaemonSpawnSessionResolveStatus> {
  const normalizedSpawnNonce = spawnNonce.trim();
  if (!normalizedSpawnNonce) {
    return { status: 'not_found' };
  }
  const result = await daemonPost('/spawn-session/resolve', { spawnNonce: normalizedSpawnNonce });
  if (result && typeof result === 'object' && typeof (result as { status?: unknown }).status === 'string') {
    const status = (result as { status: string }).status;
    if (status === 'pending') return { status: 'pending' };
    if (status === 'not_found') return { status: 'not_found' };
    if (status === 'error') {
      const normalized = normalizeSpawnSessionNonceResolution(result);
      return normalized.status === 'error' ? normalized : { status: 'not_found' };
    }
    if (status === 'success') {
      const sessionId = typeof (result as { sessionId?: unknown }).sessionId === 'string'
        ? (result as { sessionId: string }).sessionId.trim()
        : '';
      if (sessionId) {
        const normalized = normalizeSpawnSessionNonceResolution({
          status: 'success',
          sessionId,
          sessionCreationOutcome: (result as { sessionCreationOutcome?: unknown }).sessionCreationOutcome,
        });
        return {
          status: 'success',
          sessionId,
          ...(normalized.status === 'success' && normalized.sessionCreationOutcome
            ? { sessionCreationOutcome: normalized.sessionCreationOutcome }
            : {}),
        };
      }
      return { status: 'not_found' };
    }
  }

  const errorMessage = typeof (result as { error?: unknown } | null)?.error === 'string'
    ? (result as { error: string }).error
    : '';
  if (errorMessage.includes('/spawn-session/resolve') && errorMessage.includes('HTTP 404')) {
    return { status: 'unsupported' };
  }

  return { status: 'not_found' };
}

export type DaemonSessionRunnerRestartMode = SessionRunnerRestartModeV1;
export type RestartAllDaemonSessionRunnersRequest = RestartAllSessionRunnersRequestV1;
export type RestartAllDaemonSessionRunnersResult = RestartAllSessionRunnersResultV1;
export type GetDaemonSessionRunnerStatusRequest = SessionRunnerStatusGetRequestV1;

const DAEMON_SESSION_RUNNER_RESTART_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_SESSION_RUNNER_RESTART_HTTP_TIMEOUT_MS';
const DEFAULT_DAEMON_SESSION_RUNNER_RESTART_TIMEOUT_MS = 75_000;

export function resolveDaemonSessionRunnerRestartTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolvePositiveIntValue(
    env[DAEMON_SESSION_RUNNER_RESTART_TIMEOUT_ENV_KEY],
    DEFAULT_DAEMON_SESSION_RUNNER_RESTART_TIMEOUT_MS,
    { min: 1_000, max: 300_000 },
  );
}

export async function requestDaemonSessionRunnerRestart(
  request: RestartSessionRunnerRequestV1,
  options: DaemonControlRequestOptions = {},
): Promise<RestartSessionRunnerResultV1> {
  const body = RestartSessionRunnerRequestV1Schema.parse(request);
  const result = await daemonPost('/session-runners/restart', body, {
    timeoutMs: resolveDaemonSessionRunnerRestartTimeoutMs(),
    ...options,
  });
  if (result?.error) {
    throw new Error(String(result.error));
  }
  const parsed = RestartSessionRunnerResultV1Schema.safeParse(result);
  if (!parsed.success) {
    throw new Error('Invalid daemon session runner restart response');
  }
  return parsed.data;
}

export async function requestDaemonSessionRunnerRestartV2(
  request: RestartSessionRunnerRequestV2,
  options: DaemonControlRequestOptions = {},
): Promise<RestartSessionRunnerResultV1> {
  const body = RestartSessionRunnerRequestV2Schema.parse(request);
  const result = await daemonPost('/session-runners/restart-v2', body, {
    timeoutMs: resolveDaemonSessionRunnerRestartTimeoutMs(),
    ...options,
  });
  if (result?.error) {
    throw new Error(String(result.error));
  }
  const parsed = RestartSessionRunnerResultV1Schema.safeParse(result);
  if (!parsed.success) {
    throw new Error('Invalid daemon session runner V2 restart response');
  }
  return parsed.data;
}

export async function restartAllDaemonSessionRunners(
  request: RestartAllDaemonSessionRunnersRequest,
  options: DaemonControlRequestOptions = {},
): Promise<RestartAllDaemonSessionRunnersResult> {
  const body = RestartAllSessionRunnersRequestV1Schema.parse(request);
  const result = await daemonPost('/session-runners/restart-all', body, {
    timeoutMs: resolveDaemonSessionRunnerRestartTimeoutMs(),
    ...options,
  });
  if (result?.error) {
    throw new Error(String(result.error));
  }
  const parsed = RestartAllSessionRunnersResultV1Schema.safeParse(result);
  if (!parsed.success) {
    throw new Error('Invalid daemon session runner restart-all response');
  }
  return parsed.data;
}

export async function getDaemonSessionRunnerStatus(
  request: GetDaemonSessionRunnerStatusRequest,
  options: DaemonControlRequestOptions = {},
): Promise<SessionRunnerRuntimeStateV1> {
  const body = SessionRunnerStatusGetRequestV1Schema.parse(request);
  const result = await daemonPost('/session-runners/status', body, options);
  if (result?.error) {
    throw new Error(String(result.error));
  }
  const parsed = SessionRunnerRuntimeStateV1Schema.safeParse(result);
  if (!parsed.success) {
    throw new Error('Invalid daemon session runner status response');
  }
  return parsed.data;
}

export async function getDaemonSessionRunnerStatusV2(
  request: GetDaemonSessionRunnerStatusRequest,
  options: DaemonControlRequestOptions = {},
): Promise<SessionRunnerRuntimeStatusV2> {
  const body = SessionRunnerStatusGetRequestV1Schema.parse(request);
  const result = await daemonPost('/session-runners/status-v2', body, options);
  if (result?.error) {
    throw new Error(String(result.error));
  }
  const parsed = SessionRunnerRuntimeStatusV2Schema.safeParse(result);
  if (!parsed.success) {
    throw new Error('Invalid daemon session runner V2 status response');
  }
  return parsed.data;
}

export async function admitDaemonForegroundAgentRuntime(
  request: ForegroundAgentRuntimeAdmissionRequestV1,
  options: DaemonControlRequestOptions = {},
): Promise<ForegroundAgentRuntimeAdmissionResponseV1> {
  const body = ForegroundAgentRuntimeAdmissionRequestV1Schema.parse(request);
  const result = await daemonPost(
    FOREGROUND_AGENT_RUNTIME_ADMISSION_PATH,
    body,
    options,
  );
  const parsed =
    ForegroundAgentRuntimeAdmissionResponseV1Schema.safeParse(result);
  if (parsed.success) return parsed.data;
  return {
    ok: false,
    error: createProviderErrorV1(
      'provider_agent_runtime_unsupported',
      {
        connectionId:
          body.selection?.ref.providerConnectionId ?? undefined,
      },
    ),
  };
}

export async function claimDaemonForegroundAgentRuntime(
  request: ForegroundAgentRuntimeClaimRequestV1,
  options: DaemonControlRequestOptions = {},
): Promise<ForegroundAgentRuntimeClaimResponseV1> {
  const body = ForegroundAgentRuntimeClaimRequestV1Schema.parse(request);
  const result = await daemonPost(
    FOREGROUND_AGENT_RUNTIME_CLAIM_PATH,
    body,
    {
      ...options,
      authTokenOverride: body.capability,
      timeoutMs:
        options.timeoutMs === undefined ? 300_000 : options.timeoutMs,
    },
  );
  return ForegroundAgentRuntimeClaimResponseV1Schema.parse(result);
}

export async function releaseDaemonForegroundAgentRuntime(
  request: ForegroundAgentRuntimeReleaseRequestV1,
  options: DaemonControlRequestOptions = {},
): Promise<void> {
  const body = ForegroundAgentRuntimeReleaseRequestV1Schema.parse(request);
  const result = await daemonPost(
    FOREGROUND_AGENT_RUNTIME_RELEASE_PATH,
    body,
    options,
  );
  ForegroundAgentRuntimeReleaseResponseV1Schema.parse(result);
}

export async function restartDaemonHttp(): Promise<{ status: 'restarting' | 'already_restarting' }> {
  const result = await daemonPost('/restart', {});
  if (result?.error) {
    throw new Error(String(result.error));
  }
  if (
    result &&
    typeof result === 'object' &&
    ((result as { status?: unknown }).status === 'restarting'
      || (result as { status?: unknown }).status === 'already_restarting')
  ) {
    return { status: (result as { status: 'restarting' | 'already_restarting' }).status };
  }
  throw new Error('Invalid daemon restart response');
}

export async function ensureDaemonSshTunnel(
  request: SshTunnelEnsureRequest,
): Promise<SshTunnelEnsureResponse | { error: string; errorCode?: string }> {
  return await daemonPost('/ssh-tunnels/ensure', request);
}

export async function listDaemonSshTunnels(): Promise<SshTunnelListResponse | { error: string; errorCode?: string }> {
  return await daemonPost('/ssh-tunnels/list');
}

export async function probeDaemonSshTunnel(
  tunnelKey: string,
): Promise<SshTunnelProbeResponse | { error: string; errorCode?: string }> {
  return await daemonPost('/ssh-tunnels/probe', { tunnelKey });
}

export async function releaseDaemonSshTunnel(
  leaseId: string,
): Promise<SshTunnelMutationResponse | { error: string; errorCode?: string }> {
  return await daemonPost('/ssh-tunnels/release', { leaseId });
}

export async function stopDaemonSshTunnel(
  tunnelKey: string,
): Promise<SshTunnelMutationResponse | { error: string; errorCode?: string }> {
  return await daemonPost('/ssh-tunnels/stop', { tunnelKey });
}

/**
 * Runner → daemon: resolve + materialize connected-service auth for an execution run
 * (RUN-scoped materialization key) and register the run PID as a runtime-registry target.
 * Uses the SCOPED run-materialize capability token (never the master control token).
 * Fail closed: callers must treat any `{ error }` / non-ok result as "do not start the run
 * with this connected selection".
 */
export async function requestExecutionRunConnectedServicesMaterialization(
  request: ConnectedServiceRunMaterializeRequest,
): Promise<
  | { ok: true; result: { activationId: string; env: Record<string, string>; connectedServicesBindings: unknown; registration: ExecutionRunConnectedServicesRegistrationV1 } }
  | { ok?: false; error?: string; errorCode?: string; errorMessage?: string }
> {
  return await daemonPost(CONNECTED_SERVICE_RUN_MATERIALIZE_PATH, request, {
    authScope: 'connected-service-run-materialize',
    timeoutMs: resolveExecutionRunConnectedServiceMaterializeTimeoutMs(),
  });
}

/**
 * Runner → daemon: release an execution run's connected-services materialization (unregister the
 * run from the canonical runtime registry, run retained cleanup). Best-effort at run end.
 */
export async function releaseExecutionRunConnectedServices(
  request: ConnectedServiceRunReleaseRequest,
): Promise<{ ok?: boolean; released?: boolean; error?: string }> {
  return await daemonPost(CONNECTED_SERVICE_RUN_RELEASE_PATH, request, {
    authScope: 'connected-service-run-materialize',
  });
}

export async function checkExecutionRunConnectedServicesGenerationCurrent(
  request: ConnectedServiceRunGenerationCurrentRequest,
): Promise<{ ok?: boolean; current?: boolean; error?: string }> {
  return await daemonPost(CONNECTED_SERVICE_RUN_GENERATION_CURRENT_PATH, request, {
    authScope: 'connected-service-run-materialize',
  });
}

export async function stopDaemonHttp(params: {
  stopSessions?: boolean;
} = {}): Promise<void> {
  const result = await daemonPost('/stop', {
    ...(params.stopSessions === true ? { stopSessions: true } : {}),
  });
  if (result?.error) {
    throw new Error(result.error);
  }
}

/**
 * Best-effort health check for a running daemon.
 * Returns false for busy/unknown daemons, rejected control tokens, or stale dead-PID state.
 * Client health checks must not remove daemon-owned state while the recorded PID is alive.
 */
export async function checkIfDaemonRunningAndCleanupStaleState(): Promise<boolean> {
  const inspection = await inspectDaemonRunningStateAndCleanupStaleState();
  return inspection.status === 'running';
}

/**
 * Check if the running daemon version matches the current CLI version.
 * This should work from both the daemon itself & a new CLI process.
 * Works via the daemon.state.json file.
 * 
 * @returns true if versions match, false if versions differ or no daemon running
 */
export async function isDaemonRunningCurrentlyInstalledHappyVersion(params: Readonly<{
  expectedMachineId?: string | null;
}> = {}): Promise<boolean> {
  logger.debug('[DAEMON CONTROL] Checking if daemon is running same version');
  const runningDaemon = await inspectDaemonRunningStateAndCleanupStaleState();
  if (runningDaemon.status === 'not-running') {
    logger.debug('[DAEMON CONTROL] No daemon running, returning false');
    return false;
  }
  if (!('state' in runningDaemon)) {
    logger.debug('[DAEMON CONTROL] Daemon startup lock has no state yet, returning false');
    return false;
  }

  const state = runningDaemon.state;

  const expectedMachineId = typeof params.expectedMachineId === 'string' ? params.expectedMachineId.trim() : '';
  if (expectedMachineId) {
    const stateMachineId = typeof state.machineId === 'string' ? state.machineId.trim() : '';
    if (!stateMachineId || stateMachineId !== expectedMachineId) {
      logger.debug(
        `[DAEMON CONTROL] Running daemon machine mismatch. expected=${expectedMachineId} actual=${stateMachineId || 'missing'}`,
      );
      return false;
    }
  }
  
  try {
    const currentCliVersion = resolveComparableCliVersion({
      fallbackVersion: configuration.currentCliVersion,
      projectRootPath: projectPath(),
      readFileSyncImpl: readFileSync,
    });
    
    logger.debug(
      `[DAEMON CONTROL] Current CLI version: ${currentCliVersion}, Daemon started with version: ${state.startedWithCliVersion}, status=${runningDaemon.status}`,
    );
    return currentCliVersion === state.startedWithCliVersion;
  } catch (error) {
    logger.debug('[DAEMON CONTROL] Error checking daemon version', error);
    return false;
  }
}

export async function cleanupDaemonState(): Promise<void> {
  try {
    await clearReplaceableDaemonLock();
    logger.debug('[DAEMON RUN] Replaceable daemon lock removed');
  } catch (error) {
    logger.debug('[DAEMON RUN] Error cleaning up daemon lock metadata', error);
  }
}

export type DaemonStopResult = Readonly<
  | { status: 'not_running' }
  | { status: 'stopped'; method: 'graceful' | 'force' }
>;

export type DaemonStopIncompleteReason =
  | 'startup_in_progress'
  | 'process_identity_unavailable'
  | 'process_identity_unverified'
  | 'graceful_stop_unconfirmed'
  | 'force_kill_unconfirmed'
  | 'control_client_failure';

/** A daemon may still hold process-local custody, so callers must surface this result. */
export class DaemonStopIncompleteError extends Error {
  readonly code = 'daemon_stop_incomplete';
  readonly reason: DaemonStopIncompleteReason;
  readonly pid: number | undefined;

  constructor(input: Readonly<{ reason: DaemonStopIncompleteReason; pid?: number }>) {
    super(
      input.pid === undefined
        ? `Daemon stop is incomplete (${input.reason})`
        : `Daemon stop is incomplete for PID ${input.pid} (${input.reason})`,
    );
    this.name = 'DaemonStopIncompleteError';
    this.reason = input.reason;
    this.pid = input.pid;
  }
}

export function isDaemonStopIncompleteError(error: unknown): error is DaemonStopIncompleteError {
  return (
    error instanceof DaemonStopIncompleteError
    || (
      typeof error === 'object'
      && error !== null
      && (error as { code?: unknown }).code === 'daemon_stop_incomplete'
    )
  );
}

function isProcessNotFound(error: unknown): boolean {
  const errno = error as NodeJS.ErrnoException | undefined;
  return errno?.code === 'ESRCH' || /\bESRCH\b/u.test(errno?.message ?? '');
}

async function confirmedForceStop(pid: number): Promise<DaemonStopResult> {
  await cleanupDaemonState();
  logger.debug('Force killed daemon (SIGTERM/SIGKILL)');
  return { status: 'stopped', method: 'force' };
}

async function readForceStopProcessIdentity(
  pid: number,
): Promise<NonNullable<Awaited<ReturnType<typeof readProcessIdentityByPid>>>> {
  try {
    const processIdentity = await readProcessIdentityByPid(pid);
    if (processIdentity) return processIdentity;
  } catch (error) {
    logger.debug('[CONTROL CLIENT] Could not read process identity before force stop', error);
  }
  throw new DaemonStopIncompleteError({ reason: 'process_identity_unavailable', pid });
}

async function assertForceStopIdentity(
  pid: number,
  expectedState?: Awaited<ReturnType<typeof readDaemonState>>,
): Promise<NonNullable<Awaited<ReturnType<typeof readDaemonState>>>> {
  let recordedState: NonNullable<Awaited<ReturnType<typeof readDaemonState>>>;
  let lockIdentity: Readonly<{ pid: number; processStartedAtMs: number }>;
  try {
    const state = expectedState ?? await readDaemonState();
    if (!state || state.pid !== pid) {
      throw new DaemonStopIncompleteError({ reason: 'process_identity_unverified', pid });
    }
    const currentState = await readDaemonState();
    if (!currentState || !daemonStateMatchesOwner(currentState, state)) {
      throw new DaemonStopIncompleteError({ reason: 'process_identity_unverified', pid });
    }
    const currentLockIdentity = readDaemonLockOwnerIdentity();
    if (!currentLockIdentity || currentLockIdentity.pid !== pid) {
      throw new DaemonStopIncompleteError({ reason: 'process_identity_unverified', pid });
    }
    recordedState = state;
    lockIdentity = currentLockIdentity;
  } catch (error) {
    if (isDaemonStopIncompleteError(error)) throw error;
    logger.debug('[CONTROL CLIENT] Could not read daemon lifecycle identity before force stop', error);
    throw new DaemonStopIncompleteError({ reason: 'process_identity_unavailable', pid });
  }

  let proc: Awaited<ReturnType<typeof import('@/daemon/doctor').findHappyProcessByPid>>;
  try {
    const { findHappyProcessByPid } = await import('@/daemon/doctor');
    proc = await findHappyProcessByPid(pid);
  } catch (error) {
    logger.debug('[CONTROL CLIENT] Could not verify daemon process identity before force stop', error);
    throw new DaemonStopIncompleteError({ reason: 'process_identity_unavailable', pid });
  }
  const isDaemonProcess = proc?.type === 'daemon' || proc?.type === 'dev-daemon';
  const matchesRecordedScope = !!proc
    && daemonProcessMatchesCurrentScope(proc, { requireRecordedScopeFacts: true });
  // Windows' supported CIM inventory provides an exact PID, command and
  // creation time but cannot read a process environment. State + structured
  // lifecycle lock + the exact process birth below establish the current
  // lifecycle owner there; the long-lived current-runtime command excludes
  // arbitrary Happy processes and transient wrappers without inventing a
  // parallel process registry.
  const matchesWindowsExactRuntime = !!proc
    && process.platform === 'win32'
    // A present record remains authoritative: Windows may compensate only for
    // its inventory's documented inability to read any process environment,
    // never for a recorded mismatch or missing required scope fact.
    && !proc.daemonOwnershipEnvironmentVariables
    && isDaemonProcessForCurrentRuntimeRoot(proc, projectPath());
  if (
    !proc
    || proc.pid !== pid
    || !isDaemonProcess
    || (!matchesRecordedScope && !matchesWindowsExactRuntime)
  ) {
    logger.warn(`[CONTROL CLIENT] Refusing to force-kill PID ${pid} (daemon identity does not match the active lifecycle owner)`);
    throw new DaemonStopIncompleteError({ reason: 'process_identity_unverified', pid });
  }

  const processIdentity = await readForceStopProcessIdentity(pid);
  const processStartedAtMs = processIdentity.processStartTimeMs;
  if (
    processIdentity.pid !== pid
    || typeof processStartedAtMs !== 'number'
    || !Number.isSafeInteger(processStartedAtMs)
    || processStartedAtMs < 0
    || !isDaemonCommandForCurrentRuntimeRoot(processIdentity.command, projectPath())
    // The released v1 lock's birth timestamp was derived from process.uptime,
    // so it remains a compatibility correlation only. The adjacent current
    // identity recheck below is the exact process-birth authority for signals.
    || Math.abs(processStartedAtMs - lockIdentity.processStartedAtMs) > 1_000
  ) {
    throw new DaemonStopIncompleteError({ reason: 'process_identity_unverified', pid });
  }

  try {
    const settledState = await readDaemonState();
    const settledLockIdentity = readDaemonLockOwnerIdentity();
    if (
      !settledState
      || !daemonStateMatchesOwner(settledState, recordedState)
      || !settledLockIdentity
      || settledLockIdentity.pid !== lockIdentity.pid
      || settledLockIdentity.processStartedAtMs !== lockIdentity.processStartedAtMs
    ) {
      throw new DaemonStopIncompleteError({ reason: 'process_identity_unverified', pid });
    }
  } catch (error) {
    if (isDaemonStopIncompleteError(error)) throw error;
    logger.debug('[CONTROL CLIENT] Daemon lifecycle identity changed before force stop', error);
    throw new DaemonStopIncompleteError({ reason: 'process_identity_unavailable', pid });
  }

  // Keep the exact process-identity recheck as the final awaited boundary
  // before a signal. It binds the current daemon command/type and birth to
  // one live observation, rather than combining an earlier inventory command
  // with a later, unrelated PID observation.
  const recheckedProcessIdentity = await readForceStopProcessIdentity(pid);
  if (
    recheckedProcessIdentity.pid !== pid
    || recheckedProcessIdentity.processStartTimeMs !== processStartedAtMs
    || !isDaemonCommandForCurrentRuntimeRoot(recheckedProcessIdentity.command, projectPath())
  ) {
    throw new DaemonStopIncompleteError({ reason: 'process_identity_unverified', pid });
  }
  return recordedState;
}

async function forceKillKnownDaemonPid(
  pid: number,
  expectedState?: Awaited<ReturnType<typeof readDaemonState>>,
): Promise<DaemonStopResult> {
  // A recorded lifecycle owner that is PROVABLY gone is a completed stop, not an identity
  // mismatch: there is no process left to signal and nothing left to protect. The identity gate
  // below reads a process inventory, and an inventory that finds nothing cannot tell "the pid
  // exited" apart from "the pid is not ours" or "the inventory failed" — so it refused all three
  // and left `happier daemon restart` reporting a failed stop for a daemon it had already
  // stopped. Only proven absence short-circuits here: `isPidProvablyAbsent` requires ESRCH, so
  // access-denied and unreadable-inventory verdicts stay inconclusive and still refuse below.
  // `confirmedForceStop`'s cleanup is itself ownership-guarded (it only reclaims a *replaceable*
  // lock), so a successor daemon that already took the lock is never disturbed.
  if (isPidProvablyAbsent(pid)) {
    logger.debug(`[CONTROL CLIENT] Daemon PID ${pid} has already exited; recording the stop as complete`);
    return await confirmedForceStop(pid);
  }

  const forceState = await assertForceStopIdentity(pid, expectedState);

  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (isProcessNotFound(error)) {
      return await confirmedForceStop(pid);
    }
    logger.debug('[CONTROL CLIENT] SIGTERM could not stop daemon', error);
    throw new DaemonStopIncompleteError({ reason: 'force_kill_unconfirmed', pid });
  }

  try {
    await waitForProcessDeath(pid, 2000);
    return await confirmedForceStop(pid);
  } catch (error) {
    logger.debug('[CONTROL CLIENT] Daemon remained live after SIGTERM; escalating to SIGKILL', error);
  }

  // SIGTERM may still be draining when the death wait expires; a daemon that exits in that gap is
  // stopped, and re-asserting identity against a vanished process would report the same false
  // refusal this function opens by rejecting.
  if (isPidProvablyAbsent(pid)) {
    logger.debug(`[CONTROL CLIENT] Daemon PID ${pid} exited after SIGTERM; recording the stop as complete`);
    return await confirmedForceStop(pid);
  }

  await assertForceStopIdentity(pid, forceState);

  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (isProcessNotFound(error)) {
      return await confirmedForceStop(pid);
    }
    logger.debug('[CONTROL CLIENT] SIGKILL could not stop daemon', error);
    throw new DaemonStopIncompleteError({ reason: 'force_kill_unconfirmed', pid });
  }

  try {
    await waitForProcessDeath(pid, 2000);
    return await confirmedForceStop(pid);
  } catch (error) {
    logger.debug('[CONTROL CLIENT] Daemon remained live after SIGKILL', error);
    throw new DaemonStopIncompleteError({ reason: 'force_kill_unconfirmed', pid });
  }
}

export async function forceStopKnownDaemonPid(pid: number): Promise<DaemonStopResult> {
  return await forceKillKnownDaemonPid(pid);
}

export async function stopDaemon(params: {
  stopSessions?: boolean;
} = {}): Promise<DaemonStopResult> {
  try {
    const state = await readDaemonState();
    if (!state) {
      const lockStartup = await inspectDaemonLockStartupProgress();
      if (lockStartup) {
        logger.debug('[CONTROL CLIENT] Daemon is still starting without state; refusing to stop startup lock PID');
        throw new DaemonStopIncompleteError({ reason: 'startup_in_progress', pid: lockStartup.pid });
      }

      const lockPid = readDaemonLockPid();
      if (!lockPid) {
        logger.debug('No daemon state found');
        return { status: 'not_running' };
      }

      logger.debug(`No daemon state found; falling back to daemon lock PID ${lockPid}`);
      return await forceKillKnownDaemonPid(lockPid);
    }

    logger.debug(`Stopping daemon with PID ${state.pid}`);

    // Try HTTP graceful stop
    try {
      await stopDaemonHttp({
        stopSessions: params.stopSessions === true,
      });

      // Wait for daemon to die
      await waitForProcessDeath(state.pid, resolveDaemonStopWaitForDeathTimeoutMs());
      await cleanupDaemonState();
      logger.debug('Daemon stopped gracefully via HTTP');
      return { status: 'stopped', method: 'graceful' };
    } catch (error) {
      logger.debug('HTTP stop failed, will force kill', error);
    }

    return await forceKillKnownDaemonPid(state.pid, state);
  } catch (error) {
    if (isDaemonStopIncompleteError(error)) throw error;
    logger.debug('Error stopping daemon', error);
    throw new DaemonStopIncompleteError({ reason: 'control_client_failure' });
  }
}

async function waitForProcessDeath(pid: number, timeout: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      process.kill(pid, 0);
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      if (isProcessNotFound(error)) return;
      throw error;
    }
  }
  throw new Error('Process did not die within timeout');
}
