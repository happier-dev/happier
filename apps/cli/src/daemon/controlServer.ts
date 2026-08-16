/**
 * HTTP control server for daemon management
 * Provides endpoints for listing sessions, stopping sessions, and daemon shutdown
 */

import fastify, { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { createHash, timingSafeEqual } from 'node:crypto';
import { logger } from '@/ui/logger';
import { Metadata } from '@/api/types';
import { resolveCatalogAgentIdForCliSubcommand } from '@/backends/catalog';
import {
  CODEX_CHATGPT_AUTH_TOKENS_REFRESH_PATH,
  CodexChatGptAuthTokensRefreshResponseSchema,
  CodexChatGptAuthTokensRefreshSelectionSchema,
  type CodexChatGptAuthTokensRefreshResponse,
  type CodexChatGptAuthTokensRefreshSelection,
} from '@/backends/codex/connectedServices/codexChatGptAuthTokensRefreshBridgeContract';
import {
  CLAUDE_SUBSCRIPTION_AUTH_TOKENS_REFRESH_PATH,
  ClaudeSubscriptionAuthTokensRefreshResponseSchema,
  ClaudeSubscriptionAuthTokensRefreshSelectionSchema,
  type ClaudeSubscriptionAuthTokensRefreshResponse,
  type ClaudeSubscriptionAuthTokensRefreshSelection,
} from '@/backends/claude/connectedServices/claudeSubscriptionAuthTokensRefreshBridgeContract';
import {
  OPEN_CODE_BROKER_LOADED_HANDSHAKE_PATH,
  OpenCodeBrokerLoadHandshakeRequestSchema,
  OpenCodeBrokerLoadHandshakeStatusRequestSchema,
  persistOpenCodeBrokerLoadHandshakeObservation as persistOpenCodeBrokerLoadHandshakeObservationDefault,
  recordOpenCodeBrokerLoadHandshake,
  resolveOpenCodeBrokerLoadHandshakeStatus as resolveOpenCodeBrokerLoadHandshakeStatusDefault,
} from '@/backends/opencode/brokerPlugin';
import {
  isValidConnectedServiceBrokerRefreshToken,
  isValidConnectedServiceRunMaterializeToken,
} from '@/daemon/connectedServices/broker/brokerRefreshCapabilityToken';
import {
  EXECUTION_RUN_CONNECTED_SERVICE_MATERIALIZE_PATH,
  EXECUTION_RUN_CONNECTED_SERVICE_RELEASE_PATH,
  ExecutionRunConnectedServiceMaterializeRequestSchema,
  ExecutionRunConnectedServiceMaterializeResponseSchema,
  ExecutionRunConnectedServiceReleaseRequestSchema,
  ExecutionRunConnectedServiceReleaseResponseSchema,
  type ExecutionRunConnectedServiceMaterializeResponseWire,
} from './connectedServices/runsBridge/contract';
import { resolveBrokerBridgeEffectiveSelection } from './connectedServices/broker/brokerBridgeEffectiveSelectionRegistry';
import {
  CONNECTED_SERVICE_BRIDGE_SELECTION_NOT_AUTHORIZED,
  ConnectedServiceCredentialRefreshError,
  isConnectedServiceBridgeSelectionAuthorizationError,
} from './connectedServices/refresh/ConnectedServiceRefreshCoordinator';
import {
  ConnectedServiceBridgeRefreshFailureResponseSchema,
  buildConnectedServiceBridgeRefreshFailureResponse,
} from './connectedServices/refresh/bridgeRefreshFailureContract';
import { TrackedSession } from './types';
import {
  StopSessionResultSchema,
  type StopSessionResult,
} from './sessions/stopSessionContract';
import {
  SPAWN_SESSION_ERROR_CODES,
  type SpawnSessionErrorDetail,
  SpawnSessionOptions,
  SpawnSessionResult,
} from '@/rpc/handlers/registerSessionHandlers';
import {
  mergeSpawnSessionOptions,
  normalizeSpawnSessionDirectory,
  SpawnDaemonSessionRequestSchema,
} from '@/rpc/handlers/spawnSessionOptionsContract';
import { continueSessionWithReplay } from '@/session/replay/continueWithReplay';
import { readAuthenticationStatus } from '@/api/client/httpStatusError';
import {
  ConnectedServiceIdSchema,
  ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema,
  ConnectedServiceQuotaSnapshotV1Schema,
  RestartAllSessionRunnersRequestV1Schema,
  RestartAllSessionRunnersResultV1Schema,
  RestartSessionRunnerRequestV1Schema,
  RestartSessionRunnerResultV1Schema,
  SessionConnectedServiceAuthSwitchRpcParamsSchema,
  SessionRunnerRuntimeStateV1Schema,
  SessionRunnerStatusGetRequestV1Schema,
  type ConnectedServiceId,
  type ConnectedServiceQuotaSnapshotV1,
  type RestartAllSessionRunnersRequestV1,
  type RestartAllSessionRunnersResultV1,
  type RestartSessionRunnerRequestV1,
  type RestartSessionRunnerResultV1,
  type SessionConnectedServiceAuthSwitchRpcParams,
  type SessionRunnerRuntimeStateV1,
  type SessionRunnerStatusGetRequestV1,
  type SpawnSessionNonceResolution,
} from '@happier-dev/protocol';
import {
  ConnectedServiceRuntimeAuthFailureKindSchema,
  type ConnectedServiceRuntimeFailureClassification,
} from './connectedServices/runtimeAuth/types';
import { isTemporaryRetryOwnedConnectedServiceRuntimeFailure } from './connectedServices/runtimeAuth/ConnectedServiceRecoveryPolicy';
import { resolveRuntimeAuthRecoveryDurableWaitPlan } from './connectedServices/runtimeAuth/RuntimeAuthRecoveryScheduler';
import {
  isProvenRuntimeAuthRecoverySuccess,
  resolveRuntimeAuthRecoveryProof,
  type RuntimeAuthRecoveryProofKind,
} from './connectedServices/runtimeAuth/resolveRuntimeAuthRecoveryOutcome';
import { buildConnectedServiceRuntimeAuthSwitchAttemptLogContext } from './connectedServices/runtimeAuth/buildConnectedServiceRuntimeAuthSwitchAttemptLogContext';
import { registerDaemonControlRequestTiming } from './diagnostics/registerDaemonControlRequestTiming';
import {
  ConnectedServiceTurnLifecycleRequestBodySchema,
  ConnectedServiceTurnLifecycleResultSchema,
  type ConnectedServiceTurnLifecycleRequestBody,
  type ConnectedServiceTurnLifecycleResult,
} from './connectedServices/connectedServiceTurnLifecycleContract';
import {
  applyAuthorizedRuntimeAuthFailureSourceBinding,
  type RuntimeAuthFailureSourceAuthorization,
} from './connectedServices/runtimeAuth/handleConnectedServiceRuntimeAuthFailureForSession';
import { sanitizeConnectedServiceDiagnosticString } from './connectedServices/diagnostics/sanitizeConnectedServiceDiagnosticString';
import {
  buildRuntimeAuthRecoveryScheduledResult,
  buildRuntimeAuthRecoveryTerminalResult,
} from './connectedServices/runtimeAuth/projection/connectedServiceRuntimeAuthRecoveryProjection';
import { buildRuntimeAuthRecoveryKey } from './connectedServices/runtimeAuth/recoveryKey/runtimeAuthRecoveryKey';
import { buildRuntimeAuthRecoveryAttemptTransitionLocalId } from './connectedServices/runtimeAuth/commitConnectedServiceRuntimeAuthRecoverySessionEvent';

const DEFAULT_DAEMON_CONTROL_BODY_LIMIT_BYTES = 8 * 1024 * 1024;
const DAEMON_CONTROL_BODY_LIMIT_BYTES_ENV_KEY = 'HAPPIER_DAEMON_CONTROL_BODY_LIMIT_BYTES';
const DAEMON_DIST_CLOSURE_FINGERPRINT_PATTERN = /^[a-f0-9]{16}$/;
const DaemonDistClosureFingerprintSchema = z.string().regex(DAEMON_DIST_CLOSURE_FINGERPRINT_PATTERN);

type DaemonSelfRestartRequest = Readonly<{
  successorDistClosureFingerprint?: string;
}>;
const DAEMON_CONTROL_ERROR_MESSAGE_MAX_LENGTH = 500;

const brokerBridgeAuthzDeniedSchema = z.object({
  ok: z.literal(false),
  errorCode: z.literal(CONNECTED_SERVICE_BRIDGE_SELECTION_NOT_AUTHORIZED),
});

function readSafeDaemonControlErrorDiagnostic(error: unknown): Readonly<{
  name: string;
  message: string;
}> {
  if (error instanceof Error) {
    return {
      name: error.name || 'Error',
      message: sanitizeConnectedServiceDiagnosticString(error.message, { maxLength: DAEMON_CONTROL_ERROR_MESSAGE_MAX_LENGTH }),
    };
  }
  return {
    name: typeof error,
    message: sanitizeConnectedServiceDiagnosticString(String(error), { maxLength: DAEMON_CONTROL_ERROR_MESSAGE_MAX_LENGTH }),
  };
}

function isConnectedServiceQuotaSnapshotIntakeAccepted(result: unknown): boolean {
  if (!isRecord(result)) return false;
  return result.status === 'recorded' && result.quotaStateRecorded === true;
}

type RuntimeAuthRecoverySchedulerForControlServer = Readonly<{
  beginClassifiedFailure?: (input: Readonly<{
    reportId?: string;
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    resumePromptMode?: 'standard' | 'off' | 'custom';
  }>) => Promise<unknown>;
  enqueueHandlerFailure?: (input: Readonly<{
    reportId?: string;
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    error: unknown;
    expectedAttemptId?: string;
  }>) => Promise<unknown>;
  enqueueApplyFailure?: (input: Readonly<{
    reportId?: string;
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    result: unknown;
    expectedAttemptId?: string;
  }>) => Promise<unknown>;
  cancel?: (input: Readonly<{ sessionId: string }>) => Promise<unknown>;
  cancelByKey?: (recoveryKey: string) => Promise<unknown>;
  markTerminalByKey?: (input: Readonly<{ recoveryKey: string; terminalReason: string; expectedAttemptId?: string }>) => Promise<unknown>;
  markDurableWaitForResultByKey?: (input: Readonly<{
    recoveryKey: string;
    result: unknown;
    classificationResetsAtMs: number | null;
    expectedAttemptId: string;
  }>) => Promise<unknown>;
  markAwaitingProviderOutcomeProofForResultByKey?: (input: Readonly<{
    recoveryKey: string;
    result: unknown;
    expectedAttemptId: string;
  }>) => Promise<unknown>;
  markProviderOutcomeProofByKey?: (input: Readonly<{
    recoveryKey: string;
    proofKind: RuntimeAuthRecoveryProofKind;
    expectedAttemptId?: string;
  }>) => Promise<unknown>;
  markSucceededByKey?: (recoveryKey: string) => Promise<unknown>;
}>;

function buildRuntimeAuthRecoveryReceipt(input: Readonly<{
  reportId?: string;
  recovery: unknown;
}>): Readonly<{
  reportId: string;
  attemptId: string;
  transition: string;
  eventLocalId: string;
}> | null {
  if (!isRecord(input.recovery)) return null;
  const reportId = typeof input.reportId === 'string' ? input.reportId.trim() : '';
  const attemptId = readRuntimeAuthRecoveryAttemptId(input.recovery) ?? '';
  const transition = typeof input.recovery.transition === 'string'
    ? input.recovery.transition.trim()
    : typeof input.recovery.lastSettledTransition === 'string'
      ? input.recovery.lastSettledTransition.trim()
      : '';
  if (!reportId || !attemptId || !transition) return null;
  return {
    reportId,
    attemptId,
    transition,
    eventLocalId: buildRuntimeAuthRecoveryAttemptTransitionLocalId({ attemptId, transition }),
  };
}

function readRuntimeAuthRecoveryAttemptId(recovery: unknown): string | null {
  if (!isRecord(recovery) || typeof recovery.attemptId !== 'string') return null;
  const attemptId = recovery.attemptId.trim();
  return attemptId.length > 0 ? attemptId : null;
}

function readRuntimeAuthRecoveryResumePromptMode(
  recovery: unknown,
): 'standard' | 'off' | 'custom' {
  if (!isRecord(recovery)) return 'standard';
  return recovery.resumePromptMode === 'off' || recovery.resumePromptMode === 'custom'
    ? recovery.resumePromptMode
    : 'standard';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null;
}

function readRuntimeAuthSwitchResult(result: unknown): Readonly<Record<string, unknown>> | null {
  if (!isRecord(result)) return null;
  if (result.status === 'switch_attempted' && isRecord(result.result)) return result.result;
  return result;
}

// Only deterministic recovered provider-outcome proof clears the recovery intent
// here. A bare switch /
// observed_generation / credential_refreshed / generic ok:true is a local phase,
// not proof the provider can authenticate; clearing on those produced the live
// "recovery cleared while session still broken" loop. See
// resolveRuntimeAuthRecoveryOutcome.
function resolveRuntimeAuthSwitchSuccessProof(result: unknown): RuntimeAuthRecoveryProofKind | null {
  if (!isProvenRuntimeAuthRecoverySuccess(result)) return null;
  return resolveRuntimeAuthRecoveryProof(result);
}

function isScheduledRuntimeAuthRecovery(result: unknown): boolean {
  return isRecord(result) && result.status === 'scheduled' && result.retryable === true;
}

function isTerminalRuntimeAuthRecovery(result: unknown): boolean {
  return isRecord(result) && (
    result.status === 'exhausted'
    || result.status === 'cancelled'
    || result.status === 'terminal'
    || result.status === 'terminal_non_retry'
  );
}

function isRuntimeAuthApplyFailureResult(result: unknown): boolean {
  return readRuntimeAuthSwitchResult(result)?.status === 'generation_apply_failed';
}

// Mirror of the scheduler-retry terminal classification for the in-band report
// path. `switch_limit_reached`, group-exhausted `no_eligible_member`, and non-group
// waitable `recovery_action_required` results with a computable reset are NOT here:
// those are durable waits (resolveRuntimeAuthRecoveryDurableWaitPlan, F0 / INC-2 /
// FIX-4) and the durable-wait gate runs BEFORE this terminal classification, so this
// only sees recovery_action_required results without a computable wait-until.
// Terminalizing waits cancelled the just-intaken intent, whose terminal record then
// blocked re-arming the same key until the 7-day prune (RD-REC-13).
function readRuntimeAuthTerminalReason(result: unknown): string | null {
  if (!isRecord(result)) return null;
  if (result.status === 'recovery_action_required') return 'recovery_action_required';
  const switchResult = readRuntimeAuthSwitchResult(result);
  if (!switchResult || typeof switchResult.status !== 'string') return null;
  if (switchResult.status === 'recovery_action_required') return switchResult.status;
  // A non-group-exhausted `no_eligible_member` has no wait signal and no member to
  // wait for — terminal, exactly as the scheduler-retry path classifies it.
  if (switchResult.status === 'no_eligible_member' && switchResult.groupExhausted !== true) {
    return switchResult.status;
  }
  return null;
}

async function beginRuntimeAuthRecoveryIntake(input: Readonly<{
  runtimeAuthRecoveryScheduler?: RuntimeAuthRecoverySchedulerForControlServer;
  reportId?: string;
  sessionId: string;
  switchesThisTurn: number;
  classification: ConnectedServiceRuntimeFailureClassification;
  resumePromptMode: 'standard' | 'off' | 'custom';
}>): Promise<Readonly<{ ok: true; created: boolean; recovery?: unknown }> | Readonly<{ ok: false; error: unknown }>> {
  if (!input.runtimeAuthRecoveryScheduler?.beginClassifiedFailure) return { ok: true, created: false };
  try {
    const recovery = await input.runtimeAuthRecoveryScheduler.beginClassifiedFailure({
      reportId: input.reportId,
      sessionId: input.sessionId,
      switchesThisTurn: input.switchesThisTurn,
      classification: input.classification,
      resumePromptMode: input.resumePromptMode,
    });
    return { ok: true, created: true, recovery };
  } catch (error) {
    return { ok: false, error };
  }
}

function isCanonicalSessionId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const normalized = value.trim();
  if (!normalized) return false;
  return !/^PID-\d+$/.test(normalized);
}

