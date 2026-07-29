/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { logger } from '@/ui/logger';
import { clearDaemonState, inspectDaemonLockOwner, readDaemonLockPid, readDaemonState } from '@/persistence';
import { Metadata } from '@/api/types';
import { projectPath } from '@/projectPath';
import { readFileSync, statSync } from 'fs';
import { configuration } from '@/configuration';
import type { SpawnDaemonSessionRequest } from '@/rpc/handlers/spawnSessionOptionsContract';
import {
  PluginLocalServicesBridgeControlResponseV1Schema,
  type PluginLocalServicesBridgeControlRequestV1,
  type PluginLocalServicesBridgeControlResponseV1,
} from './local/services/pluginBridgeProtocol';
import {
  AGENT_RUNTIME_DAEMON_BRIDGE_PATH,
  AgentRuntimeDaemonBridgeResponseV1Schema,
  type AgentRuntimeDaemonBridgeRequestV1,
  type AgentRuntimeDaemonBridgeResponseV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonBridgeProtocol';
import {
  FOREGROUND_AGENT_RUNTIME_ADMISSION_PATH,
  FOREGROUND_AGENT_RUNTIME_RELEASE_PATH,
  ForegroundAgentRuntimeAdmissionRequestV1Schema,
  ForegroundAgentRuntimeAdmissionResponseV1Schema,
  ForegroundAgentRuntimeReleaseRequestV1Schema,
  ForegroundAgentRuntimeReleaseResponseV1Schema,
  type ForegroundAgentRuntimeAdmissionRequestV1,
  type ForegroundAgentRuntimeAdmissionResponseV1,
  type ForegroundAgentRuntimeReleaseRequestV1,
} from './agentRuntime/foregroundAdmissionContract';
import {
  createProviderErrorV1,
  RestartAllSessionRunnersRequestV1Schema,
  RestartAllSessionRunnersResultV1Schema,
  RestartSessionRunnerRequestV1Schema,
  RestartSessionRunnerResultV1Schema,
  SessionRunnerStatusGetRequestV1Schema,
  SessionRunnerRuntimeStateV1Schema,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceId,
  type ConnectedServiceUsageSourceV1,
  type ProviderAccountUsageSnapshotV1,
  type RestartAllSessionRunnersRequestV1,
  type RestartAllSessionRunnersResultV1,
  type RestartSessionRunnerRequestV1,
  type RestartSessionRunnerResultV1,
  type SessionRunnerStatusGetRequestV1,
  type SessionRunnerRuntimeStateV1,
  type SessionRunnerRestartModeV1,
  type SshTunnelEnsureRequest,
  type SshTunnelEnsureResponse,
  type SshTunnelListResponse,
  type SshTunnelMutationResponse,
  type SshTunnelProbeResponse,
  type SessionUsageLimitRecoveryResumePromptModeV1,
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
import { buildDaemonControlHttpHeaders } from './controlHttp';
import {
  PluginInstallationReviewSchema,
  type PluginChangeDecision,
  type PluginChangeDecisionResult,
  type PluginChangeRequest,
  type PluginChangeRequestResult,
} from '@/plugins/daemon/changeContract';
import {
  PLUGIN_ACTION_EXECUTE_PATH,
  PLUGIN_CATALOG_READ_PATH,
  PLUGIN_CHANGE_DECISION_PATH,
  PLUGIN_CHANGE_REQUEST_PATH,
} from '@/plugins/daemon/controlRoutes';
import type { PluginActionExecutionAttempt } from '@/plugins/projection/actions/execute';
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

  try {
    process.kill(state.pid, 0);
  } catch (error) {
    const errorMessage = 'Daemon is not running, file is stale';
    logger.debug(`[CONTROL CLIENT] ${errorMessage}`);
    return {
      error: errorMessage
    };
  }

  try {
    const timeout = resolveDaemonControlTimeoutMs(path, options);
    const authToken = options.authScope === 'connected-service-run-materialize'
        ? deriveConnectedServiceRunMaterializeToken(state.controlToken)
        : state.controlToken;
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
    persistedTakeoverAdmission?: Readonly<{
      operationId: string;
      attemptId: string;
      phase: 'admit' | 'runtime_bound';
    }>;
  }> = {},
): Promise<Readonly<{
  status?: 'ok';
  error?: string;
  errorCode?: string;
  response?: unknown;
}>> {
  const { persistedTakeoverAdmission, ...requestOptions } = options;
  return await daemonPost('/session-started', {
    sessionId,
    metadata,
    ...(persistedTakeoverAdmission ? { persistedTakeoverAdmission } : {}),
  }, requestOptions);
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
  if (result && typeof result === 'object' && result.kind === 'reviewRequired') {
    const pendingChangeId = typeof result.pendingChangeId === 'string'
      ? result.pendingChangeId.trim()
      : '';
    const review = PluginInstallationReviewSchema.safeParse(result.review);
    if (!pendingChangeId || !review.success) {
      return { kind: 'unavailable', code: 'daemon_invalid_response' };
    }
    return {
      kind: 'reviewRequired',
      pendingChangeId,
      review: review.data,
    };
  }
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
  return result as PluginChangeDecisionResult;
}

export async function requestDaemonPluginActionExecution(request: Readonly<{
  actionId: string;
  input: unknown;
  surface: 'cli' | 'mcp' | 'agent';
  defaultSessionId?: string;
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

export async function requestDaemonSessionConnectedServiceAuthSwitch(
  body: Readonly<{
    sessionId: string;
    agentId: string;
    bindings: ConnectedServiceBindingsV1;
    expectedGroupGenerationByServiceId?: Readonly<Record<string, number>>;
    accountSettingsVersionHint?: number;
  }>,
  options: DaemonControlRequestOptions = {},
): Promise<unknown> {
  const result = await daemonPost('/connected-service-auth/session/switch', {
    sessionId: body.sessionId,
    agentId: body.agentId,
    bindings: body.bindings,
    ...(body.expectedGroupGenerationByServiceId === undefined
      ? {}
      : { expectedGroupGenerationByServiceId: body.expectedGroupGenerationByServiceId }),
    ...(body.accountSettingsVersionHint === undefined
      ? {}
      : { accountSettingsVersionHint: body.accountSettingsVersionHint }),
  }, options);
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
  body: Readonly<{
    sessionId: string;
    turnId?: string;
    event: 'prompt_or_steer' | 'task_started' | 'assistant_message_end' | 'turn_cancelled';
    terminalStatus?: 'completed' | 'failed';
    connectedServiceSelectionsEnvRaw?: string;
  }>,
  options: DaemonControlRequestOptions = {},
): Promise<{ error?: string } | any> {
  const response = await daemonPost('/connected-service-turn-lifecycle', {
    sessionId: body.sessionId,
    ...(body.turnId ? { turnId: body.turnId } : {}),
    event: body.event,
    ...(body.terminalStatus ? { terminalStatus: body.terminalStatus } : {}),
    ...(body.connectedServiceSelectionsEnvRaw
      ? { connectedServiceSelectionsEnvRaw: body.connectedServiceSelectionsEnvRaw }
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
    credentialFingerprint?: string | null;
    policyDisposition?: 'evidence_only';
  }>,
  options: DaemonControlRequestOptions = {},
): Promise<{ error?: string } | any> {
  return await daemonPost('/provider-account-usage-snapshot', {
    sessionId: body.sessionId,
    snapshot: body.snapshot,
    ...(body.source ? { source: body.source } : {}),
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

export type DaemonSpawnSessionResolveStatus =
  | { status: 'success'; sessionId: string }
  | { status: 'pending' }
  | { status: 'not_found' }
  | { status: 'unsupported' };

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
    if (status === 'success') {
      const sessionId = typeof (result as { sessionId?: unknown }).sessionId === 'string'
        ? (result as { sessionId: string }).sessionId.trim()
        : '';
      if (sessionId) {
        return { status: 'success', sessionId };
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

export async function dispatchDaemonPluginLocalServicesBridgeRequest(
  request: PluginLocalServicesBridgeControlRequestV1,
  options: DaemonControlRequestOptions = {},
): Promise<PluginLocalServicesBridgeControlResponseV1> {
  const result = await daemonPost('/local-services/plugin/bridge', request, options);
  if (result?.error) {
    throw new Error(String(result.error));
  }
  return PluginLocalServicesBridgeControlResponseV1Schema.parse(result);
}

export async function dispatchDaemonAgentRuntimeBridgeRequest(
  request: AgentRuntimeDaemonBridgeRequestV1,
  options: DaemonControlRequestOptions = {},
): Promise<AgentRuntimeDaemonBridgeResponseV1> {
  const result = await daemonPost(AGENT_RUNTIME_DAEMON_BRIDGE_PATH, request, {
    ...options,
    timeoutMs: options.timeoutMs === undefined ? 300_000 : options.timeoutMs,
  });
  const direct = AgentRuntimeDaemonBridgeResponseV1Schema.safeParse(result);
  if (direct.success) {
    return direct.data;
  }
  if (
    result
    && typeof result === 'object'
    && !Array.isArray(result)
    && typeof (result as Readonly<{ error?: unknown }>).error === 'string'
    && Object.hasOwn(result, 'response')
  ) {
    const remote = AgentRuntimeDaemonBridgeResponseV1Schema.safeParse(
      (result as Readonly<{ response?: unknown }>).response,
    );
    if (remote.success && remote.data.ok === false) {
      return remote.data;
    }
  }
  if (
    result
    && typeof result === 'object'
    && !Array.isArray(result)
    && typeof (result as Readonly<{ error?: unknown }>).error === 'string'
    && !Object.hasOwn(result, 'response')
  ) {
    options.signal?.throwIfAborted();
    return {
      ok: false,
      error: {
        code: 'agent_runtime_daemon_bridge_unavailable',
        message: 'Agent runtime daemon bridge is unavailable',
      },
    };
  }
  return AgentRuntimeDaemonBridgeResponseV1Schema.parse(result);
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
  transferManagedLocalServices?: boolean;
} = {}): Promise<void> {
  const result = await daemonPost('/stop', {
    ...(params.stopSessions === true ? { stopSessions: true } : {}),
    ...(params.transferManagedLocalServices === true
      ? { transferManagedLocalServices: true }
      : {}),
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
    await clearDaemonState();
    logger.debug('[DAEMON RUN] Daemon state file removed');
  } catch (error) {
    logger.debug('[DAEMON RUN] Error cleaning up daemon metadata', error);
  }
}

async function forceKillKnownDaemonPid(pid: number): Promise<void> {
  const { findHappyProcessByPid } = await import('@/daemon/doctor');
  const proc = await findHappyProcessByPid(pid);
  const safeToKill = proc?.type === 'daemon' || proc?.type === 'dev-daemon';
  if (!safeToKill) {
    logger.warn(`[CONTROL CLIENT] Refusing to force-kill PID ${pid} (does not look like a happier daemon process)`);
    await cleanupDaemonState();
    return;
  }

  try {
    process.kill(pid, 'SIGTERM');
    await waitForProcessDeath(pid, 2000).catch(() => {});
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      // already exited
    }
    await cleanupDaemonState();
    logger.debug('Force killed daemon (SIGTERM/SIGKILL)');
  } catch (error) {
    logger.debug('Daemon already dead');
    await cleanupDaemonState();
  }
}

export async function forceStopKnownDaemonPid(pid: number): Promise<void> {
  await forceKillKnownDaemonPid(pid);
}

export async function stopDaemon(params: {
  stopSessions?: boolean;
  transferManagedLocalServices?: boolean;
} = {}) {
  try {
    const state = await readDaemonState();
    if (!state) {
      const lockStartup = await inspectDaemonLockStartupProgress();
      if (lockStartup) {
        logger.debug('[CONTROL CLIENT] Daemon is still starting without state; refusing to stop startup lock PID');
        return;
      }

      const lockPid = readDaemonLockPid();
      if (!lockPid) {
        logger.debug('No daemon state found');
        return;
      }

      logger.debug(`No daemon state found; falling back to daemon lock PID ${lockPid}`);
      await forceKillKnownDaemonPid(lockPid);
      return;
    }

    logger.debug(`Stopping daemon with PID ${state.pid}`);

    // Try HTTP graceful stop
    try {
      await stopDaemonHttp({
        stopSessions: params.stopSessions === true,
        transferManagedLocalServices: params.transferManagedLocalServices === true,
      });

      // Wait for daemon to die
      await waitForProcessDeath(state.pid, resolveDaemonStopWaitForDeathTimeoutMs());
      await cleanupDaemonState();
      logger.debug('Daemon stopped gracefully via HTTP');
      return;
    } catch (error) {
      logger.debug('HTTP stop failed, will force kill', error);
    }

    await forceKillKnownDaemonPid(state.pid);
  } catch (error) {
    logger.debug('Error stopping daemon', error);
  }
}

async function waitForProcessDeath(pid: number, timeout: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      process.kill(pid, 0);
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch {
      return; // Process is dead
    }
  }
  throw new Error('Process did not die within timeout');
}
