/**
 * HTTP client helpers for daemon communication
 * Used by CLI commands to interact with running daemon
 */

import { isPidPresent, isPidProvablyAbsent } from '@happier-dev/cli-common/process';
import type { SessionFollowOccurrenceNotification } from './sessions/sessionActivityChangedContract';
import { SessionActivityChangedResponseSchema, type SessionActivityChangedResult } from './sessions/sessionActivityChangedContract';
export type { SessionActivityChangedResult } from './sessions/sessionActivityChangedContract';
import {
  processGenerationMatches,
  readProcessInstanceFingerprintSync,
} from '@happier-dev/cli-common/processInstance';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import type { ActionExecuteResult, ActionExecutorContext } from '@happier-dev/protocol';
import { projectActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { logger } from '@/ui/logger';
import type { ConnectedServiceUxDiagnosticV1 } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import {
  clearReplaceableDaemonLock,
  daemonStateMatchesOwner,
  inspectDaemonLockOwner,
  readDaemonLockOwnerIdentity,
  readDaemonLockPid,
  readDaemonLockSnapshot,
  readDaemonState,
  reclaimDeadDaemonPublication,
} from '@/persistence';
import {
  daemonProcessMatchesCurrentScope,
  isDaemonCommandForCurrentRuntimeRoot,
  isDaemonProcessForCurrentRuntimeRoot,
} from '@/daemon/ownership/daemonProcessScopeIdentity';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import { classifyDaemonLifecycleProcessByPid } from '@/daemon/processInspection';
import { Metadata, type SessionCreationOutcome } from '@/api/types';
import { projectPath, projectPathFromModuleUrl } from '@/projectPath';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'fs';
import { configuration } from '@/configuration';
import type { SpawnDaemonSessionRequest } from '@/rpc/handlers/spawnSessionOptionsContract';
import {
  FOREGROUND_AGENT_RUNTIME_ADMISSION_PATH,
  FOREGROUND_AGENT_RUNTIME_CLAIM_PATH,
  FOREGROUND_AGENT_RUNTIME_RELEASE_PATH,
  FOREGROUND_AGENT_RUNTIME_SESSION_OPTIONS_PATH,
  ForegroundAgentRuntimeAdmissionRequestV1Schema,
  ForegroundAgentRuntimeAdmissionResponseV1Schema,
  ForegroundAgentRuntimeClaimRequestV1Schema,
  ForegroundAgentRuntimeClaimResponseV1Schema,
  ForegroundAgentRuntimeReleaseRequestV1Schema,
  ForegroundAgentRuntimeReleaseResponseV1Schema,
  ForegroundAgentRuntimeSessionOptionsRequestV1Schema,
  ForegroundAgentRuntimeSessionOptionsResponseV1Schema,
  type ForegroundAgentRuntimeAdmissionRequestV1,
  type ForegroundAgentRuntimeAdmissionResponseV1,
  type ForegroundAgentRuntimeClaimRequestV1,
  type ForegroundAgentRuntimeClaimResponseV1,
  type ForegroundAgentRuntimeReleaseRequestV1,
  type ForegroundAgentRuntimeSessionOptionsRequestV1,
  type ForegroundAgentRuntimeSessionOptionsResponseV1,
} from './agentRuntime/foregroundAdmissionContract';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';
import { normalizeSpawnSessionNonceResolution } from '@happier-dev/protocol/sessions/spawnSessionNonce';
import { RestartAllSessionRunnersRequestV1Schema, RestartAllSessionRunnersResultV1Schema, RestartSessionRunnerRequestV1Schema, RestartSessionRunnerResultV1Schema } from '@happier-dev/protocol/sessions/control/sessionRunnerRestartV1';
import { RestartSessionRunnerRequestV2Schema, RestartSessionRunnerConfirmedBackgroundRequestSchema } from '@happier-dev/protocol/sessions/control/sessionRunnerRestartV2';
import type { ConnectedServiceBindingsV2, ConnectedAccountServiceKey, ConnectedServiceId, ConnectedServiceUsageSourceV1, ProviderAccountUsageSnapshotV1, RestartAllSessionRunnersRequestV1, RestartAllSessionRunnersResultV1, RestartSessionRunnerRequestV1, RestartSessionRunnerRequestV2, RestartSessionRunnerResultV1, SessionRunnerRestartModeV1, SessionMetadataPublisherPreconditionV1, SshTunnelEnsureRequest, SshTunnelEnsureResponse, SshTunnelListResponse, SshTunnelMutationResponse, SshTunnelProbeResponse, SessionUsageLimitRecoveryResumePromptModeV1, SpawnSessionNonceResolution } from '@happier-dev/protocol';
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
import {
  CONNECTED_SERVICE_APPLIED_PARENT_SELECTION_PATH,
  ConnectedServiceAppliedParentSelectionResultSchema,
  type ConnectedServiceAppliedParentSelectionRequest,
  type ConnectedServiceAppliedParentSelectionResult,
  CONNECTED_SERVICE_RUN_MATERIALIZE_PATH,
  CONNECTED_SERVICE_RUN_GENERATION_CURRENT_PATH,
  CONNECTED_SERVICE_RUN_RELEASE_PATH,
  CONNECTED_SERVICE_RUN_REJECTED_START_PATH,
  CONNECTED_SERVICE_RUN_REFRESH_RUNTIME_AUTH_PATH,
  CONNECTED_SERVICE_RUN_RECOVER_RUNTIME_FAILURE_PATH,
  CONNECTED_SERVICE_RUN_RUNTIME_TURN_COMPLETED_PATH,
  ConnectedServiceRunRuntimeTurnCompletedResultSchema,
  ConnectedServiceRunRuntimeFailureRecoveryResultSchema,
  type ConnectedServiceRunRuntimeFailureRecoveryRequest,
  type ConnectedServiceRunRuntimeFailureRecoveryResult,
  ConnectedServiceRunRuntimeAuthRefreshRequestSchema,
  type ConnectedServiceRunRuntimeAuthRefreshRequest,
  type ConnectedServiceRunRejectedStartRequest,
  ConnectedServiceRunRejectedStartResultSchema,
  type ConnectedServiceRunRejectedStartResult,
  type ConnectedServiceRunMaterializeRequest,
  ConnectedServiceRunMaterializeSuccessResponseSchema,
  ConnectedServiceRunReleaseResultSchema,
  type ConnectedServiceRunReleaseRequest,
  type ConnectedServiceRunGenerationCurrentRequest,
  type ExecutionRunConnectedServicesRegistrationV1,
} from './connectedServices/runs/materializeContract';
import { resolveComparableCliVersion } from './resolveComparableCliVersion';
import { ConnectedServiceDaemonAuthBridgeRefreshResultSchema } from './connectedServices/sessionRuntimeAuthRefresh';
import type {
  PersistedTakeoverAdmissionPhase,
  TakeoverAdmissionMode,
} from './spawn/persistedTakeoverAdmission';
import { daemonPost, type DaemonControlRequestOptions } from './controlHttp';
import { DaemonAdmissionRefusalCodeSchema, EXECUTION_RUN_ADMISSION_PATH, ExecutionRunDaemonAdmissionResponseSchema } from './lifecycle/admissionDrain';
import { sanitizeConnectedServiceDiagnosticString } from './connectedServices/runtimeAuth/sanitizeConnectedServiceDiagnosticString';
export type { DaemonControlRequestOptions } from './controlHttp';
import { inspectDaemonPublicationPresence, type DaemonPublicationPresenceInspection } from './controlLiveness';
import {
  type PluginChangeDecision,
  type PluginChangeDecisionResult,
  type PluginChangeRequest,
  type PluginChangeRequestResult,
  type PluginChangeStatusRequest,
  type PluginChangeStatusResult,
  type PluginChangeTerminalResult,
  type PluginPendingChangeEntry,
} from '@/plugins/daemon/changeContract';
import type { UserPluginChangeListResult } from '@/plugins/daemon/changeClient';
import { PluginChangePendingReviewResultSchema } from '@happier-dev/protocol/marketplace/internal';
import type { PluginChangePendingReviewResult } from '@happier-dev/protocol/marketplace/internal';
import {
  PLUGIN_ACTION_EXECUTE_PATH,
  PLUGIN_CATALOG_READ_PATH,
  PLUGIN_CHANGE_DECISION_PATH,
  PLUGIN_CHANGE_LIST_PATH,
  PLUGIN_CHANGE_REQUEST_PATH,
  PLUGIN_CHANGE_STATUS_PATH,
  PLUGIN_DEVELOPMENT_CONTROL_PATH,
} from '@/plugins/daemon/controlRoutes';
import type {
  DaemonPluginDevelopmentControlRequest,
  DaemonPluginDevelopmentControlResult,
} from '@/plugins/daemon/developmentRoots';
import type { PluginActionExecutionAttempt } from '@/plugins/runtime/invocation/actions/executeContributedAction';
import {
  SIGNED_ROOT_ACTION_EXECUTE_PATH,
  type SignedRootActionExecuteRequest,
} from './externalActions/signedRootActionControl';
import type { PluginCatalogEntry } from '@/plugins/projection/catalog/installed';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import { resolveAbsolutePathFromWorkingDirectory } from '@/utils/path/expandHomeDirPath';
import { SKILL_SESSION_DIR_PATH, SKILL_USAGE_PATH, SkillSessionStartupIdentitySchema, RecordSkillUseInputSchema,
  RecordSkillUseResultSchema } from '@/prompts/skills/store/controlRoutes';
import { EnsureSkillSessionDirResultSchema, type EnsureSkillSessionDirInput, type EnsureSkillSessionDirResult } from '@/prompts/skills/store/skillStore';
import type { RecordSkillUseInput } from '@/prompts/skills/store/skillUsage';

const DEFAULT_DAEMON_PING_TIMEOUT_MS = 3_000;

export async function recordDaemonSkillUse(input: RecordSkillUseInput, options: DaemonControlRequestOptions = {}): Promise<void> {
  const response = RecordSkillUseResultSchema.safeParse(await daemonPost(SKILL_USAGE_PATH, RecordSkillUseInputSchema.parse(input), {
    ...options, mutation: true,
  }));
  if (!response.success) throw Object.assign(new Error('Skill usage recording is unavailable'), { code: 'skills_unavailable' });
}

export async function ensureSkillSessionDirHttp(input: EnsureSkillSessionDirInput,
  options: DaemonControlRequestOptions = {}, startupIdentity?: Readonly<{ pid: number; metadata: unknown }>): Promise<EnsureSkillSessionDirResult> {
  // The store queue belongs to this request's lifetime; the caller may still supply its own deadline.
  const response = EnsureSkillSessionDirResultSchema.safeParse(await daemonPost(SKILL_SESSION_DIR_PATH, {
    ...input, ...(startupIdentity ? { startupIdentity: SkillSessionStartupIdentitySchema.parse(startupIdentity) } : {}),
  }, {
    timeoutMs: null, ...options, mutation: true,
  }));
  if (!response.success) throw Object.assign(new Error('Skill delivery is unavailable'), { code: 'skills_unavailable' });
  return response.data;
}

/** Ask the daemon's current admission owner; no state is copied into the Session host. */
export async function admitDaemonExecutionRunStart(options: DaemonControlRequestOptions = {}): Promise<void> {
  const response = ExecutionRunDaemonAdmissionResponseSchema.safeParse(await daemonPost(EXECUTION_RUN_ADMISSION_PATH, {}, {
    ...options, authScope: 'connected-service-run-materialize',
  }));
  if (!response.success) throw Object.assign(new Error('Daemon admission is unavailable'), { code: 'daemon_admission_unavailable' });
  if (!response.data.admitted) throw Object.assign(new Error(response.data.reason), { code: response.data.reason });
}
const DEFAULT_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS = 12_000;
const DEFAULT_DAEMON_SHUTDOWN_SPAWN_DRAIN_GRACE_MS = 10_000;
const DAEMON_STATE_FRESHNESS_GRACE_MS = 60_000;
const DAEMON_PING_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_PING_TIMEOUT_MS';
const DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_ENV_KEY = 'HAPPIER_DAEMON_STOP_WAIT_FOR_DEATH_TIMEOUT_MS';
const DAEMON_SHUTDOWN_SPAWN_DRAIN_GRACE_ENV_KEY = 'HAPPIER_DAEMON_SHUTDOWN_SPAWN_DRAIN_GRACE_MS';
const EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_ENV_KEY = 'HAPPIER_EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_MS';

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

export function resolveExecutionRunConnectedServiceMaterializeTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  // Root writers wait for their live predecessor; elapsed time does not revoke
  // their authority. Only an explicitly configured caller deadline bounds this phase.
  const raw = env[EXECUTION_RUN_CS_MATERIALIZE_TIMEOUT_ENV_KEY]?.trim();
  const parsed = raw ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
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
      if (state.controlToken) {
        const presence = await inspectPublishedDaemonPresence(state);
        if (presence.status === 'running') return { status: 'running', state };
        if (presence.status === 'unverified') return { status: 'starting', state };
      }
      // State can still name a departed predecessor while its successor owns the
      // lifecycle lock and has not published its own state yet.
      const lockStartup = await inspectDaemonLockStartupProgress();
      if (lockStartup) return lockStartup;
      return { status: 'not-running' };
    }

    logger.debug('[DAEMON RUN] Daemon PID liveness is inconclusive, keeping state fail-closed');
    return { status: 'starting', state };
  }

  const ownerProcess = await classifyDaemonLifecycleProcessByPid(state.pid)
    .catch(() => ({ kind: 'unknown' as const }));

  if (state.httpPort === 0) {
    return ownerProcess.kind === 'not_daemon'
      ? { status: 'not-running' }
      : { status: 'starting', state };
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
        if (ownerProcess.kind === 'not_daemon') {
          logger.debug('[DAEMON RUN] Daemon control is unreachable and its state PID belongs to an unrelated process, treating state as replaceable');
          return { status: 'not-running' };
        }
        logger.debug('[DAEMON RUN] Daemon /ping unreachable while PID is alive, treating daemon as busy/unknown and keeping state');
        return { status: 'starting', state };
      }

      return { status: 'running', state };
    }

    if (ownerProcess.kind === 'not_daemon') {
      logger.debug('[DAEMON RUN] Daemon state PID belongs to an unrelated process, treating state as replaceable');
      return { status: 'not-running' };
    }

    return { status: 'running', state };
  } catch {
    if (ownerProcess.kind === 'not_daemon') {
      logger.debug('[DAEMON RUN] Daemon control probe failed and its state PID belongs to an unrelated process, treating state as replaceable');
      return { status: 'not-running' };
    }
    const ageMs = resolveDaemonStateFreshnessAgeMs(state);
    if (ageMs !== null && ageMs <= DAEMON_STATE_FRESHNESS_GRACE_MS) {
      logger.debug('[DAEMON RUN] Daemon PID is not running but state is still fresh, keeping state while startup arbitration settles');
      return { status: 'starting', state };
    }

    logger.debug('[DAEMON RUN] Daemon PID is not running and state is stale, treating daemon as replaceable without client cleanup');
    return { status: 'not-running' };
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
  httpStatus?: number;
  transportErrorCode?: string;
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
  }, { ...requestOptions, includeFailureDiagnostics: true });
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
  const kind = (result as Readonly<Record<string, unknown>>).kind;
  // Non-review arms fall through to the caller's own result handling.
  if (kind !== 'reviewRequired') return undefined;
  const parsed = PluginChangePendingReviewResultSchema.safeParse(result);
  return parsed.success ? parsed.data : null;
}