function safeTokenEquals(provided: string, expected: string): boolean {
  const hashA = createHash('sha256').update(provided).digest();
  const hashB = createHash('sha256').update(expected).digest();
  return timingSafeEqual(hashA, hashB);
}

function resolveDaemonControlBodyLimitBytes(): number {
  const raw = String(process.env[DAEMON_CONTROL_BODY_LIMIT_BYTES_ENV_KEY] ?? '').trim();
  if (!raw) return DEFAULT_DAEMON_CONTROL_BODY_LIMIT_BYTES;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_DAEMON_CONTROL_BODY_LIMIT_BYTES;
  }

  return Math.max(1024 * 1024, Math.min(parsed, 64 * 1024 * 1024));
}

export function createDaemonControlApp({
  getChildren,
  machineId,
  runtimeId = '',
  stopSession,
  prepareStopSession,
  spawnSession,
  resolveSpawnSessionByNonce,
  requestShutdown,
  beforeShutdown,
  onHappySessionWebhook,
  controlToken,
  handleConnectedServiceRuntimeAuthFailure,
  authorizeConnectedServiceRuntimeAuthFailure,
  resolveConnectedServiceRuntimeAuthResumePromptMode,
  handleConnectedServiceTurnLifecycle,
  handleConnectedServiceUsageLimitWaitResumeCancel,
  handleSessionConnectedServiceAuthSwitch,
  handleSessionRunnerRestart,
  handleSessionRunnerRestartAll,
  handleSessionRunnerStatusGet,
  handleConnectedServiceQuotaSnapshot,
  handleConnectedServiceQuotaRecoveryCreditConsume,
  handleCodexChatGptAuthTokensRefresh,
  handleClaudeSubscriptionAuthTokensRefresh,
  handleExecutionRunConnectedServiceMaterialize,
  handleExecutionRunConnectedServiceRelease,
  persistOpenCodeBrokerLoadHandshakeObservation = persistOpenCodeBrokerLoadHandshakeObservationDefault,
  resolveOpenCodeBrokerLoadHandshakeStatus = resolveOpenCodeBrokerLoadHandshakeStatusDefault,
  runtimeAuthRecoveryScheduler,
  isShuttingDown,
  requestSelfRestart,
}: {
  getChildren: () => TrackedSession[];
  machineId: string;
  runtimeId?: string;
  stopSession: (sessionId: string) => Promise<StopSessionResult>;
  prepareStopSession?: (child: TrackedSession) => Promise<void> | void;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  resolveSpawnSessionByNonce?: (spawnNonce: string) => Promise<SpawnSessionNonceResolution> | SpawnSessionNonceResolution;
  requestShutdown: () => void;
  beforeShutdown?: () => Promise<void>;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata) => Promise<void> | void;
  controlToken: string;
  // Run-materialization bridge: given a run-scoped selection, the daemon (sole CS owner) resolves +
  // materializes + registers the run PID and returns the env map (paths only, no secrets).
  handleExecutionRunConnectedServiceMaterialize?: (input: Readonly<{
    runId: string;
    agentId: string;
    pid: number;
    materializationKey: string;
    connectedServicesBindingsRaw: unknown;
    sessionDirectory?: string | null;
    sessionId?: string;
  }>) => Promise<ExecutionRunConnectedServiceMaterializeResponseWire>;
  // Run-end lifecycle: unregister the run's runtime target + clean its run-scoped materialized root.
  handleExecutionRunConnectedServiceRelease?: (input: Readonly<{
    runId: string;
    pid: number;
    materializationKey: string;
  }>) => Promise<Readonly<{ released: boolean }>>;
  persistOpenCodeBrokerLoadHandshakeObservation?: typeof persistOpenCodeBrokerLoadHandshakeObservationDefault;
  resolveOpenCodeBrokerLoadHandshakeStatus?: typeof resolveOpenCodeBrokerLoadHandshakeStatusDefault;
  handleConnectedServiceRuntimeAuthFailure?: (input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    interruptedOriginId?: string;
    resumePromptMode?: 'standard' | 'off' | 'custom';
    sourceAuthorization?: RuntimeAuthFailureSourceAuthorization;
  }>) => Promise<unknown>;
  authorizeConnectedServiceRuntimeAuthFailure?: (input: Readonly<{
    sessionId: string;
    classification: ConnectedServiceRuntimeFailureClassification;
  }>) => Promise<RuntimeAuthFailureSourceAuthorization>;
  resolveConnectedServiceRuntimeAuthResumePromptMode?: (input: Readonly<{
    classification: ConnectedServiceRuntimeFailureClassification;
    explicit?: 'standard' | 'off' | 'custom';
  }>) => Promise<'standard' | 'off' | 'custom'>;
  runtimeAuthRecoveryScheduler?: RuntimeAuthRecoverySchedulerForControlServer;
  // Daemon-lifecycle guard. When the daemon is shutting down (or the control server is
  // stopping), runtime-auth recovery handlers MUST NOT run switch/restart/continuation:
  // post-shutdown work can never reach provider-outcome proof and races a dying endpoint.
  isShuttingDown?: () => boolean;
  handleConnectedServiceTurnLifecycle?: (
    input: ConnectedServiceTurnLifecycleRequestBody,
  ) => Promise<ConnectedServiceTurnLifecycleResult>;
  // QAE-1: user "Stop waiting" propagation — cancels the daemon-side durable
  // recovery wait state (runtime-auth recovery + inactive usage-limit stores).
  handleConnectedServiceUsageLimitWaitResumeCancel?: (input: Readonly<{
    sessionId: string;
    attemptId: string;
  }>) => Promise<unknown>;
  handleSessionConnectedServiceAuthSwitch?: (input: Readonly<SessionConnectedServiceAuthSwitchRpcParams>) => Promise<unknown>;
  handleSessionRunnerRestart?: (input: RestartSessionRunnerRequestV1) => Promise<RestartSessionRunnerResultV1>;
  handleSessionRunnerRestartAll?: (
    input: RestartAllSessionRunnersRequestV1,
  ) => Promise<RestartAllSessionRunnersResultV1>;
  handleSessionRunnerStatusGet?: (input: SessionRunnerStatusGetRequestV1) => Promise<SessionRunnerRuntimeStateV1>;
  handleConnectedServiceQuotaSnapshot?: (input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    groupId?: string | null;
    groupGeneration?: number | null;
    sourceProviderAccountId?: string | null;
    credentialFingerprint?: string | null;
    policyDisposition?: 'evidence_only';
    snapshot: ConnectedServiceQuotaSnapshotV1;
  }>) => Promise<unknown>;
  handleConnectedServiceQuotaRecoveryCreditConsume?: (input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    idempotencyKey: string;
    providerCreditId?: string;
  }>) => Promise<unknown>;
  handleCodexChatGptAuthTokensRefresh?: (input: Readonly<{
    sessionId: string;
    brokerSelectionIdentity?: string | null;
    selection: CodexChatGptAuthTokensRefreshSelection;
    chatgptPlanType: string | null;
    forceRefresh: boolean;
    failingAccessTokenFingerprint?: string | null;
  }>) => Promise<CodexChatGptAuthTokensRefreshResponse>;
  handleClaudeSubscriptionAuthTokensRefresh?: (input: Readonly<{
    sessionId: string;
    brokerSelectionIdentity?: string | null;
    selection: ClaudeSubscriptionAuthTokensRefreshSelection;
    forceRefresh: boolean;
    failingAccessTokenFingerprint?: string | null;
  }>) => Promise<ClaudeSubscriptionAuthTokensRefreshResponse>;
  requestSelfRestart?: (request?: DaemonSelfRestartRequest) => Promise<unknown>;
}): FastifyInstance {
  void machineId;
  const normalizedRuntimeId = runtimeId.trim();
  const normalizedControlToken = controlToken.trim();
  if (!normalizedControlToken) {
    throw new Error('Daemon control token is required');
  }

  const app = fastify({
    logger: false, // We use our own logger
    bodyLimit: resolveDaemonControlBodyLimitBytes(),
  });
  registerDaemonControlRequestTiming(app, {
    debug: (message, data) => logger.debug(message, data),
  });

  // Set up Zod type provider
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const authSchema401 = z.object({
    success: z.literal(false),
    error: z.string(),
  });

  const runtimeAuthReportClaims = new Map<string, Readonly<{
    claimedAtMs: number;
    result: Promise<unknown>;
    settled: boolean;
  }>>();
  const runtimeAuthReportClaimTtlMs = 24 * 60 * 60_000;
  const runtimeAuthReportClaimMaxSettledEntries = 256;
  const pruneSettledRuntimeAuthReportClaims = (): void => {
    let settledEntries = 0;
    for (const claim of runtimeAuthReportClaims.values()) {
      if (claim.settled) settledEntries += 1;
    }
    for (const [key, claim] of runtimeAuthReportClaims) {
      if (settledEntries <= runtimeAuthReportClaimMaxSettledEntries) break;
      if (!claim.settled) continue;
      runtimeAuthReportClaims.delete(key);
      settledEntries -= 1;
    }
  };
  const claimRuntimeAuthReport = async <T>(input: Readonly<{
    reportId?: string;
    execute: () => Promise<T>;
    retainSettled?: (result: T) => boolean;
    onResult?: (result: T) => void;
  }>): Promise<T> => {
    const reportId = typeof input.reportId === 'string' ? input.reportId.trim() : '';
    if (!reportId) return await input.execute();
    const nowMs = Date.now();
    for (const [key, claim] of runtimeAuthReportClaims) {
      if (claim.settled && nowMs - claim.claimedAtMs > runtimeAuthReportClaimTtlMs) {
        runtimeAuthReportClaims.delete(key);
      }
    }
    const existing = runtimeAuthReportClaims.get(reportId);
    if (existing) {
      const joined = await existing.result as T;
      input.onResult?.(joined);
      return joined;
    }
    pruneSettledRuntimeAuthReportClaims();
    const result = input.execute();
    runtimeAuthReportClaims.set(reportId, { claimedAtMs: nowMs, result, settled: false });
    void result.then((settled) => {
      if (input.retainSettled?.(settled) === false && runtimeAuthReportClaims.get(reportId)?.result === result) {
        runtimeAuthReportClaims.delete(reportId);
      } else if (runtimeAuthReportClaims.get(reportId)?.result === result) {
        runtimeAuthReportClaims.set(reportId, { claimedAtMs: nowMs, result, settled: true });
        pruneSettledRuntimeAuthReportClaims();
      }
    }).catch(() => {
      if (runtimeAuthReportClaims.get(reportId)?.result === result) {
        runtimeAuthReportClaims.delete(reportId);
      }
    });
    const settled = await result;
    input.onResult?.(settled);
    return settled;
  };

  const requireAuth = async (request: { headers: Record<string, unknown> }, reply: any): Promise<void> => {
    const rawHeader = (request.headers as any)['x-happier-daemon-token'];
    const provided = typeof rawHeader === 'string' ? rawHeader : Array.isArray(rawHeader) ? rawHeader[0] : null;
    if (!provided || !safeTokenEquals(provided, normalizedControlToken)) {
      reply.code(401);
      return reply.send({ success: false as const, error: 'Unauthorized' });
    }
  };

  // Least-privilege gate for the broker-only endpoints (F2): they accept ONLY the SCOPED broker-refresh
  // capability token derived from the master control token, NOT the broad master token itself. The
  // broker plugin holds only this scoped token, so a leaked broker token cannot reach the broad surface.
  const requireBrokerRefreshAuth = async (request: { headers: Record<string, unknown> }, reply: any): Promise<void> => {
    const rawHeader = (request.headers as any)['x-happier-daemon-token'];
    const provided = typeof rawHeader === 'string' ? rawHeader : Array.isArray(rawHeader) ? rawHeader[0] : null;
    if (!isValidConnectedServiceBrokerRefreshToken(provided, normalizedControlToken)) {
      reply.code(401);
      return reply.send({ success: false as const, error: 'Unauthorized' });
    }
  };
  // SEC-F1: the two credential-bridge routes serve TWO principals that must never share an authz
  // path — per-session SDK callbacks (runner processes, which hold the MASTER control token) and
  // shared OpenCode/Pi brokers (which hold ONLY the scoped broker-refresh token). The credential
  // presented picks the caller mode, and the mode constrains which target key the request may
  // authorize through: master token ⇒ session mode (sessionId); scoped token ⇒ broker mode
  // (selectionIdentity REQUIRED). A scoped-token holder must never resolve a target via a
  // caller-supplied sessionId — otherwise a leaked broker token could name a live victim session
  // and receive that session's refreshed access token. Accepting the master token here grants
  // nothing new (it is a strict privilege superset of this control surface); the earlier blanket
  // master-token rejection is what forced SDK callbacks onto the shared scoped capability and
  // created the principal conflation in the first place.
  const requireBridgeRefreshAuth = async (
    request: { headers: Record<string, unknown>; bridgeCallerMode?: 'control' | 'broker_scope' },
    reply: any,
  ): Promise<void> => {
    const rawHeader = (request.headers as any)['x-happier-daemon-token'];
    const provided = typeof rawHeader === 'string' ? rawHeader : Array.isArray(rawHeader) ? rawHeader[0] : null;
    if (provided && safeTokenEquals(provided, normalizedControlToken)) {
      request.bridgeCallerMode = 'control';
      return;
    }
    if (isValidConnectedServiceBrokerRefreshToken(provided, normalizedControlToken)) {
      request.bridgeCallerMode = 'broker_scope';
      return;
    }
    reply.code(401);
    return reply.send({ success: false as const, error: 'Unauthorized' });
  };
  const readBridgeCallerMode = (request: unknown): 'control' | 'broker_scope' =>
    (request as { bridgeCallerMode?: 'control' | 'broker_scope' }).bridgeCallerMode === 'control'
      ? 'control'
      : 'broker_scope';
  // Dedicated least-privilege scope for the execution-run materialization bridge (POST-WAVE-REVIEW
  // F2): a leaked run-materialize token cannot call the broker-refresh endpoints, and vice versa.
  const requireRunMaterializeAuth = async (request: { headers: Record<string, unknown> }, reply: any): Promise<void> => {
    const rawHeader = (request.headers as any)['x-happier-daemon-token'];
    const provided = typeof rawHeader === 'string' ? rawHeader : Array.isArray(rawHeader) ? rawHeader[0] : null;
    if (!isValidConnectedServiceRunMaterializeToken(provided, normalizedControlToken)) {
      reply.code(401);
      return reply.send({ success: false as const, error: 'Unauthorized' });
    }
  };
  let restartState: 'idle' | 'restarting' = 'idle';

  typed.post('/ping', {
    schema: {
      response: {
        200: z.object({
          status: z.literal('ok'),
          runtimeId: z.string().min(1).optional(),
          distClosureFingerprint: DaemonDistClosureFingerprintSchema.optional(),
        }),
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async () => {
    const distClosureFingerprint = String(
      process.env.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT ?? '',
    ).trim();
    return {
      status: 'ok' as const,
      ...(normalizedRuntimeId ? { runtimeId: normalizedRuntimeId } : {}),
      ...(DAEMON_DIST_CLOSURE_FINGERPRINT_PATTERN.test(distClosureFingerprint) ? { distClosureFingerprint } : {}),
    };
  });

  typed.post('/connected-service-auth/session/switch', {
    schema: {
      body: SessionConnectedServiceAuthSwitchRpcParamsSchema,
      response: {
        200: z.object({
          ok: z.literal(true),
          result: z.unknown(),
        }),
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_auth_switch_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!handleSessionConnectedServiceAuthSwitch) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_auth_switch_handler_unavailable' as const,
      };
    }
    const result = await handleSessionConnectedServiceAuthSwitch(request.body);
    return { ok: true as const, result };
  });

  typed.post('/session-runners/restart', {
    schema: {
      body: RestartSessionRunnerRequestV1Schema,
      response: {
        200: RestartSessionRunnerResultV1Schema,
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('session_runner_restart_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!handleSessionRunnerRestart) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'session_runner_restart_handler_unavailable' as const,
      };
    }
    return await handleSessionRunnerRestart(request.body);
  });

  typed.post('/session-runners/restart-all', {
    schema: {
      body: RestartAllSessionRunnersRequestV1Schema,
      response: {
        200: RestartAllSessionRunnersResultV1Schema,
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('session_runner_restart_all_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!handleSessionRunnerRestartAll) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'session_runner_restart_all_handler_unavailable' as const,
      };
    }
    return await handleSessionRunnerRestartAll(request.body);
  });

  typed.post('/session-runners/status', {
    schema: {
      body: SessionRunnerStatusGetRequestV1Schema,
      response: {
        200: SessionRunnerRuntimeStateV1Schema,
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('session_runner_status_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!handleSessionRunnerStatusGet) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'session_runner_status_handler_unavailable' as const,
      };
    }
    return await handleSessionRunnerStatusGet(request.body);
  });

  // Session reports itself after creation
  typed.post('/session-started', {
    schema: {
      body: z.object({
        sessionId: z.string(),
        metadata: z.any(), // Metadata type from API
      }),
      response: {
        200: z.object({
          status: z.literal('ok'),
        }),
        401: authSchema401,
        503: z.object({
          status: z.literal('error'),
          errorCode: z.literal('session_startup_reconciliation_failed'),
        }),
      }
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { sessionId, metadata } = request.body;

    logger.debug(`[CONTROL SERVER] Session started: ${sessionId}`);
    let readiness: Promise<void>;
    try {
      readiness = Promise.resolve(onHappySessionWebhook(sessionId, metadata));
    } catch (error) {
      logger.warn('[CONTROL SERVER] Session startup webhook intake failed', {
        sessionId,
        error,
      });
      reply.code(503);
      return {
        status: 'error' as const,
        errorCode: 'session_startup_reconciliation_failed' as const,
      };
    }
    try {
      await readiness;
    } catch (error) {
      logger.warn('[CONTROL SERVER] Post-registration session startup reconciliation failed', {
        sessionId,
        error,
      });
      reply.code(503);
      return {
        status: 'error' as const,
        errorCode: 'session_startup_reconciliation_failed' as const,
      };
    }

    return { status: 'ok' as const };
  });

  typed.post('/connected-service-runtime-auth/failure', {
    schema: {
      body: z.object({
        reportId: z.string().min(1).max(256).optional(),
        originDaemonExecutionGenerationV1: z.string().min(1).max(256).optional(),
        sessionId: z.string().min(1),
        switchesThisTurn: z.number().int().nonnegative().optional(),
        resumePromptMode: z.enum(['standard', 'off', 'custom']).optional(),
        classification: z.object({
          kind: ConnectedServiceRuntimeAuthFailureKindSchema,
          serviceId: z.string().min(1),
          profileId: z.string().nullable(),
          groupId: z.string().nullable(),
          resetsAtMs: z.number().nullable(),
          planType: z.string().nullable(),
          rateLimits: z.unknown().nullable(),
          source: z.enum(['structured_provider_error', 'stable_provider_message', 'provider_runtime_marker']),
        }).passthrough(),
      }),
      response: {
        200: z.object({
          ok: z.literal(true),
          result: z.unknown(),
          resumePromptMode: z.enum(['standard', 'off', 'custom']).optional(),
          recoveryReceipt: z.object({
            reportId: z.string().min(1).max(256),
            attemptId: z.string().min(1).max(256),
            transition: z.string().min(1).max(64),
            eventLocalId: z.string().min(1).max(256),
          }).optional(),
        }),
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_runtime_auth_handler_unavailable'),
        }),
        503: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_runtime_auth_recovery_intake_failed'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    return await claimRuntimeAuthReport({
      reportId: request.body.reportId,
      retainSettled: (result) => result.ok === true,
      onResult: (result) => {
        if (result.ok === true) return;
        reply.code(result.errorCode === 'connected_service_runtime_auth_handler_unavailable' ? 501 : 503);
      },
      execute: async () => {
    if (!handleConnectedServiceRuntimeAuthFailure) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_runtime_auth_handler_unavailable' as const,
      };
    }
    const startedAtMs = Date.now();
    const sessionId = request.body.sessionId;
    const switchesThisTurn = request.body.switchesThisTurn ?? 0;
    let classification = request.body.classification as ConnectedServiceRuntimeFailureClassification;
    const resolvedResumePromptMode = await (resolveConnectedServiceRuntimeAuthResumePromptMode?.({
      classification,
      ...(request.body.resumePromptMode ? { explicit: request.body.resumePromptMode } : {}),
    }) ?? Promise.resolve(request.body.resumePromptMode ?? 'standard')).catch(() => 'standard' as const);
    let resumePromptMode = resolvedResumePromptMode;
    let recoveryReceipt: ReturnType<typeof buildRuntimeAuthRecoveryReceipt> = null;
    let recoveryAttemptId: string | null = null;
    let recoveryIntakeCreated = false;
    const ok = (result: unknown) => ({
      ok: true as const,
      result,
      ...(resolveConnectedServiceRuntimeAuthResumePromptMode ? { resumePromptMode } : {}),
      ...(recoveryReceipt ? { recoveryReceipt } : {}),
    });
    const okForRecovery = (result: unknown, recovery?: unknown) => {
      const nextReceipt = buildRuntimeAuthRecoveryReceipt({
        reportId: request.body.reportId,
        recovery,
      });
      if (nextReceipt) recoveryReceipt = nextReceipt;
      return ok(result);
    };
    // Daemon-lifecycle guard: if the daemon is shutting down, do NOT run the
    // recovery handler and do NOT create a new durable recovery intent from this
    // in-band report. Already-persisted intents remain owned by the scheduler and
    // can be re-driven by a healthy future daemon.
    if (isShuttingDown?.() === true) {
      return {
        ok: true as const,
        result: {
          status: 'daemon_lifecycle_unavailable' as const,
          reason: 'recovery_deferred_shutdown' as const,
        },
      };
    }
    const isRuntimeAuthRecoveryOwnedFailure = !isTemporaryRetryOwnedConnectedServiceRuntimeFailure(classification);
    let sourceAuthorization: Awaited<ReturnType<NonNullable<
      typeof authorizeConnectedServiceRuntimeAuthFailure
    >>> | undefined;
    try {
      sourceAuthorization = await authorizeConnectedServiceRuntimeAuthFailure?.({
        sessionId,
        classification,
      });
    } catch (error) {
      logger.warn('[CONTROL SERVER] Connected-service runtime auth source verification unavailable', {
        sessionId,
        serviceId: classification.serviceId,
        error: readSafeDaemonControlErrorDiagnostic(error),
      });
      reply.code(503);
      return {
        ok: false as const,
        errorCode: 'connected_service_runtime_auth_recovery_intake_failed' as const,
      };
    }
    if (sourceAuthorization && sourceAuthorization.status !== 'authorized') {
      const result = await handleConnectedServiceRuntimeAuthFailure({
        sessionId,
        switchesThisTurn,
        classification,
        ...(request.body.reportId ? { interruptedOriginId: request.body.reportId } : {}),
        resumePromptMode,
        sourceAuthorization,
      });
      return ok(result);
    }
    classification = applyAuthorizedRuntimeAuthFailureSourceBinding(classification, sourceAuthorization);
    if (isRuntimeAuthRecoveryOwnedFailure) {
      const intake = await beginRuntimeAuthRecoveryIntake({
        runtimeAuthRecoveryScheduler,
        reportId: request.body.reportId,
        sessionId,
        switchesThisTurn,
        classification,
        resumePromptMode,
        ...(sourceAuthorization ? { sourceAuthorization } : {}),
      });
      if (!intake.ok) {
        const diagnostic = readSafeDaemonControlErrorDiagnostic(intake.error);
        logger.warn('[CONTROL SERVER] Connected-service runtime auth recovery intake failed', {
          ...buildConnectedServiceRuntimeAuthSwitchAttemptLogContext({
            sessionId,
            classification,
            handlerFailure: {
              errorCode: 'runtime_auth_recovery_intake_failed',
              errorName: diagnostic.name,
              errorMessage: diagnostic.message,
            },
            routedThroughFsm: false,
            startedAtMs,
            finishedAtMs: Date.now(),
          }),
          kind: classification.kind,
          error: diagnostic,
        });
        reply.code(503);
        return {
          ok: false as const,
          errorCode: 'connected_service_runtime_auth_recovery_intake_failed' as const,
        };
      }
      recoveryReceipt = buildRuntimeAuthRecoveryReceipt({
        reportId: request.body.reportId,
        recovery: intake.recovery,
      });
      recoveryAttemptId = readRuntimeAuthRecoveryAttemptId(intake.recovery);
      recoveryIntakeCreated = intake.created;
      if (intake.created) {
        resumePromptMode = readRuntimeAuthRecoveryResumePromptMode(intake.recovery);
      }
    }
    const canSettleRecoveryAttempt = isRuntimeAuthRecoveryOwnedFailure
      && (!recoveryIntakeCreated || recoveryAttemptId !== null);
    try {
      const result = await handleConnectedServiceRuntimeAuthFailure({
        sessionId,
        switchesThisTurn,
        classification,
        ...(request.body.reportId ? { interruptedOriginId: request.body.reportId } : {}),
        resumePromptMode,
        ...(sourceAuthorization ? { sourceAuthorization } : {}),
      });
      if (canSettleRecoveryAttempt && isRuntimeAuthApplyFailureResult(result) && runtimeAuthRecoveryScheduler?.enqueueApplyFailure) {
        try {
          const recovery = await runtimeAuthRecoveryScheduler.enqueueApplyFailure({
            reportId: request.body.reportId,
            sessionId,
            switchesThisTurn,
            classification,
            result,
            ...(recoveryAttemptId ? { expectedAttemptId: recoveryAttemptId } : {}),
          });
          if (isScheduledRuntimeAuthRecovery(recovery)) {
            return okForRecovery(buildRuntimeAuthRecoveryScheduledResult({
                classification,
                recovery,
                originalResult: result,
              }), recovery);
          }
          if (isTerminalRuntimeAuthRecovery(recovery)) {
            return okForRecovery(buildRuntimeAuthRecoveryTerminalResult({
                classification,
                recovery,
                originalResult: result,
              }), recovery);
          }
        } catch (schedulerError) {
          logger.debug('[CONTROL SERVER] Connected-service runtime auth recovery scheduling failed after apply failure', {
            sessionId,
            error: readSafeDaemonControlErrorDiagnostic(schedulerError),
          });
        }
      }
      const recoveredProofKind = resolveRuntimeAuthSwitchSuccessProof(result);
      if (recoveredProofKind && canSettleRecoveryAttempt) {
        const recoveryKey = buildRuntimeAuthRecoveryKey({
          sessionId,
          serviceId: classification.serviceId,
          profileId: classification.profileId,
          groupId: classification.groupId,
        });
        const resolveRecoveryProof = async (): Promise<unknown> => {
          if (runtimeAuthRecoveryScheduler?.markProviderOutcomeProofByKey) {
            return await runtimeAuthRecoveryScheduler.markProviderOutcomeProofByKey({
              recoveryKey,
              proofKind: recoveredProofKind,
              ...(recoveryAttemptId ? { expectedAttemptId: recoveryAttemptId } : {}),
            });
          }
          if (!recoveryAttemptId && runtimeAuthRecoveryScheduler?.markSucceededByKey) {
            return await runtimeAuthRecoveryScheduler.markSucceededByKey(recoveryKey);
          }
          if (!recoveryAttemptId && runtimeAuthRecoveryScheduler?.cancelByKey) {
            return await runtimeAuthRecoveryScheduler.cancelByKey(recoveryKey);
          }
          return undefined;
        };
        await resolveRecoveryProof().catch((error) => {
          logger.debug('[CONTROL SERVER] Connected-service runtime auth recovery proof resolution failed after success', {
            sessionId,
            recoveryKey,
            proofKind: recoveredProofKind,
            error: readSafeDaemonControlErrorDiagnostic(error),
          });
        });
      }
      const recoveryKey = buildRuntimeAuthRecoveryKey({
        sessionId,
        serviceId: classification.serviceId,
        profileId: classification.profileId,
        groupId: classification.groupId,
      });
      if (recoveryAttemptId) {
        await runtimeAuthRecoveryScheduler?.markAwaitingProviderOutcomeProofForResultByKey?.({
          recoveryKey,
          result,
          expectedAttemptId: recoveryAttemptId,
        }).catch((error) => {
          logger.debug('[CONTROL SERVER] Connected-service runtime auth recovery proof-wait mark failed after local recovery result', {
            sessionId,
            recoveryKey,
            error: readSafeDaemonControlErrorDiagnostic(error),
          });
        });
      }
      // F0/INC-2 (in-band path): group-exhausted and switch-limited results are
      // durable waits — re-arm the just-intaken intent at the computed/floored
      // wake time instead of terminalizing it. The classification gate runs here
      // (so the terminal branch below never sees a durable-wait result even when
      // the scheduler double lacks the re-arm method); the wake TIME is resolved
      // by the scheduler on its own clock.
      const durableWait = resolveRuntimeAuthRecoveryDurableWaitPlan({
        result,
        classificationResetsAtMs: classification.resetsAtMs ?? null,
        nowMs: Date.now(),
      });
      if (durableWait) {
        if (recoveryAttemptId) {
          await runtimeAuthRecoveryScheduler?.markDurableWaitForResultByKey?.({
            recoveryKey,
            result,
            classificationResetsAtMs: classification.resetsAtMs ?? null,
            expectedAttemptId: recoveryAttemptId,
          }).catch((error) => {
            logger.debug('[CONTROL SERVER] Connected-service runtime auth recovery durable-wait re-arm failed after group-exhausted result', {
              sessionId,
              recoveryKey,
              error: readSafeDaemonControlErrorDiagnostic(error),
            });
          });
        }
        return ok(result);
      }
      const terminalReason = readRuntimeAuthTerminalReason(result);
      if (terminalReason && canSettleRecoveryAttempt) {
        try {
          const terminalRecovery = await runtimeAuthRecoveryScheduler?.markTerminalByKey?.({
            recoveryKey,
            terminalReason,
            ...(recoveryAttemptId ? { expectedAttemptId: recoveryAttemptId } : {}),
          });
          const terminalReceipt = buildRuntimeAuthRecoveryReceipt({
            reportId: request.body.reportId,
            recovery: terminalRecovery,
          });
          if (terminalReceipt) recoveryReceipt = terminalReceipt;
        } catch (error) {
          logger.debug('[CONTROL SERVER] Connected-service runtime auth recovery terminalization failed after terminal result', {
            sessionId,
            recoveryKey,
            error: readSafeDaemonControlErrorDiagnostic(error),
          });
        }
      }
      return ok(result);
    } catch (error) {
      const diagnostic = readSafeDaemonControlErrorDiagnostic(error);
      logger.warn('[CONTROL SERVER] Connected-service runtime auth failure handler failed', {
        ...buildConnectedServiceRuntimeAuthSwitchAttemptLogContext({
          sessionId,
          classification,
          handlerFailure: {
            errorCode: 'unexpected_error',
            errorName: diagnostic.name,
            errorMessage: diagnostic.message,
          },
          routedThroughFsm: false,
          startedAtMs,
          finishedAtMs: Date.now(),
        }),
        kind: classification.kind,
        error: diagnostic,
      });
      if (canSettleRecoveryAttempt && runtimeAuthRecoveryScheduler?.enqueueHandlerFailure) {
        try {
          const recovery = await runtimeAuthRecoveryScheduler.enqueueHandlerFailure({
            reportId: request.body.reportId,
            sessionId,
            switchesThisTurn,
            classification,
            error,
            ...(recoveryAttemptId ? { expectedAttemptId: recoveryAttemptId } : {}),
          });
          if (isScheduledRuntimeAuthRecovery(recovery)) {
            return okForRecovery(buildRuntimeAuthRecoveryScheduledResult({
                classification,
                recovery,
              }), recovery);
          }
          if (isTerminalRuntimeAuthRecovery(recovery)) {
            return okForRecovery(buildRuntimeAuthRecoveryTerminalResult({
                classification,
                recovery,
              }), recovery);
          }
        } catch (schedulerError) {
          logger.debug('[CONTROL SERVER] Connected-service runtime auth recovery scheduling failed after handler failure', {
            sessionId,
            error: readSafeDaemonControlErrorDiagnostic(schedulerError),
          });
        }
      }
      return ok({
          status: 'recovery_handler_failed' as const,
          errorCode: 'unexpected_error' as const,
        });
    }
      },
    });
  });

  typed.post('/connected-service-turn-lifecycle', {
    schema: {
      body: ConnectedServiceTurnLifecycleRequestBodySchema,
      response: {
        200: z.object({
          ok: z.literal(true),
          result: ConnectedServiceTurnLifecycleResultSchema,
        }),
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_turn_lifecycle_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!handleConnectedServiceTurnLifecycle) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_turn_lifecycle_handler_unavailable' as const,
      };
    }
    const result = await handleConnectedServiceTurnLifecycle({
      sessionId: request.body.sessionId,
      event: request.body.event,
      ...(request.body.terminalStatus ? { terminalStatus: request.body.terminalStatus } : {}),
      ...(request.body.turnId ? { turnId: request.body.turnId } : {}),
      ...(request.body.requestedAction ? { requestedAction: request.body.requestedAction } : {}),
      ...(request.body.activeTurnId !== undefined ? { activeTurnId: request.body.activeTurnId } : {}),
    });
    return { ok: true as const, result };
  });

  typed.post('/connected-service-usage-limit/wait-resume-cancel', {
    schema: {
      body: z.object({
        sessionId: z.string().min(1),
        attemptId: z.string().trim().min(1),
      }),
      response: {
        200: z.object({
          ok: z.literal(true),
          result: z.unknown(),
        }),
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_usage_limit_wait_resume_cancel_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (!handleConnectedServiceUsageLimitWaitResumeCancel) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_usage_limit_wait_resume_cancel_handler_unavailable' as const,
      };
    }
    const result = await handleConnectedServiceUsageLimitWaitResumeCancel({
      sessionId: request.body.sessionId,
      attemptId: request.body.attemptId,
    });
    return { ok: true as const, result };
  });

  typed.post('/connected-service-quota-snapshot', {
    schema: {
      body: z.object({
        sessionId: z.string().min(1),
        serviceId: ConnectedServiceIdSchema,
        groupId: z.string().trim().min(1).nullable().optional(),
        groupGeneration: z.number().int().nonnegative().nullable().optional(),
        sourceProviderAccountId: z.string().trim().min(1).nullable().optional(),
        credentialFingerprint: z.string().regex(/^sha256:[a-f0-9]{8}$/u).nullable().optional(),
        policyDisposition: z.literal('evidence_only').optional(),
        snapshot: ConnectedServiceQuotaSnapshotV1Schema,
      }).superRefine((body, ctx) => {
        if (body.snapshot.serviceId !== body.serviceId) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: 'snapshot serviceId must match request serviceId',
            path: ['snapshot', 'serviceId'],
          });
        }
      }),
      response: {
        200: z.object({
          ok: z.literal(true),
          result: z.unknown(),
        }),
        401: authSchema401,
        503: z.object({
          ok: z.literal(false),
          errorCode: z.enum([
            'daemon_shutting_down',
            'connected_service_quota_snapshot_intake_failed',
          ]),
        }),
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_quota_snapshot_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isShuttingDown?.() === true) {
      reply.code(503);
      return {
        ok: false as const,
        errorCode: 'daemon_shutting_down' as const,
      };
    }
    if (!handleConnectedServiceQuotaSnapshot) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_quota_snapshot_handler_unavailable' as const,
      };
    }
    const handlerInput = {
      sessionId: request.body.sessionId,
      serviceId: request.body.serviceId,
      ...(request.body.groupId !== undefined ? { groupId: request.body.groupId } : {}),
      ...(request.body.groupGeneration !== undefined ? { groupGeneration: request.body.groupGeneration } : {}),
      ...(request.body.sourceProviderAccountId !== undefined ? { sourceProviderAccountId: request.body.sourceProviderAccountId } : {}),
      ...(request.body.credentialFingerprint !== undefined ? { credentialFingerprint: request.body.credentialFingerprint } : {}),
      ...(request.body.policyDisposition ? { policyDisposition: request.body.policyDisposition } : {}),
      snapshot: request.body.snapshot,
    };
    try {
      const result = await handleConnectedServiceQuotaSnapshot(handlerInput);
      if (!isConnectedServiceQuotaSnapshotIntakeAccepted(result)) {
        throw new Error('connected_service_quota_snapshot_canonical_custody_unavailable');
      }
      return { ok: true as const, result };
    } catch (error) {
      logger.warn('[CONTROL SERVER] Connected-service quota snapshot canonical intake failed', {
        sessionId: request.body.sessionId,
        serviceId: request.body.serviceId,
        error: readSafeDaemonControlErrorDiagnostic(error),
      });
      reply.code(503);
      return {
        ok: false as const,
        errorCode: 'connected_service_quota_snapshot_intake_failed' as const,
      };
    }
  });

  typed.post('/connected-service-quota-recovery-credit/consume', {
    schema: {
      body: ConnectedServiceQuotaRecoveryCreditConsumeRequestV1Schema,
      response: {
        200: z.object({
          ok: z.literal(true),
          result: z.unknown(),
        }),
        401: authSchema401,
        503: z.object({
          ok: z.literal(false),
          errorCode: z.literal('daemon_shutting_down'),
        }),
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_quota_recovery_credit_consume_handler_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isShuttingDown?.() === true) {
      reply.code(503);
      return {
        ok: false as const,
        errorCode: 'daemon_shutting_down' as const,
      };
    }
    if (!handleConnectedServiceQuotaRecoveryCreditConsume) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_quota_recovery_credit_consume_handler_unavailable' as const,
      };
    }
    const result = await handleConnectedServiceQuotaRecoveryCreditConsume({
      serviceId: request.body.serviceId,
      profileId: request.body.profileId,
      idempotencyKey: request.body.idempotencyKey,
      ...(request.body.providerCreditId ? { providerCreditId: request.body.providerCreditId } : {}),
    });
    return { ok: true as const, result };
  });

  typed.post(CODEX_CHATGPT_AUTH_TOKENS_REFRESH_PATH, {
    schema: {
      body: z.object({
        sessionId: z.string().min(1),
        selection: CodexChatGptAuthTokensRefreshSelectionSchema,
        selectionIdentity: z.string().min(1).optional(),
        chatgptPlanType: z.string().nullable().optional(),
        // F6: the broker sets this ONLY on its 401-retry path; a cold cache-miss leaves it false so
        // the daemon returns the current (valid) token instead of rotating the single-use refresh token.
        forceRefresh: z.boolean().optional(),
        failingAccessTokenFingerprint: z.string().regex(/^sha256:[a-f0-9]{8}$/u).optional(),
      }),
      response: {
        200: z.object({
          ok: z.literal(true),
          result: CodexChatGptAuthTokensRefreshResponseSchema,
        }),
        401: authSchema401,
        403: brokerBridgeAuthzDeniedSchema,
        409: ConnectedServiceBridgeRefreshFailureResponseSchema,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_chatgpt_refresh_handler_unavailable'),
        }),
      },
    },
    preHandler: requireBridgeRefreshAuth,
  }, async (request, reply) => {
    if (!handleCodexChatGptAuthTokensRefresh) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_chatgpt_refresh_handler_unavailable' as const,
      };
    }
    // SEC-F1: broker-scope callers authorize EXCLUSIVELY through their selection identity.
    if (readBridgeCallerMode(request) === 'broker_scope' && !request.body.selectionIdentity) {
      reply.code(403);
      return {
        ok: false as const,
        errorCode: CONNECTED_SERVICE_BRIDGE_SELECTION_NOT_AUTHORIZED as typeof CONNECTED_SERVICE_BRIDGE_SELECTION_NOT_AUTHORIZED,
      };
    }
    const effectiveSelection = resolveBrokerBridgeEffectiveSelection({
      selectionIdentity: request.body.selectionIdentity ?? null,
      serviceId: 'openai-codex',
      selection: request.body.selection,
    });
    if (effectiveSelection.availability === 'unavailable') {
      reply.code(403);
      return {
        ok: false as const,
        errorCode: CONNECTED_SERVICE_BRIDGE_SELECTION_NOT_AUTHORIZED as typeof CONNECTED_SERVICE_BRIDGE_SELECTION_NOT_AUTHORIZED,
      };
    }
    const parsedSelection = CodexChatGptAuthTokensRefreshSelectionSchema.parse(effectiveSelection.selection);
    let result: CodexChatGptAuthTokensRefreshResponse;
    try {
      result = await handleCodexChatGptAuthTokensRefresh({
        sessionId: request.body.sessionId,
        brokerSelectionIdentity: request.body.selectionIdentity ?? null,
        selection: parsedSelection,
        chatgptPlanType: request.body.chatgptPlanType ?? null,
        forceRefresh: request.body.forceRefresh === true,
        failingAccessTokenFingerprint: request.body.failingAccessTokenFingerprint ?? null,
      });
    } catch (error) {
      if (isConnectedServiceBridgeSelectionAuthorizationError(error)) {
        reply.code(403);
        return {
          ok: false as const,
          errorCode: CONNECTED_SERVICE_BRIDGE_SELECTION_NOT_AUTHORIZED as typeof CONNECTED_SERVICE_BRIDGE_SELECTION_NOT_AUTHORIZED,
        };
      }
      if (error instanceof ConnectedServiceCredentialRefreshError) {
        reply.code(409);
        return buildConnectedServiceBridgeRefreshFailureResponse(error.diagnostic);
      }
      throw error;
    }
    return {
      ok: true as const,
      result: {
        ...result,
        ...(request.body.selectionIdentity ? { selectionEpoch: effectiveSelection.selectionEpoch } : {}),
      },
    };
  });

  typed.post(CLAUDE_SUBSCRIPTION_AUTH_TOKENS_REFRESH_PATH, {
    schema: {
      body: z.object({
        sessionId: z.string().min(1),
        selection: ClaudeSubscriptionAuthTokensRefreshSelectionSchema,
        selectionIdentity: z.string().min(1).optional(),
        forceRefresh: z.boolean().optional(),
        failingAccessTokenFingerprint: z.string().regex(/^sha256:[a-f0-9]{8}$/u).optional(),
      }),
      response: {
        200: z.object({
          ok: z.literal(true),
          result: ClaudeSubscriptionAuthTokensRefreshResponseSchema,
        }),
        401: authSchema401,
        403: brokerBridgeAuthzDeniedSchema,
        409: ConnectedServiceBridgeRefreshFailureResponseSchema,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_claude_subscription_refresh_handler_unavailable'),
        }),
      },
    },
    preHandler: requireBridgeRefreshAuth,
  }, async (request, reply) => {
    if (!handleClaudeSubscriptionAuthTokensRefresh) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'connected_service_claude_subscription_refresh_handler_unavailable' as const,
      };
    }
    // SEC-F1: broker-scope callers authorize EXCLUSIVELY through their selection identity.
    if (readBridgeCallerMode(request) === 'broker_scope' && !request.body.selectionIdentity) {
      reply.code(403);
      return {
        ok: false as const,
        errorCode: CONNECTED_SERVICE_BRIDGE_SELECTION_NOT_AUTHORIZED as typeof CONNECTED_SERVICE_BRIDGE_SELECTION_NOT_AUTHORIZED,
      };
    }
    const effectiveSelection = resolveBrokerBridgeEffectiveSelection({
      selectionIdentity: request.body.selectionIdentity ?? null,
      serviceId: 'claude-subscription',
      selection: request.body.selection,
    });
    if (effectiveSelection.availability === 'unavailable') {
      reply.code(403);
      return {
        ok: false as const,
        errorCode: CONNECTED_SERVICE_BRIDGE_SELECTION_NOT_AUTHORIZED as typeof CONNECTED_SERVICE_BRIDGE_SELECTION_NOT_AUTHORIZED,
      };
    }
    const parsedSelection = ClaudeSubscriptionAuthTokensRefreshSelectionSchema.parse(effectiveSelection.selection);
    let result: ClaudeSubscriptionAuthTokensRefreshResponse;
    try {
      result = await handleClaudeSubscriptionAuthTokensRefresh({
        sessionId: request.body.sessionId,
        brokerSelectionIdentity: request.body.selectionIdentity ?? null,
        selection: parsedSelection,
        forceRefresh: request.body.forceRefresh === true,
        failingAccessTokenFingerprint: request.body.failingAccessTokenFingerprint ?? null,
      });
    } catch (error) {
      if (isConnectedServiceBridgeSelectionAuthorizationError(error)) {
        reply.code(403);
        return {
          ok: false as const,
          errorCode: CONNECTED_SERVICE_BRIDGE_SELECTION_NOT_AUTHORIZED as typeof CONNECTED_SERVICE_BRIDGE_SELECTION_NOT_AUTHORIZED,
        };
      }
      if (error instanceof ConnectedServiceCredentialRefreshError) {
        reply.code(409);
        return buildConnectedServiceBridgeRefreshFailureResponse(error.diagnostic);
      }
      throw error;
    }
    return {
      ok: true as const,
      result: {
        ...result,
        ...(request.body.selectionIdentity ? { selectionEpoch: effectiveSelection.selectionEpoch } : {}),
      },
    };
  });

  // Run-materialization bridge (DEDICATED scoped run-materialize token, least privilege — mirrors the broker
  // bridge). The runner asks the daemon (sole CS owner) to resolve+materialize+register CS for an
  // execution run and returns the env map. Fails CLOSED: a materialization fault is a 500, never a
  // silent empty env that would let the run fall back to the runner's inherited account.
  typed.post(EXECUTION_RUN_CONNECTED_SERVICE_MATERIALIZE_PATH, {
    schema: {
      body: ExecutionRunConnectedServiceMaterializeRequestSchema,
      response: {
        200: z.object({
          ok: z.literal(true),
          result: ExecutionRunConnectedServiceMaterializeResponseSchema,
        }),
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('execution_run_connected_service_materialize_handler_unavailable'),
        }),
      },
    },
    preHandler: requireRunMaterializeAuth,
  }, async (request, reply) => {
    if (!handleExecutionRunConnectedServiceMaterialize) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'execution_run_connected_service_materialize_handler_unavailable' as const,
      };
    }
    const result = await handleExecutionRunConnectedServiceMaterialize({
      runId: request.body.runId,
      agentId: request.body.agentId,
      pid: request.body.pid,
      materializationKey: request.body.materializationKey,
      connectedServicesBindingsRaw: request.body.connectedServicesBindingsRaw,
      sessionDirectory: request.body.sessionDirectory ?? null,
      ...(request.body.sessionId ? { sessionId: request.body.sessionId } : {}),
    });
    return { ok: true as const, result };
  });

  // Run-end lifecycle for the run-materialization bridge: unregister the run's runtime target and
  // clean its run-scoped materialized root. Best-effort semantics on the caller side; the handler
  // itself never tears down a target owned by a different materialization.
  typed.post(EXECUTION_RUN_CONNECTED_SERVICE_RELEASE_PATH, {
    schema: {
      body: ExecutionRunConnectedServiceReleaseRequestSchema,
      response: {
        200: z.object({
          ok: z.literal(true),
          result: ExecutionRunConnectedServiceReleaseResponseSchema,
        }),
        401: authSchema401,
        501: z.object({
          ok: z.literal(false),
          errorCode: z.literal('execution_run_connected_service_release_handler_unavailable'),
        }),
      },
    },
    preHandler: requireRunMaterializeAuth,
  }, async (request, reply) => {
    if (!handleExecutionRunConnectedServiceRelease) {
      reply.code(501);
      return {
        ok: false as const,
        errorCode: 'execution_run_connected_service_release_handler_unavailable' as const,
      };
    }
    const result = await handleExecutionRunConnectedServiceRelease({
      runId: request.body.runId,
      pid: request.body.pid,
      materializationKey: request.body.materializationKey,
    });
    return { ok: true as const, result: { released: result.released } };
  });

  // F4: broker load handshake. The broker plugin pings this on activation (scoped token only) so the
  // daemon records that the plugin actually loaded; the preflight then verifies it via loaded-status.
  typed.post(OPEN_CODE_BROKER_LOADED_HANDSHAKE_PATH, {
    schema: {
      body: OpenCodeBrokerLoadHandshakeRequestSchema,
      response: {
        200: z.object({ ok: z.literal(true), result: z.object({ acknowledged: z.literal(true) }) }),
        401: authSchema401,
        503: z.object({
          ok: z.literal(false),
          errorCode: z.literal('connected_service_broker_activation_proof_unavailable'),
        }),
      },
    },
    preHandler: requireBrokerRefreshAuth,
  }, async (request, reply) => {
    recordOpenCodeBrokerLoadHandshake({
      runtimeKind: request.body.runtimeKind,
      selectionIdentity: request.body.selectionIdentity,
      loadNonce: request.body.loadNonce,
      providers: request.body.providers,
      pluginVersion: request.body.pluginVersion,
      processPid: request.body.processPid,
    });
    if (request.body.runtimeKind === 'opencode_managed_server') {
      const persisted = await persistOpenCodeBrokerLoadHandshakeObservation({
        runtimeKind: request.body.runtimeKind,
        selectionIdentity: request.body.selectionIdentity,
        loadNonce: request.body.loadNonce,
        providers: request.body.providers,
        pluginVersion: request.body.pluginVersion,
      });
      if (!persisted) {
        reply.code(503);
        return {
          ok: false as const,
          errorCode: 'connected_service_broker_activation_proof_unavailable' as const,
        };
      }
    }
    return { ok: true as const, result: { acknowledged: true as const } };
  });

  // F4: broker load-handshake status query. Used by the connected-session preflight (Happier's own
  // trusted query) over the broad control token — distinct from the broker's scoped registration above.
  typed.post('/connected-service-auth/opencode-broker/loaded-status', {
    schema: {
      body: OpenCodeBrokerLoadHandshakeStatusRequestSchema,
      response: {
        200: z.object({ ok: z.literal(true), observed: z.boolean() }),
        401: authSchema401,
      },
    },
    preHandler: requireAuth,
  }, async (request) => {
    const expectation = {
      runtimeKind: request.body.runtimeKind,
      selectionIdentity: request.body.selectionIdentity,
      loadNonce: request.body.loadNonce,
      providers: request.body.providers,
      pluginVersion: request.body.pluginVersion,
    };
    return {
      ok: true as const,
      observed: await resolveOpenCodeBrokerLoadHandshakeStatus(expectation),
    };
  });

  // List all tracked sessions
  typed.post('/list', {
    schema: {
      response: {
        200: z.object({
          children: z.array(z.object({
            startedBy: z.string(),
            happySessionId: z.string(),
            pid: z.number(),
            status: z.enum(['runner_alive', 'runner_alive_host_dead']),
            terminalHostHealth: z.object({
              status: z.literal('host_dead'),
              sessionId: z.string(),
              runnerPid: z.number(),
              hostKind: z.string(),
              zellijSessionName: z.string().optional(),
              observedAt: z.number(),
              reason: z.string(),
            }).optional(),
          }))
        }),
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async () => {
    const children = getChildren();
    logger.debug(`[CONTROL SERVER] Listing ${children.length} sessions`);
    return { 
      children: children
        .filter(child => child.happySessionId !== undefined)
        .map(child => ({
          startedBy: child.startedBy,
          happySessionId: child.happySessionId!,
          pid: child.pid,
          status: child.terminalHostHealth?.status === 'host_dead'
            ? 'runner_alive_host_dead' as const
            : 'runner_alive' as const,
          ...(child.terminalHostHealth?.status === 'host_dead'
            ? { terminalHostHealth: child.terminalHostHealth }
            : {}),
        }))
    }
  });

  // Stop specific session
  typed.post('/stop-session', {
    schema: {
      body: z.object({
        sessionId: z.string()
      }),
      response: {
        200: StopSessionResultSchema,
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async (request) => {
    const { sessionId } = request.body;

    logger.debug(`[CONTROL SERVER] Stop session request: ${sessionId}`);
    return await stopSession(sessionId);
  });

  // Spawn new session
  typed.post('/spawn-session', {
    schema: {
      body: SpawnDaemonSessionRequestSchema,
      response: {
        200: z.object({
          success: z.boolean(),
          sessionId: z.string().optional(),
          status: z.enum(['success', 'pending']).optional(),
          spawnNonce: z.string().optional(),
          sessionIdStatus: z.enum(['available', 'pending']).optional(),
          approvedNewDirectoryCreation: z.boolean().optional(),
        }),
        202: z.object({
          success: z.literal(false),
          status: z.literal('pending'),
          errorCode: z.literal(SPAWN_SESSION_ERROR_CODES.SESSION_WEBHOOK_TIMEOUT),
        }),
        401: authSchema401,
        409: z.object({
          success: z.boolean(),
          requiresUserApproval: z.boolean().optional(),
          actionRequired: z.string().optional(),
          directory: z.string().optional(),
        }),
        500: z.object({
          success: z.boolean(),
          error: z.string().optional(),
          errorCode: z.string().optional(),
          errorDetail: z.unknown().optional(),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    const { directory, sessionId, existingSessionId } = request.body;
    const spawnNonce = typeof request.body.spawnNonce === 'string' ? request.body.spawnNonce.trim() : '';
    const normalizedDirectory = normalizeSpawnSessionDirectory(directory, process.env);

    logger.debug(`[CONTROL SERVER] Spawn session request: dir=${normalizedDirectory}, sessionId=${sessionId || 'new'}`);
    let result: SpawnSessionResult;
    try {
      const normalizedExistingSessionId = typeof existingSessionId === 'string' && existingSessionId.trim().length > 0
        ? existingSessionId.trim()
        : undefined;
      result = await spawnSession(
        mergeSpawnSessionOptions(
          request.body,
          {
            directory: normalizedDirectory,
            ...(normalizedExistingSessionId ? { existingSessionId: normalizedExistingSessionId } : {}),
          },
          normalizedExistingSessionId ? { omit: ['sessionId'] } : {},
        ) as SpawnSessionOptions,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      reply.code(500);
      return {
        success: false,
        error: `Failed to spawn session: ${message}`,
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      };
    }

    switch (result.type) {
      case 'success':
        if (!result.sessionId) {
          if (result.sessionIdStatus === 'pending') {
            const resultSpawnNonce = typeof result.spawnNonce === 'string' && result.spawnNonce.trim().length > 0
              ? result.spawnNonce.trim()
              : spawnNonce || undefined;
            return {
              success: true,
              status: 'pending' as const,
              ...(resultSpawnNonce ? { spawnNonce: resultSpawnNonce } : {}),
              sessionIdStatus: 'pending' as const,
              approvedNewDirectoryCreation: true,
            };
          }
          reply.code(500);
          return {
            success: false,
            error: 'Failed to spawn session: no session ID returned',
          };
        }
        return {
          success: true,
          sessionId: result.sessionId,
          ...(result.spawnNonce ? { spawnNonce: result.spawnNonce } : {}),
          ...(result.sessionIdStatus ? { sessionIdStatus: result.sessionIdStatus } : {}),
          approvedNewDirectoryCreation: true,
        };

      case 'requestToApproveDirectoryCreation':
        reply.code(409);
        return {
          success: false,
          requiresUserApproval: true,
          actionRequired: 'CREATE_DIRECTORY',
          directory: result.directory,
        };

      case 'error':
        reply.code(500);
        return {
          success: false,
          error: result.errorMessage,
          errorCode: result.errorCode,
          ...(result.errorDetail ? { errorDetail: result.errorDetail } : {}),
        };
    }
  });

  typed.post('/spawn-session/resolve', {
    schema: {
      body: z.object({
        spawnNonce: z.string().trim().min(1),
      }),
      response: {
        200: z.object({
          success: z.literal(true),
          status: z.enum(['success', 'error', 'pending', 'not_found']),
          sessionId: z.string().optional(),
          errorCode: z.string().optional(),
          errorMessage: z.string().optional(),
          errorDetail: z.unknown().optional(),
        }),
        401: authSchema401,
      },
    },
    preHandler: requireAuth,
  }, async (request) => {
    const spawnNonce = request.body.spawnNonce.trim();
    if (resolveSpawnSessionByNonce) {
      try {
        const resolved = await resolveSpawnSessionByNonce(spawnNonce);
        if (resolved.status === 'success') {
          return {
            success: true as const,
            status: 'success' as const,
            sessionId: resolved.sessionId,
          };
        }
        if (resolved.status === 'error') {
          return {
            success: true as const,
            status: 'error' as const,
            errorCode: resolved.errorCode,
            errorMessage: resolved.errorMessage,
            ...(resolved.errorDetail ? { errorDetail: resolved.errorDetail } : {}),
          };
        }
        if (resolved.status === 'pending') {
          return {
            success: true as const,
            status: 'pending' as const,
          };
        }
      } catch (error) {
        logger.warn('[CONTROL SERVER] Canonical spawn nonce resolution failed; falling back to tracked children', {
          spawnNonce,
          error: readSafeDaemonControlErrorDiagnostic(error),
        });
      }
    }

    const matches = getChildren().filter((child) => child.spawnOptions?.spawnNonce === spawnNonce);
    const successMatch = matches.find((child) => isCanonicalSessionId(child.happySessionId));
    if (successMatch && isCanonicalSessionId(successMatch.happySessionId)) {
      return {
        success: true as const,
        status: 'success' as const,
        sessionId: successMatch.happySessionId.trim(),
      };
    }

    if (matches.length > 0) {
      return {
        success: true as const,
        status: 'pending' as const,
      };
    }

    return {
      success: true as const,
      status: 'not_found' as const,
    };
  });

  typed.post('/continue-with-replay', {
    schema: {
      body: z.object({
        directory: z.string(),
        agent: z.string(),
        approvedNewDirectoryCreation: z.boolean().optional(),
        permissionMode: z.string().optional(),
        permissionModeUpdatedAt: z.number().optional(),
        modelId: z.string().optional(),
        modelUpdatedAt: z.number().optional(),
        replay: z.object({
          previousSessionId: z.string(),
          strategy: z.string().optional(),
          recentMessagesCount: z.number().optional(),
          maxSeedChars: z.number().optional(),
          seedMode: z.string().optional(),
        }),
      }),
      response: {
        200: z.object({
          success: z.boolean(),
          sessionId: z.string().optional(),
          approvedNewDirectoryCreation: z.boolean().optional(),
        }),
        400: z.object({
          success: z.boolean(),
          error: z.string(),
          errorCode: z.string().optional(),
        }),
        401: authSchema401,
        403: authSchema401,
        409: z.object({
          success: z.boolean(),
          requiresUserApproval: z.boolean().optional(),
          actionRequired: z.string().optional(),
          directory: z.string().optional(),
        }),
        500: z.object({
          success: z.boolean(),
          error: z.string().optional(),
          errorCode: z.string().optional(),
          errorDetail: z.unknown().optional(),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    const normalizedDirectory = normalizeSpawnSessionDirectory(request.body.directory, process.env);
    const agentId = resolveCatalogAgentIdForCliSubcommand(request.body.agent);
    if (!agentId) {
      reply.code(400);
      return {
        success: false,
        error: 'Unknown agent id',
        errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
      };
    }

    let result: SpawnSessionResult;
    try {
      result = await continueSessionWithReplay(
        {
          directory: normalizedDirectory,
          agentId,
          approvedNewDirectoryCreation: request.body.approvedNewDirectoryCreation,
          permissionMode: request.body.permissionMode,
          permissionModeUpdatedAt: request.body.permissionModeUpdatedAt,
          modelId: request.body.modelId,
          modelUpdatedAt: request.body.modelUpdatedAt,
          replay: request.body.replay,
        },
        { spawnSession },
      );
    } catch (error) {
      const authStatus = readAuthenticationStatus(error);
      if (authStatus) {
        reply.code(authStatus);
        return {
          success: false,
          error: 'not_authenticated',
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      reply.code(500);
      return {
        success: false,
        error: `Failed to spawn session: ${message}`,
        errorCode: SPAWN_SESSION_ERROR_CODES.SPAWN_FAILED,
      };
    }

    switch (result.type) {
      case 'success':
        if (!result.sessionId) {
          reply.code(500);
          return { success: false, error: 'Failed to spawn session: no session ID returned' };
        }
        return { success: true, sessionId: result.sessionId, approvedNewDirectoryCreation: true };
      case 'requestToApproveDirectoryCreation':
        reply.code(409);
        return {
          success: false,
          requiresUserApproval: true,
          actionRequired: 'CREATE_DIRECTORY',
          directory: result.directory,
        };
      case 'error':
        reply.code(result.errorCode === SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST ? 400 : 500);
        return {
          success: false,
          error: result.errorMessage,
          errorCode: result.errorCode,
          ...(result.errorDetail ? { errorDetail: result.errorDetail } : {}),
        };
    }
  });

  // Stop daemon
  typed.post('/restart', {
    schema: {
      body: z
        .object({
          stopSessions: z.boolean().optional(),
          restartSessionRunners: z.boolean().optional(),
          successorDistClosureFingerprint: DaemonDistClosureFingerprintSchema.optional(),
        })
        .strict()
        .nullish(),
      response: {
        202: z.object({
          status: z.enum(['restarting', 'already_restarting']),
        }),
        401: authSchema401,
        409: z.object({
          status: z.literal('shutting_down'),
        }),
        400: z.union([
          z.object({
            status: z.literal('unsupported_restart_options'),
          }),
          z.object({
            statusCode: z.literal(400),
            code: z.string(),
            error: z.string(),
            message: z.string(),
          }),
        ]),
        501: z.object({
          status: z.literal('restart_unavailable'),
        }),
      },
    },
    preHandler: requireAuth,
  }, async (request, reply) => {
    if (isShuttingDown?.() === true) {
      reply.code(409);
      return { status: 'shutting_down' as const };
    }
    if (!requestSelfRestart) {
      reply.code(501);
      return { status: 'restart_unavailable' as const };
    }
    if (
      request.body &&
      (request.body.stopSessions !== undefined || request.body.restartSessionRunners !== undefined)
    ) {
      reply.code(400);
      return { status: 'unsupported_restart_options' as const };
    }
    if (restartState === 'restarting') {
      reply.code(202);
      return { status: 'already_restarting' as const };
    }

    restartState = 'restarting';
    setTimeout(() => {
      void (async () => {
        try {
          const successorDistClosureFingerprint = request.body?.successorDistClosureFingerprint;
          await requestSelfRestart(
            successorDistClosureFingerprint ? { successorDistClosureFingerprint } : undefined,
          );
        } catch (error) {
          logger.debug('[CONTROL SERVER] Daemon self-restart request failed; keeping current daemon alive', error);
        } finally {
          restartState = 'idle';
        }
      })();
    }, 50);

    reply.code(202);
    return { status: 'restarting' as const };
  });

  typed.post('/stop', {
    schema: {
      body: z
        .object({
          stopSessions: z.boolean().optional(),
        })
        .nullish(),
      response: {
        200: z.object({
          status: z.string()
        }),
        401: authSchema401,
      }
    },
    preHandler: requireAuth,
  }, async (request) => {
    const stopSessions = request.body?.stopSessions === true;
    logger.debug('[CONTROL SERVER] Stop daemon request received', { stopSessions });

    // Give time for response to arrive
    setTimeout(() => {
      logger.debug('[CONTROL SERVER] Triggering daemon shutdown');
      const runBeforeShutdown = async (): Promise<void> => {
        if (!beforeShutdown) return;
        try {
          await beforeShutdown();
        } catch (error) {
          logger.debug('[CONTROL SERVER] beforeShutdown hook failed (best-effort)', error);
        }
      };

      void (async () => {
        try {
          if (stopSessions) {
            const children = getChildren();
            logger.debug(`[CONTROL SERVER] stopSessions requested: stopping ${children.length} tracked sessions`);
            for (const child of children) {
              const sessionId = typeof child.happySessionId === 'string' ? child.happySessionId.trim() : '';
              const fallbackSessionId =
                Number.isFinite(child.pid) && child.pid > 1 ? `PID-${Math.trunc(child.pid)}` : '';
              const id = sessionId || fallbackSessionId;
              if (!id) continue;
              try {
                // eslint-disable-next-line no-await-in-loop
                await prepareStopSession?.(child);
              } catch (error) {
                logger.debug(`[CONTROL SERVER] Failed to prepare session ${id} before stop`, error);
              }
              try {
                // eslint-disable-next-line no-await-in-loop
                await stopSession(id);
              } catch (error) {
                logger.debug(`[CONTROL SERVER] Failed to stop session ${id}`, error);
              }
            }
          }
          await runBeforeShutdown();
        } catch (error) {
          logger.debug('[CONTROL SERVER] stopSessions failed', error);
        } finally {
          requestShutdown();
        }
      })();
    }, 50);

    return { status: 'stopping' };
  });

  return app;
}

export function startDaemonControlServer({
  getChildren,
  machineId,
  runtimeId = '',
  stopSession,
  prepareStopSession,
  spawnSession,
  resolveSpawnSessionByNonce,
  requestShutdown,
  beforeShutdown,
  onHappySessionWebhook,
  controlToken,
  handleConnectedServiceRuntimeAuthFailure,
  authorizeConnectedServiceRuntimeAuthFailure,
  resolveConnectedServiceRuntimeAuthResumePromptMode,
  handleConnectedServiceTurnLifecycle,
  handleConnectedServiceUsageLimitWaitResumeCancel,
  handleSessionConnectedServiceAuthSwitch,
  handleSessionRunnerRestart,
  handleSessionRunnerRestartAll,
  handleSessionRunnerStatusGet,
  handleConnectedServiceQuotaSnapshot,
  handleConnectedServiceQuotaRecoveryCreditConsume,
  handleCodexChatGptAuthTokensRefresh,
  handleClaudeSubscriptionAuthTokensRefresh,
  handleExecutionRunConnectedServiceMaterialize,
  handleExecutionRunConnectedServiceRelease,
  runtimeAuthRecoveryScheduler,
  isShuttingDown,
  requestSelfRestart,
}: {
  getChildren: () => TrackedSession[];
  machineId: string;
  runtimeId?: string;
  stopSession: (sessionId: string) => Promise<StopSessionResult>;
  prepareStopSession?: (child: TrackedSession) => Promise<void> | void;
  spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
  resolveSpawnSessionByNonce?: (spawnNonce: string) => Promise<SpawnSessionNonceResolution> | SpawnSessionNonceResolution;
  requestShutdown: () => void;
  beforeShutdown?: () => Promise<void>;
  onHappySessionWebhook: (sessionId: string, metadata: Metadata) => Promise<void> | void;
  controlToken: string;
  handleExecutionRunConnectedServiceMaterialize?: (input: Readonly<{
    runId: string;
    agentId: string;
    pid: number;
    materializationKey: string;
    connectedServicesBindingsRaw: unknown;
    sessionDirectory?: string | null;
    sessionId?: string;
  }>) => Promise<ExecutionRunConnectedServiceMaterializeResponseWire>;
  handleExecutionRunConnectedServiceRelease?: (input: Readonly<{
    runId: string;
    pid: number;
    materializationKey: string;
  }>) => Promise<Readonly<{ released: boolean }>>;
  handleConnectedServiceRuntimeAuthFailure?: (input: Readonly<{
    sessionId: string;
    switchesThisTurn: number;
    classification: ConnectedServiceRuntimeFailureClassification;
    interruptedOriginId?: string;
    resumePromptMode?: 'standard' | 'off' | 'custom';
    sourceAuthorization?: RuntimeAuthFailureSourceAuthorization;
  }>) => Promise<unknown>;
  authorizeConnectedServiceRuntimeAuthFailure?: (input: Readonly<{
    sessionId: string;
    classification: ConnectedServiceRuntimeFailureClassification;
  }>) => Promise<RuntimeAuthFailureSourceAuthorization>;
  resolveConnectedServiceRuntimeAuthResumePromptMode?: (input: Readonly<{
    classification: ConnectedServiceRuntimeFailureClassification;
    explicit?: 'standard' | 'off' | 'custom';
  }>) => Promise<'standard' | 'off' | 'custom'>;
  runtimeAuthRecoveryScheduler?: RuntimeAuthRecoverySchedulerForControlServer;
  isShuttingDown?: () => boolean;
  handleConnectedServiceTurnLifecycle?: (
    input: ConnectedServiceTurnLifecycleRequestBody,
  ) => Promise<ConnectedServiceTurnLifecycleResult>;
  // QAE-1: user "Stop waiting" propagation — cancels the daemon-side durable
  // recovery wait state (runtime-auth recovery + inactive usage-limit stores).
  handleConnectedServiceUsageLimitWaitResumeCancel?: (input: Readonly<{
    sessionId: string;
    attemptId: string;
  }>) => Promise<unknown>;
  handleSessionConnectedServiceAuthSwitch?: (input: Readonly<SessionConnectedServiceAuthSwitchRpcParams>) => Promise<unknown>;
  handleSessionRunnerRestart?: (input: RestartSessionRunnerRequestV1) => Promise<RestartSessionRunnerResultV1>;
  handleSessionRunnerRestartAll?: (
    input: RestartAllSessionRunnersRequestV1,
  ) => Promise<RestartAllSessionRunnersResultV1>;
  handleSessionRunnerStatusGet?: (input: SessionRunnerStatusGetRequestV1) => Promise<SessionRunnerRuntimeStateV1>;
  handleConnectedServiceQuotaSnapshot?: (input: Readonly<{
    sessionId: string;
    serviceId: ConnectedServiceId;
    groupId?: string | null;
    groupGeneration?: number | null;
    sourceProviderAccountId?: string | null;
    credentialFingerprint?: string | null;
    policyDisposition?: 'evidence_only';
    snapshot: ConnectedServiceQuotaSnapshotV1;
  }>) => Promise<unknown>;
  handleConnectedServiceQuotaRecoveryCreditConsume?: (input: Readonly<{
    serviceId: ConnectedServiceId;
    profileId: string;
    idempotencyKey: string;
    providerCreditId?: string;
  }>) => Promise<unknown>;
  handleCodexChatGptAuthTokensRefresh?: (input: Readonly<{
    sessionId: string;
    brokerSelectionIdentity?: string | null;
    selection: CodexChatGptAuthTokensRefreshSelection;
    chatgptPlanType: string | null;
    forceRefresh: boolean;
    failingAccessTokenFingerprint?: string | null;
  }>) => Promise<CodexChatGptAuthTokensRefreshResponse>;
  handleClaudeSubscriptionAuthTokensRefresh?: (input: Readonly<{
    sessionId: string;
    brokerSelectionIdentity?: string | null;
    selection: ClaudeSubscriptionAuthTokensRefreshSelection;
    forceRefresh: boolean;
    failingAccessTokenFingerprint?: string | null;
  }>) => Promise<ClaudeSubscriptionAuthTokensRefreshResponse>;
  requestSelfRestart?: (request?: DaemonSelfRestartRequest) => Promise<unknown>;
}): Promise<{ port: number; stop: () => Promise<void> }> {
  return new Promise((resolve) => {
    const app = createDaemonControlApp({
      getChildren,
      machineId,
      runtimeId,
      stopSession,
      prepareStopSession,
      spawnSession,
      resolveSpawnSessionByNonce,
      requestShutdown,
      beforeShutdown,
      onHappySessionWebhook,
      controlToken,
      handleConnectedServiceRuntimeAuthFailure,
      authorizeConnectedServiceRuntimeAuthFailure,
      resolveConnectedServiceRuntimeAuthResumePromptMode,
      handleConnectedServiceTurnLifecycle,
      handleConnectedServiceUsageLimitWaitResumeCancel,
      handleSessionConnectedServiceAuthSwitch,
      handleSessionRunnerRestart,
      handleSessionRunnerRestartAll,
      handleSessionRunnerStatusGet,
      handleConnectedServiceQuotaSnapshot,
      handleConnectedServiceQuotaRecoveryCreditConsume,
      handleCodexChatGptAuthTokensRefresh,
      handleClaudeSubscriptionAuthTokensRefresh,
      handleExecutionRunConnectedServiceMaterialize,
      handleExecutionRunConnectedServiceRelease,
      runtimeAuthRecoveryScheduler,
      isShuttingDown,
      requestSelfRestart,
    });

    app.listen({ port: 0, host: '127.0.0.1' }, (err, address) => {
      if (err) {
        logger.debug('[CONTROL SERVER] Failed to start:', err);
        throw err;
      }

      const port = parseInt(address.split(':').pop()!);
      logger.debug(`[CONTROL SERVER] Started on port ${port}`);

      resolve({
        port,
        stop: async () => {
          logger.debug('[CONTROL SERVER] Stopping server');
          await app.close();
          logger.debug('[CONTROL SERVER] Server stopped');
        }
      });
    });
  });
}
