/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { logger } from '@/ui/logger';
import { readDaemonState } from '@/persistence';
import { Metadata } from '@/api/types';
import { projectPath } from '@/projectPath';
import { existsSync, readFileSync, statSync } from 'fs';
import { configuration } from '@/configuration';
import { probeDaemonAuthenticatedControl } from './controlLiveness';
import type { SpawnDaemonSessionRequest } from '@/rpc/handlers/spawnSessionOptionsContract';
import { DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS } from '@/daemon/spawn/waitForSessionWebhook';
import {
  CODEX_CHATGPT_AUTH_TOKENS_REFRESH_PATH,
  CodexChatGptAuthTokensRefreshResponseSchema,
  type CodexChatGptAuthTokensRefreshResponse,
  type CodexChatGptAuthTokensRefreshSelection,
} from '@/backends/codex/connectedServices/codexChatGptAuthTokensRefreshBridgeContract';
import {
  CLAUDE_SUBSCRIPTION_AUTH_TOKENS_REFRESH_PATH,
  ClaudeSubscriptionAuthTokensRefreshResponseSchema,
  type ClaudeSubscriptionAuthTokensRefreshResponse,
  type ClaudeSubscriptionAuthTokensRefreshSelection,
} from '@/backends/claude/connectedServices/claudeSubscriptionAuthTokensRefreshBridgeContract';
import {
  ConnectedServiceBridgeRefreshFailureResponseSchema,
  type ConnectedServiceBridgeRefreshFailureResponse,
} from './connectedServices/refresh/bridgeRefreshFailureContract';
import {
  deriveConnectedServiceBrokerRefreshToken,
  deriveConnectedServiceRunMaterializeToken,
} from '@/daemon/connectedServices/broker/brokerRefreshCapabilityToken';
import {
  EXECUTION_RUN_CONNECTED_SERVICE_MATERIALIZE_PATH,
  EXECUTION_RUN_CONNECTED_SERVICE_RELEASE_PATH,
  ExecutionRunConnectedServiceMaterializeResponseSchema,
  ExecutionRunConnectedServiceReleaseResponseSchema,
  type ExecutionRunConnectedServiceMaterializeResponseWire,
} from '@/daemon/connectedServices/runsBridge/contract';
import {
  type ConnectedServiceTurnLifecycleRequestBody,
  type ConnectedServiceTurnLifecycleResult,
} from '@/daemon/connectedServices/connectedServiceTurnLifecycleContract';
import { resolveComparableCliVersion } from './resolveComparableCliVersion';
import {
  RestartAllSessionRunnersRequestV1Schema,
  RestartAllSessionRunnersResultV1Schema,
  RestartSessionRunnerRequestV1Schema,
  RestartSessionRunnerResultV1Schema,
  SessionRunnerRuntimeStateV1Schema,
  SessionRunnerStatusGetRequestV1Schema,
  SPAWN_SESSION_ERROR_CODES,
  isSpawnSessionErrorDetail,
  type ConnectedServiceBindingsV1,
  type ConnectedServiceId,
  type RestartAllSessionRunnersRequestV1,
  type RestartAllSessionRunnersResultV1,
  type RestartSessionRunnerRequestV1,
  type RestartSessionRunnerResultV1,
  type SessionRunnerRestartModeV1,
  type SessionRunnerRuntimeStateV1,
  type SessionRunnerStatusGetRequestV1,
  type SpawnSessionNonceResolution,
} from '@happier-dev/protocol';
import {
  StopSessionResultSchema,
  type StopSessionResult,
} from './sessions/stopSessionContract';
import { readProcessRunState } from './processRunState';

export type DaemonControlRequestOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

type DaemonPostAuthScope = 'daemon-control' | 'connected-service-broker-refresh' | 'connected-service-run-materialize';

type DaemonPostOptions = DaemonControlRequestOptions & {
  authScope?: DaemonPostAuthScope;
};