function pluginControlOptions(options: DaemonControlRequestOptions): DaemonControlRequestOptions {
  // Plugin work follows its caller lifetime, including an explicit untimed wait.
  return { ...options, timeoutMs: options.timeoutMs ?? null };
}

export async function requestDaemonPluginChange(
  request: PluginChangeRequest,
  options: DaemonControlRequestOptions = {},
): Promise<PluginChangeRequestResult | Readonly<{ kind: 'unavailable'; code: string }>> {
  const result = await daemonPost(PLUGIN_CHANGE_REQUEST_PATH, request, {
    ...pluginControlOptions(options),
    mutation: true,
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
    ...pluginControlOptions(options),
    mutation: true,
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
  const result = await daemonPost(PLUGIN_CHANGE_STATUS_PATH, request, pluginControlOptions(options));
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
 * Absence of pending changes is authoritative only when the daemon answers
 * successfully. Transport failures and malformed responses remain distinct so
 * callers cannot present unknown daemon state as a truthful empty list.
 */
export async function listDaemonPluginChanges(
  options: DaemonControlRequestOptions = {},
): Promise<UserPluginChangeListResult> {
  const result = await daemonPost(PLUGIN_CHANGE_LIST_PATH, {}, pluginControlOptions(options));
  if (!result || typeof result !== 'object' || typeof result.error === 'string') {
    return {
      kind: 'unavailable',
      code: result && typeof result === 'object' && typeof result.errorCode === 'string'
        ? result.errorCode
        : 'daemon_unavailable',
    };
  }
  const changes = (result as Readonly<Record<string, unknown>>).changes;
  if (!Array.isArray(changes)) return { kind: 'unavailable', code: 'invalid_daemon_response' };
  return {
    kind: 'available',
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

export async function controlDaemonPluginDevelopment(
  request: DaemonPluginDevelopmentControlRequest,
  options: DaemonControlRequestOptions = {},
): Promise<DaemonPluginDevelopmentControlResult> {
  const normalizedRequest: DaemonPluginDevelopmentControlRequest = request.kind === 'status'
    ? request
    : request.kind === 'registerWorkspace'
      ? {
          ...request,
          projectRoot: resolveAbsolutePathFromWorkingDirectory(request.projectRoot)
            ?? request.projectRoot,
        }
      : {
          ...request,
          rootPath: resolveAbsolutePathFromWorkingDirectory(request.rootPath)
            ?? request.rootPath,
        };
  const result = await daemonPost(PLUGIN_DEVELOPMENT_CONTROL_PATH, normalizedRequest, {
    ...pluginControlOptions(options),
    mutation: request.kind !== 'status',
  });
  if (result && typeof result === 'object' && typeof result.error === 'string') {
    return {
      kind: 'failed',
      code: result.errorCode ?? 'daemon_unavailable',
      message: result.error,
      status: { roots: [], plugins: [] },
    };
  }
  if (!result || typeof result !== 'object' || typeof result.kind !== 'string') {
    return {
      kind: 'failed',
      code: 'daemon_invalid_response',
      message: 'The daemon returned an invalid plugin development response',
      status: { roots: [], plugins: [] },
    };
  }
  return result as DaemonPluginDevelopmentControlResult;
}

export async function requestDaemonPluginActionExecution(request: Readonly<{
  actionId: string;
  input: unknown;
  requiredDangerLevel?: 'safe';
  surface: 'cli' | 'mcp' | 'agent';
  defaultSessionId?: string;
  /** Host-stamped descriptive starter, not an authorization principal. */
  startedBy?: import('@happier-dev/protocol').WorkflowRunStartedByV1;
  /** Host-stamped turn admission fence; never Action input or SDK surface. */
  expectedContributorOccurrenceId?: string;
}>, options: DaemonControlRequestOptions = {}): Promise<PluginActionExecutionAttempt> {
  const result = await daemonPost(PLUGIN_ACTION_EXECUTE_PATH, request, {
    ...pluginControlOptions(options),
    mutation: true,
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
  options: DaemonControlRequestOptions & Readonly<{ authorityCeiling?: 'account_automation' }> = {},
): Promise<ActionExecuteResult> {
  if (options.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
  const spec = getActionSpec(request.actionId);
  const { sideEffectClass } = spec;
  const executionPlacement = resolveActionExecutionPlacementForInput(spec, request.input);
  // These roots compose the same daemon-owned change and development controls.
  const usesPluginControl = request.actionId === 'plugins.install'
    || request.actionId === 'plugins.uninstall'
    || request.actionId === 'plugins.dev.submit'
    || request.actionId === 'plugins.dev.unregister'
    || request.actionId === 'plugins.reload'
    || request.actionId === 'plugins.change.status'
    || request.actionId === 'plugins.list';
  const result = await daemonPost(SIGNED_ROOT_ACTION_EXECUTE_PATH, request, {
    ...options,
    // Creation, Stop/refresh completion and wait observation have domain-owned lifetimes;
    // client and contributed Actions may also wait for approval and completion.
    timeoutMs: options.timeoutMs !== undefined ? options.timeoutMs
      : usesPluginControl ? pluginControlOptions(options).timeoutMs
      : request.actionId === 'session.spawn_new' || request.actionId === 'session.wait.idle' || request.actionId === 'session.stop'
        || request.actionId === 'workflow.run.wait' || request.actionId === 'execution.run.wait' || request.actionId === 'wait'
        || (request.actionId === 'action.operations.get' && request.input && typeof request.input === 'object'
          && 'waitForTerminal' in request.input && request.input.waitForTerminal === true)
        || request.actionId === 'session.runtime.refresh' || request.actionId === 'action.invoke' || executionPlacement === 'client'
        || request.actionId === 'daemon.filesystem.upload' || request.actionId === 'daemon.filesystem.download'
        || (request.actionId === 'daemon.filesystem.copy' && request.input && typeof request.input === 'object'
          && 'kind' in request.input && request.input.kind === 'prepared_transfer') ? null : 300_000,
    mutation: sideEffectClass !== 'none' && sideEffectClass !== 'read',
  });
  if (result && typeof result === 'object' && typeof result.error === 'string') {
    return projectActionExecuteFailure({
      ...result,
      ok: false,
      errorCode: result.errorCode ?? 'daemon_unavailable',
      error: result.error,
    });
  }
  return result as ActionExecuteResult;
}

export async function readDaemonPluginCatalog(
  options: DaemonControlRequestOptions & import('@/plugins/daemon/catalogProjection').DaemonPluginCatalogReadRequest = {},
): Promise<
  | Readonly<{
      kind: 'available';
      plugins: readonly PluginCatalogEntry[];
      tools: readonly ProjectedPluginToolCatalogEntry[];
      projection?: import('@/plugins/daemon/catalogProjection').DaemonPluginCatalogProjection;
    }>
  | Readonly<{ kind: 'unavailable'; code: string }>
> {
  const { selection, ...transportOptions } = options;
  const result = await daemonPost(PLUGIN_CATALOG_READ_PATH, selection ? { selection } : {}, transportOptions);
  if (result && typeof result === 'object' && typeof result.error === 'string') {
    // The catalog route carries its typed refusal in a service-unavailable
    // body. HTTP transport retains that body under `response`; preserve the
    // catalog owner's code rather than replacing it with a transport label.
    const response: unknown = result.response;
    if (response && typeof response === 'object' && 'kind' in response
      && response.kind === 'unavailable' && 'code' in response
      && typeof response.code === 'string') {
      return { kind: 'unavailable', code: response.code };
    }
    return { kind: 'unavailable', code: result.errorCode ?? 'daemon_unavailable' };
  }
  const parsed = result as
    | Readonly<{
        kind: 'available';
        plugins: readonly PluginCatalogEntry[];
        tools?: readonly ProjectedPluginToolCatalogEntry[];
        projection?: import('@/plugins/daemon/catalogProjection').DaemonPluginCatalogProjection;
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
    bindings: ConnectedServiceBindingsV2;
    rematerializeServiceId?: ConnectedAccountServiceKey;
    expectedGroupGenerationByServiceId?: Readonly<Record<string, number>>;
    accountSettingsVersionHint?: number;
    teamCredentialBindings?: import('@happier-dev/protocol/teams').SessionTeamCredentialBindingIntentListV1;
    previousTeamCredentialBindings?: import('@happier-dev/protocol/teams').SessionTeamCredentialBindingIntentListV1;
    teamVisibilityGrantConsent?: Readonly<{ teamId: string }>;
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
    ...(body.teamCredentialBindings === undefined
      ? {}
      : { teamCredentialBindings: body.teamCredentialBindings }),
    ...(body.previousTeamCredentialBindings === undefined
      ? {}
      : { previousTeamCredentialBindings: body.previousTeamCredentialBindings }),
    ...(body.teamVisibilityGrantConsent === undefined
      ? {}
      : { teamVisibilityGrantConsent: body.teamVisibilityGrantConsent }),
    ...(body.accountSettingsVersionHint === undefined
      ? {}
      : { accountSettingsVersionHint: body.accountSettingsVersionHint }),
  }, {
    timeoutMs: resolveDaemonSessionConnectedServiceAuthSwitchTimeoutMs(),
    ...options,
  });
  throwIfDaemonAdmissionRefused(result);
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
  return normalizeDaemonRuntimeAuthRefreshResponse(result, body.refreshAttemptId);
}

function normalizeDaemonRuntimeAuthRefreshResponse(
  value: unknown,
  refreshAttemptId: string,
): ConnectedServiceDaemonAuthBridgeRefreshResult {
  throwIfDaemonAdmissionRefused(value);
  const result = value && typeof value === 'object' ? value as Record<string, unknown> : null;
  if (result?.error || result?.errorCode) {
    if (result.errorCode === 'timeout' || (!result.errorCode && typeof result.error === 'string' && /abort|timed?\s*out|timeout/iu.test(result.error))) {
      return {
        status: 'pending',
        refreshAttemptId,
      };
    }
    throw new Error(String(result.errorCode ?? result.error));
  }
  const parsed = ConnectedServiceDaemonAuthBridgeRefreshResultSchema.safeParse(result?.result);
  if (!parsed.success) return { status: 'failed', reason: 'runtime_auth_refresh_invalid_bridge_result' };
  if (parsed.data.status === 'pending' && parsed.data.refreshAttemptId !== refreshAttemptId) {
    return { status: 'failed', reason: 'runtime_auth_refresh_attempt_mismatch' };
  }
  return parsed.data;
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

/** Invalidation only: the daemon re-reads the current host and never trusts a reported idle Boolean. */
export async function notifyDaemonSessionActivityChanged(sessionId: string | null, followOccurrence?: SessionFollowOccurrenceNotification): Promise<SessionActivityChangedResult> {
  const response: unknown = await daemonPost('/session-activity-changed', { sessionId, ...(followOccurrence ? { followOccurrence } : {}) });
  const parsed = SessionActivityChangedResponseSchema.safeParse(response);
  if (!parsed.success || (parsed.data.personalFollow && parsed.data.personalFollow.sourceSessionId !== sessionId)) {
    throw new Error('session_activity_notification_unavailable');
  }
  return parsed.data.personalFollow ? { personalFollow: parsed.data.personalFollow } : {};
}

export async function notifyDaemonConnectedServiceUsageLimitWaitResumeCancel(
  body: Readonly<{ sessionId: string; attemptId: string }>,
  options: DaemonControlRequestOptions = {},
): Promise<{ error?: string } | any> {
  return await daemonPost('/connected-service-usage-limit/wait-resume-cancel', body, options);
}

export async function notifyDaemonConnectedServiceQuotaRecoveryCreditConsume(
  body: Readonly<{
    serviceId: ConnectedAccountServiceKey;
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
    sourceProviderAccountId?: string;
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
    ...(body.sourceProviderAccountId ? { sourceProviderAccountId: body.sourceProviderAccountId } : {}),
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
  if (result?.error) {
    throw new Error(String(result.error));
  }
  return result.children || [];
}

export async function stopDaemonSession(
  sessionId: string,
  options: DaemonControlRequestOptions = {},
): Promise<StopSessionResult> {
  const result = await daemonPost('/stop-session', { sessionId }, options);
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

export async function resolveDaemonSpawnSessionByNonce(
  spawnNonce: string,
  timeoutOrOptions?: number | DaemonControlRequestOptions,
): Promise<DaemonSpawnSessionResolveStatus> {
  const normalizedSpawnNonce = spawnNonce.trim();
  if (!normalizedSpawnNonce) {
    return { status: 'not_found' };
  }
  const options = typeof timeoutOrOptions === 'number' ? { timeoutMs: timeoutOrOptions } : timeoutOrOptions;
  const timeoutMs = options?.timeoutMs;
  const result = await daemonPost('/spawn-session/resolve', {
    spawnNonce: normalizedSpawnNonce,
    ...(typeof timeoutMs === 'number' ? { timeoutMs } : {}),
  }, {
    ...options,
    // The resolve owner, and the caller's containing wait, own this deadline.
    // The generic control HTTP timeout must not shorten a valid nonce wait.
    ...(typeof timeoutMs === 'number' ? { timeoutMs: null } : {}),
  });
  if (result && typeof result === 'object' && typeof (result as { status?: unknown }).status === 'string') {
    return normalizeSpawnSessionNonceResolution(result);
  }

  const errorMessage = typeof (result as { error?: unknown } | null)?.error === 'string'
    ? (result as { error: string }).error
    : '';
  if (errorMessage.includes('/spawn-session/resolve') && errorMessage.includes('HTTP 404')) {
    return { status: 'unsupported' };
  }
  if (errorMessage) throw new Error(errorMessage);

  return { status: 'not_found' };
}

export type DaemonSessionRunnerRestartMode = SessionRunnerRestartModeV1;
export type RestartAllDaemonSessionRunnersRequest = RestartAllSessionRunnersRequestV1;
export type RestartAllDaemonSessionRunnersResult = RestartAllSessionRunnersResultV1;

async function requestDaemonSessionRunnerRestartOperation(
  path: '/session-runners/restart' | '/session-runners/restart-confirmed-background' | '/session-runners/restart-v2',
  request: RestartSessionRunnerRequestV1 | RestartSessionRunnerRequestV2,
  options: DaemonControlRequestOptions,
): Promise<RestartSessionRunnerResultV1> {
  const body = path === '/session-runners/restart-confirmed-background'
    ? RestartSessionRunnerConfirmedBackgroundRequestSchema.parse(request)
    : path === '/session-runners/restart-v2'
      ? RestartSessionRunnerRequestV2Schema.parse(request)
      : RestartSessionRunnerRequestV1Schema.parse(request);
  // The canonical retirement and respawn lifecycle owns completion; caller cancellation remains live.
  const result = await daemonPost(path, body, { timeoutMs: null, ...options });
  throwIfDaemonAdmissionRefused(result);
  if (result?.error) throw new Error(String(result.error));
  const parsed = RestartSessionRunnerResultV1Schema.safeParse(result);
  if (!parsed.success) throw new Error('Invalid daemon session runner restart response');
  return parsed.data;
}

export async function requestDaemonSessionRunnerRestart(
  request: RestartSessionRunnerRequestV1,
  options: DaemonControlRequestOptions = {},
): Promise<RestartSessionRunnerResultV1> {
  return await requestDaemonSessionRunnerRestartOperation('/session-runners/restart', request, options);
}

export async function requestDaemonSessionRunnerRestartConfirmedBackground(
  request: RestartSessionRunnerRequestV1 | RestartSessionRunnerRequestV2,
  options: DaemonControlRequestOptions = {},
): Promise<RestartSessionRunnerResultV1> {
  return await requestDaemonSessionRunnerRestartOperation('/session-runners/restart-confirmed-background', request, options);
}

export async function requestDaemonSessionRunnerRestartV2(
  request: RestartSessionRunnerRequestV2,
  options: DaemonControlRequestOptions = {},
): Promise<RestartSessionRunnerResultV1> {
  return await requestDaemonSessionRunnerRestartOperation('/session-runners/restart-v2', request, options);
}

export async function restartAllDaemonSessionRunners(
  request: RestartAllDaemonSessionRunnersRequest,
  options: DaemonControlRequestOptions = {},
): Promise<RestartAllDaemonSessionRunnersResult> {
  const body = RestartAllSessionRunnersRequestV1Schema.parse(request);
  const result = await daemonPost('/session-runners/restart-all', body, {
    timeoutMs: null,
    ...options,
  });
  throwIfDaemonAdmissionRefused(result);
  if (result?.error) {
    throw new Error(String(result.error));
  }
  const parsed = RestartAllSessionRunnersResultV1Schema.safeParse(result);
  if (!parsed.success) {
    throw new Error('Invalid daemon session runner restart-all response');
  }
  return parsed.data;
}

/** Preserve daemon lifecycle refusals before parsing operation-specific responses. */
function throwIfDaemonAdmissionRefused(result: unknown): void {
  if (!result || typeof result !== 'object' || !('errorCode' in result)) return;
  const code = DaemonAdmissionRefusalCodeSchema.safeParse(result.errorCode);
  if (!code.success) return;
  const message = 'error' in result && typeof result.error === 'string' ? result.error : code.data;
  throw Object.assign(new Error(message), { code: code.data });
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
  throwIfDaemonAdmissionRefused(result);
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
  throwIfDaemonAdmissionRefused(result);
  return ForegroundAgentRuntimeClaimResponseV1Schema.parse(result);
}

export async function resolveDaemonForegroundAgentRuntimeSessionOptions(
  request: ForegroundAgentRuntimeSessionOptionsRequestV1,
  options: DaemonControlRequestOptions = {},
): Promise<ForegroundAgentRuntimeSessionOptionsResponseV1> {
  const body = ForegroundAgentRuntimeSessionOptionsRequestV1Schema.parse(request);
  const result = await daemonPost(
    FOREGROUND_AGENT_RUNTIME_SESSION_OPTIONS_PATH,
    body,
    options,
  );
  throwIfDaemonAdmissionRefused(result);
  return ForegroundAgentRuntimeSessionOptionsResponseV1Schema.parse(result);
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
  throwIfDaemonAdmissionRefused(result);
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
export async function readAppliedParentConnectedServices(
  request: ConnectedServiceAppliedParentSelectionRequest,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<ConnectedServiceAppliedParentSelectionResult> {
  const response = await daemonPost(CONNECTED_SERVICE_APPLIED_PARENT_SELECTION_PATH, request, {
    authScope: 'connected-service-run-materialize',
    signal: options.signal,
  });
  const parsed = ConnectedServiceAppliedParentSelectionResultSchema.safeParse(response);
  return parsed.success ? parsed.data : { status: 'unavailable' };
}

export async function requestExecutionRunConnectedServicesMaterialization(
  request: Omit<ConnectedServiceRunMaterializeRequest, 'activationId'>,
  options: Readonly<{ signal?: AbortSignal }> = {},
): Promise<
  | { ok: true; result: { activationId: string; env: Record<string, string>; unsetEnvKeys?: readonly string[]; connectedServicesBindings: unknown; registration: ExecutionRunConnectedServicesRegistrationV1 } }
  | { ok?: false; error?: string; errorCode?: string; errorMessage?: string; uxDiagnostic?: ConnectedServiceUxDiagnosticV1 }
> {
  options.signal?.throwIfAborted();
  // Allocate the existing activation identity before dispatch, so a lost
  // successful response cannot take exact cleanup custody away from the runner.
  const activationId = randomUUID();
  const state = await readDaemonState();
  if (!state?.httpPort) return { ok: false, error: 'No daemon running, no state file found' };
  const target = { pid: state.pid, httpPort: state.httpPort, controlToken: state.controlToken };
  options.signal?.throwIfAborted();
  const response: unknown = await daemonPost(CONNECTED_SERVICE_RUN_MATERIALIZE_PATH, { ...request, activationId }, {
    authScope: 'connected-service-run-materialize',
    timeoutMs: resolveExecutionRunConnectedServiceMaterializeTimeoutMs(),
    target,
    signal: options.signal,
  });
  const parsed = ConnectedServiceRunMaterializeSuccessResponseSchema.safeParse(response);
  const identityMatches = parsed.success && parsed.data.result.activationId === activationId
    && parsed.data.result.registration.activationId === activationId;
  if (parsed.success && identityMatches && !options.signal?.aborted) return parsed.data;

  // Keep cleanup independent of the ended observation and on the issuing daemon.
  // The canonical release owner distinguishes absence from retained cleanup failure.
  const cleanup = ConnectedServiceRunReleaseResultSchema.safeParse(await releaseExecutionRunConnectedServices({
    runId: request.runId, runnerPid: request.runnerPid, activationId,
  }, { target }));
  if (!cleanup.success || !cleanup.data.ok) {
    const errorCode = cleanup.success && !cleanup.data.ok
      ? cleanup.data.errorCode : 'connected_service_run_cleanup_failed';
    logger.warn('[EXECUTION RUN] Abandoned materialization cleanup did not complete', {
      runId: request.runId, activationId, errorCode,
    });
    return { ok: false, errorCode, errorMessage: 'Execution-run connected-services cleanup did not complete' };
  }
  if (parsed.success && !identityMatches) {
    return { ok: false, errorCode: 'connected_service_run_activation_mismatch',
      errorMessage: 'Execution-run connected-services activation did not match its request' };
  }
  const failure = response && typeof response === 'object' ? response as Record<string, unknown> : null;
  // HTTP failures retain the domain body under response. The materialization
  // and rejected-start owners share this typed refusal envelope.
  const refusal = ConnectedServiceRunRejectedStartResultSchema.safeParse(failure?.response ?? response);
  if (refusal.success && !refusal.data.ok) {
    return { ok: false, errorCode: refusal.data.errorCode,
      ...(refusal.data.uxDiagnostic ? { uxDiagnostic: refusal.data.uxDiagnostic } : {}),
      ...(typeof failure?.error === 'string' ? { error: sanitizeConnectedServiceDiagnosticString(failure.error) } : {}),
      errorMessage: refusal.data.errorMessage
        ? sanitizeConnectedServiceDiagnosticString(refusal.data.errorMessage)
        : 'Execution-run connected-services materialization failed',
    };
  }
  return { ok: false,
    ...(typeof failure?.errorCode === 'string' ? { errorCode: sanitizeConnectedServiceDiagnosticString(failure.errorCode) } : {}),
    ...(typeof failure?.error === 'string' ? { error: sanitizeConnectedServiceDiagnosticString(failure.error) } : {}),
    errorMessage: typeof failure?.errorMessage === 'string' ? sanitizeConnectedServiceDiagnosticString(failure.errorMessage) : 'Execution-run connected-services materialization failed',
  };
}

/**
 * Runner → daemon: release an execution run's connected-services materialization (unregister the
 * run from the canonical runtime registry, run retained cleanup). Best-effort at run end.
 */
export async function releaseExecutionRunConnectedServices(
  request: ConnectedServiceRunReleaseRequest,
  options: Pick<DaemonControlRequestOptions, 'target'> = {},
): Promise<{ ok?: boolean; released?: boolean; error?: string; errorCode?: string }> {
  return await daemonPost(CONNECTED_SERVICE_RUN_RELEASE_PATH, request, {
    ...options,
    authScope: 'connected-service-run-materialize',
  });
}

export async function recoverExecutionRunConnectedServicesRejectedStart(
  request: ConnectedServiceRunRejectedStartRequest,
): Promise<ConnectedServiceRunRejectedStartResult | { ok?: false; error?: string; errorCode?: string; errorMessage?: string }> {
  return await daemonPost(CONNECTED_SERVICE_RUN_REJECTED_START_PATH, request, {
    authScope: 'connected-service-run-materialize',
    timeoutMs: resolveExecutionRunConnectedServiceMaterializeTimeoutMs(),
  });
}

export async function completeExecutionRunConnectedServiceRuntimeTurn(request: ConnectedServiceRunReleaseRequest): Promise<void> {
  const response = await daemonPost(CONNECTED_SERVICE_RUN_RUNTIME_TURN_COMPLETED_PATH, request, {
    authScope: 'connected-service-run-materialize',
  });
  const parsed = ConnectedServiceRunRuntimeTurnCompletedResultSchema.safeParse(response);
  if (!parsed.success || !parsed.data.accepted) throw new Error('connected_service_run_completion_unavailable');
}

export async function recoverExecutionRunConnectedServiceRuntimeFailure(
  request: ConnectedServiceRunRuntimeFailureRecoveryRequest,
  options: Readonly<{ signal: AbortSignal }>,
): Promise<ConnectedServiceRunRuntimeFailureRecoveryResult> {
  const response = await daemonPost(CONNECTED_SERVICE_RUN_RECOVER_RUNTIME_FAILURE_PATH, request, {
    authScope: 'connected-service-run-materialize', timeoutMs: null, signal: options.signal,
  });
  const parsed = ConnectedServiceRunRuntimeFailureRecoveryResultSchema.safeParse(response);
  return parsed.success ? parsed.data : { status: 'failed', reason: 'runtime_recovery_unavailable' };
}

export async function requestExecutionRunConnectedServiceRuntimeAuthRefresh(
  request: Omit<ConnectedServiceRunRuntimeAuthRefreshRequest, 'selection' | 'serviceId' | 'expectedCredentialRevision'> & Readonly<{
    serviceId: string;
    selection: unknown;
    expectedCredentialRevision: string;
  }>,
  options: DaemonControlRequestOptions = {},
): Promise<ConnectedServiceDaemonAuthBridgeRefreshResult> {
  const selection = request.selection && typeof request.selection === 'object'
    ? request.selection as Record<string, unknown> : null;
  // Plugin-owned selection hints include policy/revision. Only identity crosses this closed
  // authority envelope; revision has its own explicit, daemon-validated request field.
  const parsed = ConnectedServiceRunRuntimeAuthRefreshRequestSchema.safeParse({ ...request,
    selection: selection?.kind === 'profile'
      ? { kind: selection.kind, serviceId: selection.serviceId, profileId: selection.profileId }
      : selection?.kind === 'group' ? { kind: selection.kind, serviceId: selection.serviceId,
        groupId: selection.groupId, activeProfileId: selection.activeProfileId,
        fallbackProfileId: selection.fallbackProfileId, generation: selection.generation } : null,
  });
  if (!parsed.success) return { status: 'unavailable', reason: 'connected_service_run_refresh_forbidden' };
  const result = await daemonPost(CONNECTED_SERVICE_RUN_REFRESH_RUNTIME_AUTH_PATH, parsed.data, {
    ...options, authScope: 'connected-service-run-materialize',
  });
  try {
    return normalizeDaemonRuntimeAuthRefreshResponse(result, parsed.data.refreshAttemptId);
  } catch {
    return { status: 'unavailable', reason: 'connected_service_run_refresh_unavailable' };
  }
}

export async function checkExecutionRunConnectedServicesGenerationCurrent(
  request: ConnectedServiceRunGenerationCurrentRequest,
  options: Readonly<Pick<DaemonControlRequestOptions, 'signal' | 'timeoutMs'>> = {},
): Promise<{ ok?: boolean; current?: boolean; error?: string }> {
  return await daemonPost(CONNECTED_SERVICE_RUN_GENERATION_CURRENT_PATH, request, {
    ...options,
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

async function confirmedForceStop(pid: number, observation?: PublishedDaemonOwnerObservation): Promise<DaemonStopResult> {
  if (observation) await observation.reclaimIfDead();
  else {
    const state = await readDaemonState();
    if (!state || state.pid === pid) await reclaimDeadDaemonPublication({ expectedState: state, expectedPid: pid });
  }
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
  let lockIdentity: NonNullable<ReturnType<typeof readDaemonLockOwnerIdentity>>;
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
  // Stop follows the published owner across CLI upgrades and immutable runner
  // snapshots. The caller's runtime root is not the daemon's process identity.
  // Scope, lifecycle lock and OS birth checks below remain mandatory.
  const ownerRuntimeRoot = recordedState.startedWithRuntimeEntrypoint
    ? projectPathFromModuleUrl(pathToFileURL(recordedState.startedWithRuntimeEntrypoint).href)
    : projectPath();
  const matchesRecordedScope = !!proc
    && daemonProcessMatchesCurrentScope(proc, { requireRecordedScopeFacts: true });
  // Windows' supported CIM inventory provides an exact PID, command and
  // creation time but cannot read a process environment. State + structured
  // lifecycle lock + the exact process birth below establish the current
  // lifecycle owner there; the long-lived recorded-runtime command excludes
  // arbitrary Happy processes and transient wrappers without inventing a
  // parallel process registry.
  const matchesWindowsExactRuntime = !!proc
    && process.platform === 'win32'
    // A present record remains authoritative: Windows may compensate only for
    // its inventory's documented inability to read any process environment,
    // never for a recorded mismatch or missing required scope fact.
    && !proc.daemonOwnershipEnvironmentVariables
    && isDaemonProcessForCurrentRuntimeRoot(proc, ownerRuntimeRoot);
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
  const lockFingerprint = lockIdentity.processInstanceFingerprint;
  const currentFingerprint = lockFingerprint
    ? readProcessInstanceFingerprintSync(pid, { expectedFingerprint: lockFingerprint })
    : null;
  if (
    processIdentity.pid !== pid
    || typeof processStartedAtMs !== 'number'
    || !Number.isSafeInteger(processStartedAtMs)
    || processStartedAtMs < 0
    || !isDaemonCommandForCurrentRuntimeRoot(processIdentity.command, ownerRuntimeRoot)
    || !processGenerationMatches(lockIdentity.processStartedAtMs, processStartedAtMs)
    || (lockFingerprint !== undefined && currentFingerprint !== lockFingerprint)
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
      || settledLockIdentity.processInstanceFingerprint !== lockIdentity.processInstanceFingerprint
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
    || !isDaemonCommandForCurrentRuntimeRoot(recheckedProcessIdentity.command, ownerRuntimeRoot)
  ) {
    throw new DaemonStopIncompleteError({ reason: 'process_identity_unverified', pid });
  }
  return recordedState;
}

async function forceKillKnownDaemonPid(
  pid: number,
  expectedState?: Awaited<ReturnType<typeof readDaemonState>>,
  observation?: PublishedDaemonOwnerObservation,
): Promise<DaemonStopResult> {
  if (observation && !isPidPresent(pid)) {
    if (await observation.isPresent()) throw new DaemonStopIncompleteError({ reason: 'process_identity_unverified', pid });
    await observation.reclaimIfDead();
    return { status: 'stopped', method: 'graceful' };
  }
  // A recorded lifecycle owner that is PROVABLY gone is a completed stop, not an identity
  // mismatch: there is no process left to signal and nothing left to protect. The identity gate
  // below reads a process inventory, and an inventory that finds nothing cannot tell "the pid
  // exited" apart from "the pid is not ours" or "the inventory failed" — so it refused all three
  // and left `happier daemon restart` reporting a failed stop for a daemon it had already
  // stopped. Only proven absence short-circuits here: `isPidProvablyAbsent` requires ESRCH, so
  // access-denied and unreadable-inventory verdicts stay inconclusive and still refuse below.
  // Departed-publication cleanup is exact-owner guarded, so a replacement state or lock survives.
  if (isPidProvablyAbsent(pid)) {
    logger.debug(`[CONTROL CLIENT] Daemon PID ${pid} has already exited; recording the stop as complete`);
    return await confirmedForceStop(pid, observation);
  }

  const forceState = await assertForceStopIdentity(pid, expectedState);

  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (isProcessNotFound(error)) {
      return await confirmedForceStop(pid, observation);
    }
    logger.debug('[CONTROL CLIENT] SIGTERM could not stop daemon', error);
    throw new DaemonStopIncompleteError({ reason: 'force_kill_unconfirmed', pid });
  }

  try {
    await waitForProcessDeath(pid, 2000);
    return await confirmedForceStop(pid, observation);
  } catch (error) {
    logger.debug('[CONTROL CLIENT] Daemon remained live after SIGTERM; escalating to SIGKILL', error);
  }

  // SIGTERM may still be draining when the death wait expires; a daemon that exits in that gap is
  // stopped, and re-asserting identity against a vanished process would report the same false
  // refusal this function opens by rejecting.
  if (isPidProvablyAbsent(pid)) {
    logger.debug(`[CONTROL CLIENT] Daemon PID ${pid} exited after SIGTERM; recording the stop as complete`);
    return await confirmedForceStop(pid, observation);
  }

  await assertForceStopIdentity(pid, forceState);

  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (isProcessNotFound(error)) {
      return await confirmedForceStop(pid, observation);
    }
    logger.debug('[CONTROL CLIENT] SIGKILL could not stop daemon', error);
    throw new DaemonStopIncompleteError({ reason: 'force_kill_unconfirmed', pid });
  }

  try {
    await waitForProcessDeath(pid, 2000);
    return await confirmedForceStop(pid, observation);
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

    const observation = observePublishedDaemonOwner(state);
    if (!await observation.isPresent()) {
      await observation.reclaimIfDead();
      return { status: 'not_running' };
    }
    logger.debug(`Stopping daemon with PID ${state.pid}`);

    // Try HTTP graceful stop
    try {
      await stopDaemonHttp({
        stopSessions: params.stopSessions === true,
      });

      observation.acknowledgeStop();
      // Wait for daemon to die
      await waitForProcessDeath(state.pid, resolveDaemonStopWaitForDeathTimeoutMs(), observation);
      await observation.reclaimIfDead();
      logger.debug('Daemon stopped gracefully via HTTP');
      return { status: 'stopped', method: 'graceful' };
    } catch (error) {
      logger.debug('HTTP stop failed, will force kill', error);
    }

    return await forceKillKnownDaemonPid(state.pid, state, observation);
  } catch (error) {
    if (isDaemonStopIncompleteError(error)) throw error;
    logger.debug('Error stopping daemon', error);
    throw new DaemonStopIncompleteError({ reason: 'control_client_failure' });
  }
}

export async function inspectPublishedDaemonPresence(
  state: Readonly<{ pid: number; httpPort: number; controlToken?: string }>,
): Promise<DaemonPublicationPresenceInspection> {
  return await inspectDaemonPublicationPresence({ ...state, timeoutMs: resolveDaemonPingTimeoutMs() });
}

export type PublishedDaemonOwnerObservation = Readonly<{
  isPresent: () => Promise<boolean>;
  hasHiddenPid: () => boolean;
  acknowledgeStop: () => void;
  reclaimIfDead: () => Promise<void>;
}>;

/** Stop captures exact publication ownership before requesting shutdown. */
export function observePublishedDaemonOwner(
  state: Readonly<{ pid: number; httpPort: number; startedAt?: number; controlToken?: string }>,
  lockFile = configuration.daemonLockFile,
  options: Readonly<{ unobservablePidIsUnverified?: boolean }> = {},
): PublishedDaemonOwnerObservation {
  let observedLock: ReturnType<typeof readDaemonLockSnapshot> = null;
  let observedLockRaw: string | null | undefined;
  let hiddenPid = false;
  let unobservablePid = false;
  try {
    const snapshot = readDaemonLockSnapshot(lockFile, true);
    observedLockRaw = snapshot?.raw ?? null;
    if (snapshot?.pid === state.pid) observedLock = snapshot;
  } catch {
    // No readable matching lifecycle lock means hidden-process exit cannot be confirmed.
  }
  return {
    hasHiddenPid: () => hiddenPid,
    acknowledgeStop: () => { if (unobservablePid) hiddenPid = true; },
    async reclaimIfDead() {
      if (hiddenPid || observedLockRaw === undefined || options.unobservablePidIsUnverified) return;
      await reclaimDeadDaemonPublication({
        stateFile: lockFile.slice(0, -'.lock'.length),
        expectedState: state,
        expectedLockRaw: observedLockRaw,
      });
    },
    async isPresent() {
      const inspection = await inspectPublishedDaemonPresence(state);
      if (inspection.status === 'running') {
        if (inspection.hiddenPid) hiddenPid = true;
        return true;
      }
      if (inspection.status === 'unverified') {
        unobservablePid = true;
        return true;
      }
      // Ordinary dead publications remain absent. Stricter cleanup proof applies
      // only after authenticated control established the hidden owner in this operation.
      if (!hiddenPid) return options.unobservablePidIsUnverified === true;
      if (!observedLock) return true;
      // Control closes before final cleanup. Only release of the observed owner lock
      // proves that the existing shutdown sequence reached its final exit phase.
      try {
        const snapshot = readDaemonLockSnapshot(lockFile, true);
        return snapshot !== null && (snapshot.pid === null || snapshot.raw === observedLock.raw);
      } catch {
        return true;
      }
    },
  };
}

async function waitForProcessDeath(pid: number, timeout: number, observation?: PublishedDaemonOwnerObservation): Promise<void> {
  if (observation) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (!await observation.isPresent()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!await observation.isPresent()) return;
    throw new Error('Daemon lifecycle did not finish within timeout');
  }
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