const DEFAULT_DAEMON_HTTP_TIMEOUT_MS = 10_000;
const DEFAULT_DAEMON_SPAWN_HTTP_TIMEOUT_MS = DEFAULT_SESSION_WEBHOOK_TIMEOUT_MS;
const DEFAULT_DAEMON_PING_TIMEOUT_MS = 3_000;
const DEFAULT_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS = 12_000;
const DEFAULT_DAEMON_SHUTDOWN_SPAWN_DRAIN_GRACE_MS = 10_000;
const DAEMON_STATE_FRESHNESS_GRACE_MS = 60_000;
const DAEMON_LOCK_UNCLASSIFIED_STARTUP_GRACE_MS = 60_000;
const admittedDaemonStartupLocks = new Map<number, number>();
const DAEMON_HTTP_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_HTTP_TIMEOUT';
const DAEMON_SPAWN_HTTP_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_SPAWN_HTTP_TIMEOUT';
const DAEMON_PING_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_PING_TIMEOUT_MS';
const DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS';
const DAEMON_SHUTDOWN_SPAWN_DRAIN_GRACE_ENV_KEY = 'HAPPIER_DAEMON_SHUTDOWN_SPAWN_DRAIN_GRACE_MS';

export type OpenAiCodexDaemonRefreshSelection = CodexChatGptAuthTokensRefreshSelection;
export type OpenAiCodexChatGptAuthTokensRefreshResult = CodexChatGptAuthTokensRefreshResponse;
export type DaemonSessionRunnerRestartMode = SessionRunnerRestartModeV1;
export type RestartAllDaemonSessionRunnersRequest = RestartAllSessionRunnersRequestV1;
export type RestartAllDaemonSessionRunnersResult = RestartAllSessionRunnersResultV1;
export type GetDaemonSessionRunnerStatusRequest = SessionRunnerStatusGetRequestV1;
export type GetDaemonSessionRunnerStatusResult = SessionRunnerRuntimeStateV1;

function resolveDaemonStateAgeMs(state: unknown): number | null {
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

  // Fall back to file mtime if timestamps are missing; freshly written state should back off.
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

function resolveDaemonLockMtimeMs(): number | null {
  try {
    const stat = statSync(configuration.daemonLockFile);
    if (Number.isFinite(stat.mtimeMs)) {
      return stat.mtimeMs;
    }
  } catch {
    // ignore
  }
  return null;
}

function resolveDaemonLockAgeMs(): number | null {
  const mtimeMs = resolveDaemonLockMtimeMs();
  return mtimeMs === null ? null : Math.max(0, Date.now() - mtimeMs);
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

function resolveDaemonControlTimeoutMs(path: string, options: DaemonControlRequestOptions): number {
  if (options.timeoutMs !== undefined) {
    return resolvePositiveIntValue(options.timeoutMs, DEFAULT_DAEMON_HTTP_TIMEOUT_MS, { min: 100, max: 300_000 });
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

type DaemonPersistedState = NonNullable<Awaited<ReturnType<typeof readDaemonState>>>;

export type DaemonRunningInspection =
  | { status: 'not-running' }
  | { status: 'starting'; state: DaemonPersistedState }
  | { status: 'starting'; pid: number }
  | { status: 'running'; state: DaemonPersistedState };

async function inspectDaemonLockStartupProgress(): Promise<DaemonRunningInspection | null> {
  const lockPid = readDaemonLockPid();
  if (!lockPid) return null;

  try {
    process.kill(lockPid, 0);
  } catch {
    admittedDaemonStartupLocks.delete(lockPid);
    return null;
  }

  const { findHappyProcessByPid } = await import('@/daemon/doctor');
  const proc = await findHappyProcessByPid(lockPid).catch(() => null);
  const safeToTreatAsStarting = proc?.type === 'daemon' || proc?.type === 'dev-daemon';
  if (!safeToTreatAsStarting) {
    if (proc) {
      admittedDaemonStartupLocks.delete(lockPid);
      return null;
    }

    const lockMtimeMs = resolveDaemonLockMtimeMs();
    if (lockMtimeMs !== null && admittedDaemonStartupLocks.get(lockPid) === lockMtimeMs) {
      const runState = await readProcessRunState(lockPid);
      if (runState === 'dead' || runState === 'zombie') {
        admittedDaemonStartupLocks.delete(lockPid);
        return null;
      }
      logger.debug('[DAEMON RUN] Daemon lock is held by a previously admitted live daemon before state was written, treating startup as in progress');
      return { status: 'starting', pid: lockPid };
    }

    const lockAgeMs = resolveDaemonLockAgeMs();
    if (lockAgeMs !== null && lockAgeMs <= DAEMON_LOCK_UNCLASSIFIED_STARTUP_GRACE_MS) {
      logger.debug('[DAEMON RUN] Daemon lock is held by a fresh live unclassified process before state was written, treating startup as in progress');
      return { status: 'starting', pid: lockPid };
    }

    logger.debug('[DAEMON RUN] Daemon lock is held by a stale live unclassified process before state was written, ignoring startup lock');
    return null;
  }

  const lockMtimeMs = resolveDaemonLockMtimeMs();
  if (lockMtimeMs !== null) admittedDaemonStartupLocks.set(lockPid, lockMtimeMs);
  logger.debug('[DAEMON RUN] Daemon lock is held by a live daemon before state was written, treating startup as in progress');
  return { status: 'starting', pid: lockPid };
}

export async function inspectDaemonRunningStateAndCleanupStaleState(): Promise<DaemonRunningInspection> {
  const state = await readDaemonState();
  if (!state) {
    const lockStartup = await inspectDaemonLockStartupProgress();
    if (lockStartup) return lockStartup;
    return { status: 'not-running' };
  }

  if (state.controlToken && (!state.httpPort || typeof state.httpPort !== 'number')) {
    logger.debug('[DAEMON RUN] Daemon state missing httpPort, preserving daemon-owned state for startup replacement');
    return { status: 'not-running' };
  }

  try {
    process.kill(state.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ESRCH') {
      logger.debug('[DAEMON RUN] Daemon PID is definitively not running, leaving daemon-owned state for startup replacement');
      return { status: 'not-running' };
    }

    const ageMs = resolveDaemonStateAgeMs(state);
    if (ageMs !== null && ageMs < DAEMON_STATE_FRESHNESS_GRACE_MS) {
      logger.debug('[DAEMON RUN] Daemon PID liveness is inconclusive and state heartbeat is fresh, keeping state as startup in progress');
      return { status: 'starting', state };
    }

    logger.debug('[DAEMON RUN] Daemon PID liveness is inconclusive and state is stale, keeping state fail-closed');
    return { status: 'starting', state };
  }

  try {
    if (state.controlToken) {
      const liveness = await probeDaemonAuthenticatedControl({
        pid: state.pid,
        httpPort: state.httpPort,
        controlToken: state.controlToken,
        timeoutMs: resolveDaemonPingTimeoutMs(),
      });
      if (liveness === 'unauthorized') {
        logger.debug('[DAEMON RUN] Daemon /ping rejected control token, preserving daemon-owned state for startup replacement');
        return { status: 'not-running' };
      }
      if (liveness === 'pid_not_running') {
        logger.debug('[DAEMON RUN] Daemon PID stopped during authenticated liveness probe, leaving daemon-owned state for startup replacement');
        return { status: 'not-running' };
      }
      if (liveness === 'unreachable') {
        logger.debug('[DAEMON RUN] Daemon /ping unreachable while PID is alive, treating daemon as starting or busy and keeping state');
        return { status: 'starting', state };
      }
    }

    return { status: 'running', state };
  } catch {
    const ageMs = resolveDaemonStateAgeMs(state);
    if (ageMs !== null && ageMs < DAEMON_STATE_FRESHNESS_GRACE_MS) {
      logger.debug('[DAEMON RUN] Daemon PID is missing but state heartbeat is fresh, keeping state as startup in progress');
      return { status: 'starting', state };
    }

    logger.debug('[DAEMON RUN] Daemon PID not running and state is stale, leaving daemon-owned state for startup replacement');
    return { status: 'not-running' };
  }
}

async function daemonPost(path: string, body?: any, options: DaemonPostOptions = {}): Promise<{ error?: string } | any> {
  const state = await readDaemonState();
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
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const authToken = options.authScope === 'connected-service-broker-refresh'
      ? deriveConnectedServiceBrokerRefreshToken(state.controlToken)
      : options.authScope === 'connected-service-run-materialize'
        ? deriveConnectedServiceRunMaterializeToken(state.controlToken)
        : state.controlToken;
    if (authToken) {
      headers['x-happier-daemon-token'] = authToken;
    }
    const response = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {}),
      // Mostly increased for stress test
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout)
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

export class DaemonConnectedServiceRefreshError extends Error {
  readonly errorCode: ConnectedServiceBridgeRefreshFailureResponse['errorCode'];
  readonly credentialHealthStatus: ConnectedServiceBridgeRefreshFailureResponse['credentialHealthStatus'];

  constructor(response: ConnectedServiceBridgeRefreshFailureResponse) {
    super(response.errorCode);
    this.name = 'DaemonConnectedServiceRefreshError';
    this.errorCode = response.errorCode;
    this.credentialHealthStatus = response.credentialHealthStatus;
  }
}

function throwDaemonConnectedServiceRefreshErrorIfPresent(result: unknown): void {
  const response = ConnectedServiceBridgeRefreshFailureResponseSchema.safeParse(
    result && typeof result === 'object' && 'response' in result
      ? (result as { response?: unknown }).response
      : result,
  );
  if (response.success) throw new DaemonConnectedServiceRefreshError(response.data);
}

export async function notifyDaemonSessionStarted(
  sessionId: string,
  metadata: Metadata,
  options: DaemonControlRequestOptions = {},
): Promise<{ error?: string } | any> {
  return await daemonPost('/session-started', {
    sessionId,
    metadata,
  }, options);
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
    rematerializeServiceId?: string;
    expectedGroupGenerationByServiceId?: Readonly<Record<string, number>>;
    accountSettingsVersionHint?: number;
  }>,
  options: DaemonControlRequestOptions = {},
): Promise<unknown> {
  const result = await daemonPost('/connected-service-auth/session/switch', {
    sessionId: body.sessionId,
    agentId: body.agentId,
    bindings: body.bindings,
    ...(body.accountSettingsVersionHint === undefined
      ? {}
      : { accountSettingsVersionHint: body.accountSettingsVersionHint }),
    ...(body.rematerializeServiceId === undefined
      ? {}
      : { rematerializeServiceId: body.rematerializeServiceId }),
    ...(body.expectedGroupGenerationByServiceId === undefined
      ? {}
      : { expectedGroupGenerationByServiceId: body.expectedGroupGenerationByServiceId }),
  }, {
    timeoutMs: resolveDaemonSessionConnectedServiceAuthSwitchTimeoutMs(),
    ...options,
  });
  if (result?.error) {
    throw new Error(String(result.error));
  }
  return (result as { result?: unknown } | null)?.result;
}

/**
 * The group-generation apply fans out to EVERY live session bound to the group, and each
 * per-session switch may legitimately wait a full turn-boundary deferral window (60s) before it can
 * restart the session. The generic 10s daemonPost default aborted the ack while the daemon-side
 * apply kept running (observed live 2026-07-10 16:29) — the UI then reported a divergence for a
 * switch that succeeded. Bound the ack with deferral + restart margin instead.
 */
export async function notifyDaemonConnectedServiceRuntimeAuthFailure(
  body: Readonly<{
    reportId?: string;
    sessionId: string;
    switchesThisTurn?: number;
    classification: unknown;
    resumePromptMode?: 'standard' | 'off' | 'custom';
  }>,
  options: DaemonControlRequestOptions = {},
): Promise<{ error?: string } | any> {
  return await daemonPost('/connected-service-runtime-auth/failure', {
    ...(body.reportId ? { reportId: body.reportId } : {}),
    sessionId: body.sessionId,
    switchesThisTurn: body.switchesThisTurn ?? 0,
    classification: body.classification,
    ...(body.resumePromptMode ? { resumePromptMode: body.resumePromptMode } : {}),
  }, options);
}

export async function notifyDaemonConnectedServiceTurnLifecycle(
  body: ConnectedServiceTurnLifecycleRequestBody,
  options: DaemonControlRequestOptions = {},
): Promise<ConnectedServiceTurnLifecycleResult | { error?: string }> {
  const response = await daemonPost('/connected-service-turn-lifecycle', {
    sessionId: body.sessionId,
    event: body.event,
    ...(body.terminalStatus ? { terminalStatus: body.terminalStatus } : {}),
    ...(body.turnId ? { turnId: body.turnId } : {}),
    ...(body.requestedAction ? { requestedAction: body.requestedAction } : {}),
    ...(body.activeTurnId !== undefined ? { activeTurnId: body.activeTurnId } : {}),
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

/**
 * QAE-1: propagates a user "Stop waiting" (wait-resume cancel) to the daemon so
 * its durable recovery wait state (runtime-auth recovery + inactive usage-limit
 * stores) is cancelled too. Best-effort local control call.
 */
export async function notifyDaemonConnectedServiceUsageLimitWaitResumeCancel(
  body: Readonly<{ sessionId: string; attemptId: string }>,
  options: DaemonControlRequestOptions = {},
): Promise<{ error?: string } | any> {
  return await daemonPost('/connected-service-usage-limit/wait-resume-cancel', {
    sessionId: body.sessionId,
    attemptId: body.attemptId,
  }, options);
}

export async function notifyDaemonConnectedServiceQuotaSnapshot(
  body: Readonly<{
    sessionId: string;
    serviceId: string;
    groupId?: string | null;
    groupGeneration?: number | null;
    sourceProviderAccountId?: string | null;
    credentialFingerprint?: string | null;
    policyDisposition?: 'evidence_only';
    snapshot: unknown;
  }>,
  options: DaemonControlRequestOptions = {},
): Promise<{ error?: string } | any> {
  return await daemonPost('/connected-service-quota-snapshot', {
    sessionId: body.sessionId,
    serviceId: body.serviceId,
    ...(body.groupId !== undefined ? { groupId: body.groupId } : {}),
    ...(body.groupGeneration !== undefined ? { groupGeneration: body.groupGeneration } : {}),
    ...(body.sourceProviderAccountId !== undefined ? { sourceProviderAccountId: body.sourceProviderAccountId } : {}),
    ...(body.credentialFingerprint !== undefined ? { credentialFingerprint: body.credentialFingerprint } : {}),
    ...(body.policyDisposition ? { policyDisposition: body.policyDisposition } : {}),
    snapshot: body.snapshot,
  }, options);
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

export async function refreshDaemonOpenAiCodexChatGptAuthTokensForBridge(
  body: Readonly<{
    sessionId: string;
    selection: CodexChatGptAuthTokensRefreshSelection;
    chatgptPlanType: string | null;
    forceRefresh?: boolean;
    failingAccessTokenFingerprint?: string | null;
  }>,
  options: DaemonControlRequestOptions = {},
): Promise<CodexChatGptAuthTokensRefreshResponse> {
  const result = await daemonPost(CODEX_CHATGPT_AUTH_TOKENS_REFRESH_PATH, {
    sessionId: body.sessionId,
    selection: body.selection,
    chatgptPlanType: body.chatgptPlanType,
    ...(body.forceRefresh === true ? { forceRefresh: true } : {}),
    ...(body.failingAccessTokenFingerprint ? { failingAccessTokenFingerprint: body.failingAccessTokenFingerprint } : {}),
    // SEC-F1: per-session SDK callbacks authenticate with the MASTER control token (session mode).
    // The scoped broker-refresh token is identity-mode only and would be rejected for this
    // sessionId-keyed request shape.
  }, options);
  if (result?.error) {
    throwDaemonConnectedServiceRefreshErrorIfPresent(result);
    throw new Error(String(result.error));
  }
  const parsed = CodexChatGptAuthTokensRefreshResponseSchema.safeParse(
    (result as { result?: unknown } | null)?.result,
  );
  if (!parsed.success) {
    throw new Error('Invalid daemon Codex ChatGPT refresh response');
  }
  return parsed.data;
}

export async function refreshDaemonClaudeSubscriptionAnthropicAuthTokensForBridge(
  body: Readonly<{
    sessionId: string;
    selection: ClaudeSubscriptionAuthTokensRefreshSelection;
    forceRefresh?: boolean;
    failingAccessTokenFingerprint?: string | null;
  }>,
  options: DaemonControlRequestOptions = {},
): Promise<ClaudeSubscriptionAuthTokensRefreshResponse> {
  const result = await daemonPost(CLAUDE_SUBSCRIPTION_AUTH_TOKENS_REFRESH_PATH, {
    sessionId: body.sessionId,
    selection: body.selection,
    ...(body.forceRefresh === true ? { forceRefresh: true } : {}),
    ...(body.failingAccessTokenFingerprint ? { failingAccessTokenFingerprint: body.failingAccessTokenFingerprint } : {}),
    // SEC-F1: session mode uses the MASTER control token (see Codex twin above).
  }, options);
  if (result?.error) {
    throwDaemonConnectedServiceRefreshErrorIfPresent(result);
    throw new Error(String(result.error));
  }
  const parsed = ClaudeSubscriptionAuthTokensRefreshResponseSchema.safeParse(
    (result as { result?: unknown } | null)?.result,
  );
  if (!parsed.success) {
    throw new Error('Invalid daemon Claude subscription refresh response');
  }
  return parsed.data;
}

/**
 * A1: materialization is real work (staged home copy + a possible OAuth refresh + group selection),
 * so the materialize call gets its OWN bounded timeout instead of riding the generic 10s daemonPost
 * default — a 10s client abandonment while the daemon succeeds seconds later was the leak window.
 * Session precedent: the spawn webhook wait allows 5min; this defaults tighter at 2min.
 */
const EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_ENV_KEY = 'HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS';
const DEFAULT_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS = 120_000;

export function resolveExecutionRunConnectedServiceMaterializeTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  return resolvePositiveIntValue(
    env[EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_ENV_KEY],
    DEFAULT_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS,
    { min: 1_000, max: 600_000 },
  );
}

/**
 * ER-CS run-materialization bridge (runner → daemon). Asks the daemon (sole CS owner) to
 * resolve+materialize+register connected services for an execution run and returns the env map to
 * merge into the run's isolation bundle. Uses the DEDICATED run-materialize capability token
 * (`happier:connected-service-run-materialize:v1` — narrower than the broker-refresh scope) and the
 * canonical bounded `daemonPost` transport with a materialization-sized timeout (see above).
 * Fail-closed: any transport/handler error throws — a run with a CS selection must never silently
 * fall back to the runner's inherited account; the caller then fires the idempotent reclaim release.
 */
export async function materializeDaemonConnectedServicesForExecutionRun(
  body: Readonly<{
    runId: string;
    agentId: string;
    pid: number;
    materializationKey: string;
    connectedServicesBindingsRaw: unknown;
    sessionDirectory?: string | null;
    sessionId?: string;
  }>,
  options: DaemonControlRequestOptions = {},
): Promise<ExecutionRunConnectedServiceMaterializeResponseWire> {
  const result = await daemonPost(EXECUTION_RUN_CONNECTED_SERVICE_MATERIALIZE_PATH, {
    runId: body.runId,
    agentId: body.agentId,
    pid: body.pid,
    materializationKey: body.materializationKey,
    connectedServicesBindingsRaw: body.connectedServicesBindingsRaw,
    ...(body.sessionDirectory !== undefined ? { sessionDirectory: body.sessionDirectory } : {}),
    ...(body.sessionId ? { sessionId: body.sessionId } : {}),
  }, {
    timeoutMs: resolveExecutionRunConnectedServiceMaterializeTimeoutMs(),
    ...options,
    authScope: 'connected-service-run-materialize',
  });
  if (result?.error) {
    throw new Error(String(result.error));
  }
  const parsed = ExecutionRunConnectedServiceMaterializeResponseSchema.safeParse(
    (result as { result?: unknown } | null)?.result,
  );
  if (!parsed.success) {
    throw new Error('Invalid daemon execution-run connected-service materialize response');
  }
  return parsed.data;
}

/**
 * ER-CS run-end lifecycle (runner → daemon): unregister the run's runtime target and clean its
 * run-scoped materialized root. Best-effort — a failed release must not fail run teardown.
 */
export async function releaseDaemonConnectedServicesForExecutionRun(
  body: Readonly<{
    runId: string;
    pid: number;
    materializationKey: string;
  }>,
  options: DaemonControlRequestOptions = {},
): Promise<boolean> {
  const result = await daemonPost(EXECUTION_RUN_CONNECTED_SERVICE_RELEASE_PATH, {
    runId: body.runId,
    pid: body.pid,
    materializationKey: body.materializationKey,
  }, { ...options, authScope: 'connected-service-run-materialize' });
  if (result?.error) return false;
  const parsed = ExecutionRunConnectedServiceReleaseResponseSchema.safeParse(
    (result as { result?: unknown } | null)?.result,
  );
  return parsed.success ? parsed.data.released : false;
}

/**
 * Query the daemon whether the OpenCode broker plugin reported its load handshake (F4) for a given
 * connected-service selection identity. Uses the broad daemon control token (Happier's own trusted
 * query — distinct from the broker's scoped registration). Returns false on any error/unreachable.
 */
export async function queryDaemonOpenCodeBrokerLoadHandshake(
  selectionIdentity: string,
  loadNonce: string,
  providers: readonly string[],
  pluginVersion: string,
  runtimeKind: 'opencode_managed_server' | 'pi_rpc_process',
  options: DaemonControlRequestOptions = {},
): Promise<boolean> {
  const result = await daemonPost('/connected-service-auth/opencode-broker/loaded-status', {
    selectionIdentity,
    loadNonce,
    providers,
    pluginVersion,
    runtimeKind,
  }, options);
  if (!result || typeof result !== 'object' || (result as { error?: unknown }).error) return false;
  return (result as { observed?: unknown }).observed === true;
}

export async function listDaemonSessions(): Promise<any[]> {
  const result = await daemonPost('/list');
  return result.children || [];
}

export async function stopDaemonSession(sessionId: string): Promise<StopSessionResult> {
  const result = await daemonPost('/stop-session', { sessionId });
  return StopSessionResultSchema.parse(result);
}

export async function spawnDaemonSession(directory: string, sessionId?: string): Promise<any>;
export async function spawnDaemonSession(request: SpawnDaemonSessionRequest): Promise<any>;
export async function spawnDaemonSession(
  directoryOrRequest: string | SpawnDaemonSessionRequest,
  sessionId?: string,
): Promise<any> {
  const request = typeof directoryOrRequest === 'string'
    ? { directory: directoryOrRequest, ...(sessionId ? { sessionId } : {}) }
    : directoryOrRequest;

  const result = await daemonPost('/spawn-session', request);
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
      const errorCode = typeof (result as { errorCode?: unknown }).errorCode === 'string'
        ? (result as { errorCode: string }).errorCode
        : '';
      const errorMessage = typeof (result as { errorMessage?: unknown }).errorMessage === 'string'
        ? (result as { errorMessage: string }).errorMessage.trim()
        : '';
      if ((Object.values(SPAWN_SESSION_ERROR_CODES) as string[]).includes(errorCode) && errorMessage) {
        const errorDetailRaw = (result as { errorDetail?: unknown }).errorDetail;
        return {
          status: 'error',
          errorCode: errorCode as (typeof SPAWN_SESSION_ERROR_CODES)[keyof typeof SPAWN_SESSION_ERROR_CODES],
          errorMessage,
          ...(isSpawnSessionErrorDetail(errorDetailRaw) ? { errorDetail: errorDetailRaw } : {}),
        };
      }
      return { status: 'not_found' };
    }
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

/**
 * The session-runner restart handler blocks on the respawn completion (kill the tracked runner, spawn
 * the replacement on the current CLI, await its webhook) — default completion budget 60s. Riding the
 * generic 10s daemonPost default guaranteed the internal control request aborted while the respawn was
 * still in flight, so a succeeding restart was reported as a failure. Give it a completion-sized
 * timeout that clears the respawn-completion budget with margin.
 */
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
    throw new Error('Invalid daemon session runner restart response');
  }
  return parsed.data;
}

export async function getDaemonSessionRunnerStatus(
  request: GetDaemonSessionRunnerStatusRequest,
  options: DaemonControlRequestOptions = {},
): Promise<GetDaemonSessionRunnerStatusResult> {
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

export async function stopDaemonHttp(params: { stopSessions?: boolean } = {}): Promise<void> {
  const result = await daemonPost('/stop', params.stopSessions ? { stopSessions: true } : {});
  if (result?.error) {
    throw new Error(result.error);
  }
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

/**
 * Best-effort health check for a running daemon.
 * Returns false when the daemon is absent or busy; client-side ping timeouts do not delete daemon-owned state.
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
    logger.debug('[DAEMON CONTROL] Daemon is still starting without state, returning false');
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

function readDaemonLockPid(): number | null {
  try {
    if (!existsSync(configuration.daemonLockFile)) {
      return null;
    }

    const raw = readFileSync(configuration.daemonLockFile, 'utf-8').trim();
    const pid = Number.parseInt(raw, 10);
    if (!Number.isFinite(pid) || pid <= 0) {
      return null;
    }

    return pid;
  } catch {
    return null;
  }
}

async function forceKillKnownDaemonPid(pid: number): Promise<void> {
  const { findHappyProcessByPid } = await import('@/daemon/doctor');
  const proc = await findHappyProcessByPid(pid);
  const safeToKill = proc?.type === 'daemon' || proc?.type === 'dev-daemon';
  if (!safeToKill) {
    logger.warn(`[CONTROL CLIENT] Refusing to force-kill PID ${pid} (does not look like a happier daemon process)`);
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
    logger.debug('Force killed daemon (SIGTERM/SIGKILL)');
  } catch (error) {
    logger.debug('Daemon already dead');
  }
}

export async function forceStopKnownDaemonPid(pid: number): Promise<void> {
  await forceKillKnownDaemonPid(pid);
}

export async function stopDaemon(params: { stopSessions?: boolean } = {}) {
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
      await stopDaemonHttp({ stopSessions: params.stopSessions === true });

      // Wait for daemon to die
      await waitForProcessDeath(state.pid, resolveDaemonStopWaitForDeathTimeoutMs());
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
