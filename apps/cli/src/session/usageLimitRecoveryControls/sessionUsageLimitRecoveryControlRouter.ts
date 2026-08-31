import {
  inferAgentIdFromSessionMetadata,
  resolveAgentIdFromFlavor,
  type AgentId,
} from '@happier-dev/agents';
import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionRuntimeIssueV1Schema,
  SessionUsageLimitRecoveryV1Schema,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import { getSessionUsageLimitRecoveryControlAdapter } from '@/backends/catalog';
import type { Credentials } from '@/persistence';
import { resolveMachineControlLocalityProof } from '@/session/machineControlLocality';
import type {
  SessionEncryptionContext,
  SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import type {
  ResolveSessionUsageLimitRecoveryControlAdapter,
  SessionUsageLimitRecoveryControlAdapterParams,
} from './sessionUsageLimitRecoveryControlTypes';
import { deriveUsageLimitRecoveryTiming } from './deriveUsageLimitRecoveryTiming';
import {
  resolveRoutedUsageLimitRecoveryResumePromptMode,
  type RoutedUsageLimitRecoveryResumePromptTierSources,
} from './resolveRoutedUsageLimitRecoveryResumePromptMode';
import {
  attachCliSessionUsageLimitRecoveryOperationMetadata,
  normalizeCliSessionUsageLimitRecoveryOperationResult,
} from './sessionUsageLimitRecoveryOperationResult';
import {
  UsageLimitCheckNowRateLimiter,
  USAGE_LIMIT_CHECK_NOW_RATE_LIMITED_CODE,
} from './usageLimitCheckNowRateLimiter';
import { resolveUsageLimitRecoverySelectedAuthFromIssue } from './usageLimitRecoverySelectedAuth';
import { persistUsageLimitRecoveryFieldDurably } from './persistUsageLimitRecoveryFieldDurably';
import { hasSameUsageLimitRecoveryIdentity } from './mergeUsageLimitRecoveryIntent';
import { readLatestUsageLimitFailureIssue } from './readLatestUsageLimitFailureIssue';

type RouteSessionUsageLimitRecoveryControlParams = Readonly<{
  token: string;
  credentials?: Credentials;
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown> | null;
  currentMachineId: string | null;
  currentMachineHost?: string | null;
  currentMachineHomeDir?: string | null;
  ctx: SessionEncryptionContext;
  mode: SessionStoredContentEncryptionMode;
  callLiveSessionRpc: () => Promise<unknown>;
  retryTemporaryThrottleNow?: (input: Readonly<{
    sessionId: string;
  }>) => Promise<unknown> | unknown;
  resumeInactiveSessionWhenReady?: (input: Readonly<{
    sessionId: string;
    rawSession: RawSessionRecord;
    metadata: Record<string, unknown>;
  }>) => Promise<boolean> | boolean;
  ensureSessionRuntimeForPendingInput?: (input: Readonly<{
    sessionId: string;
    rawSession: RawSessionRecord;
    metadata: Record<string, unknown>;
    requestId: string;
  }>) => Promise<boolean> | boolean;
  resolveAdapter?: ResolveSessionUsageLimitRecoveryControlAdapter;
  /**
   * Lower precedence tiers (group policy, then account setting)
   * for resume-prompt-mode resolution. Explicit request values and the stored
   * intent always win over these tiers.
   */
  resumePromptTierSources?: RoutedUsageLimitRecoveryResumePromptTierSources;
}>;

type RouteSessionUsageLimitRecoveryWaitResumeEnableParams =
  RouteSessionUsageLimitRecoveryControlParams & Readonly<{
    request: Readonly<{
      sessionId: string;
      issueFingerprint?: string;
      remember?: boolean;
      rememberPreference?: boolean;
      resumePromptMode?: 'standard' | 'off' | 'custom';
    }>;
  }>;

type RouteSessionUsageLimitRecoveryWaitResumeCancelParams =
  RouteSessionUsageLimitRecoveryControlParams & Readonly<{
    request: Readonly<{
      sessionId: string;
      issueFingerprint?: string | null;
      armedAtMs?: number;
      runtimeAuthRecoveryAttemptId?: string;
    }>;
  }>;

type RouteSessionUsageLimitRecoveryCheckNowParams =
  RouteSessionUsageLimitRecoveryControlParams & Readonly<{
    request?: Readonly<{
      sessionId: string;
      provider?: string;
      operation?: 'check_now' | 'switch_account_now' | 'consume_reset_credit';
      resumePromptMode?: 'standard' | 'off' | 'custom';
    }>;
  }>;

function stableError(errorCode: string): Readonly<{ ok: false; errorCode: string; error: string }> {
  return { ok: false, errorCode, error: errorCode };
}

function operationResult(
  params: Pick<RouteSessionUsageLimitRecoveryControlParams, 'sessionId'>,
  result: unknown,
) {
  return normalizeCliSessionUsageLimitRecoveryOperationResult({
    sessionId: params.sessionId,
    result,
  });
}

const inactiveCheckNowRateLimiter = new UsageLimitCheckNowRateLimiter({ nowMs: () => Date.now() });

function stableRateLimitedError(retryAfterMs: number): Readonly<{
  ok: false;
  errorCode: typeof USAGE_LIMIT_CHECK_NOW_RATE_LIMITED_CODE;
  error: typeof USAGE_LIMIT_CHECK_NOW_RATE_LIMITED_CODE;
  retryAfterMs: number;
}> {
  return {
    ok: false,
    errorCode: USAGE_LIMIT_CHECK_NOW_RATE_LIMITED_CODE,
    error: USAGE_LIMIT_CHECK_NOW_RATE_LIMITED_CODE,
    retryAfterMs,
  };
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolveRawSessionString(rawSession: RawSessionRecord, key: 'path' | 'machineId' | 'host' | 'homeDir'): string | null {
  return readString((rawSession as Partial<Record<typeof key, unknown>>)[key]);
}

function resolveSessionMachineHost(
  metadata: Record<string, unknown>,
  rawSession: RawSessionRecord,
): string | null {
  return readString(metadata.host) ?? resolveRawSessionString(rawSession, 'host');
}

function resolveSessionMachineHomeDir(
  metadata: Record<string, unknown>,
  rawSession: RawSessionRecord,
): string | null {
  return readString(metadata.homeDir) ?? resolveRawSessionString(rawSession, 'homeDir');
}

function resolveAgentId(metadata: Record<string, unknown>): AgentId | null {
  return inferAgentIdFromSessionMetadata(metadata);
}

function hasLiveSessionUsageLimitRpcFailureCode(
  result: unknown,
  failureCodes: readonly string[],
): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const raw = result as Record<string, unknown>;
  const errorCode = typeof raw.errorCode === 'string' ? raw.errorCode : '';
  const error = typeof raw.error === 'string' ? raw.error : '';
  return failureCodes.includes(errorCode) || failureCodes.includes(error);
}

function shouldFallbackFromLiveSessionUsageLimitRpc(result: unknown): boolean {
  return hasLiveSessionUsageLimitRpcFailureCode(result, [
    RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    RPC_ERROR_CODES.METHOD_NOT_FOUND,
    'unsupported_session_runtime_method',
    'session_rpc_failed',
    'codex_app_server_control_unavailable',
  ]);
}

function shouldEnsureSessionRuntimeAfterLiveFailure(result: unknown): boolean {
  return hasLiveSessionUsageLimitRpcFailureCode(result, [
    'session_rpc_failed',
    'codex_app_server_control_unavailable',
  ]);
}

async function buildAdapterParams(
  params: RouteSessionUsageLimitRecoveryControlParams,
  metadata: Record<string, unknown>,
  sessionMachineId: string,
): Promise<SessionUsageLimitRecoveryControlAdapterParams> {
  const request = 'request' in params && params.request && typeof params.request === 'object'
    ? params.request as Readonly<{ resumePromptMode?: unknown }>
    : null;
  return {
    token: params.token,
    ...(params.credentials ? { credentials: params.credentials } : {}),
    sessionId: params.sessionId,
    rawSession: params.rawSession,
    metadata,
    currentMachineId: params.currentMachineId,
    sessionMachineId,
    cwd: resolveRawSessionString(params.rawSession, 'path') ?? readString(metadata.path),
    ctx: params.ctx,
    mode: params.mode,
    resumePromptMode: await resolveRoutedUsageLimitRecoveryResumePromptMode({
      explicit: request?.resumePromptMode,
      existingIntent: metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY],
      ...params.resumePromptTierSources,
    }),
  };
}

function readMetadataResult(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = (value as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  return metadata as Record<string, unknown>;
}

async function persistAdapterMetadataResult(
  params: RouteSessionUsageLimitRecoveryControlParams,
  result: unknown,
): Promise<unknown> {
  const nextMetadata = readMetadataResult(result);
  if (
    !nextMetadata
    || !Object.prototype.hasOwnProperty.call(nextMetadata, SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY)
    || !params.credentials
  ) return result;

  const persisted = await persistUsageLimitRecoveryFieldDurably({
    token: params.token,
    credentials: params.credentials,
    sessionId: params.sessionId,
    rawSession: params.rawSession,
    currentMetadata: params.metadata ?? {},
    nextMetadata,
  });

  return {
    ...(result as Record<string, unknown>),
    metadata: persisted,
  };
}

function parseRecoveryIntent(metadata: Record<string, unknown>): SessionUsageLimitRecoveryV1 | null {
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}

function buildUsageLimitIssueFingerprint(
  issue: NonNullable<ReturnType<typeof SessionRuntimeIssueV1Schema.safeParse>['data']>,
): string {
  return [
    'usage-limit',
    issue.provider ?? 'unknown-provider',
    issue.providerTurnId ?? 'unknown-turn',
    String(issue.occurredAt),
    issue.usageLimit?.resetAtMs === null || issue.usageLimit?.resetAtMs === undefined
      ? 'no-reset'
      : String(issue.usageLimit.resetAtMs),
  ].join(':');
}

function isRetryableTemporaryThrottleIssue(rawSession: RawSessionRecord): boolean {
  const issueParsed = SessionRuntimeIssueV1Schema.safeParse(rawSession.lastRuntimeIssue);
  return issueParsed.success
    && issueParsed.data.temporaryThrottle?.v === 1
    && issueParsed.data.temporaryThrottle.recoverability === 'retry';
}

function buildRecoveryIntentFromLatestUsageLimitIssue(
  params: Readonly<{
    rawSession: RawSessionRecord;
    issueFingerprint?: string;
    resumePromptMode: 'standard' | 'off' | 'custom';
  }>,
): SessionUsageLimitRecoveryV1 | null {
  const issue = readLatestUsageLimitFailureIssue(params.rawSession);
  if (!issue?.usageLimit) return null;

  const selectedAuth = resolveUsageLimitRecoverySelectedAuthFromIssue({
    issue,
  }) ?? { kind: 'native' };

  const timing = deriveUsageLimitRecoveryTiming({
    occurredAtMs: issue.occurredAt,
    resetAtMs: issue.usageLimit.resetAtMs,
    retryAfterMs: issue.usageLimit.retryAfterMs,
  });

  return {
    v: 1,
    status: 'waiting',
    issueFingerprint: params.issueFingerprint ?? buildUsageLimitIssueFingerprint(issue),
    armedAtMs: issue.occurredAt,
    resetAtMs: timing.resetAtMs,
    nextCheckAtMs: timing.nextCheckAtMs,
    attemptCount: 0,
    maxAttempts: 3,
    lastProbeError: null,
    resumePromptMode: params.resumePromptMode,
    selectedAuth,
  };
}

async function buildEnabledRecoveryIntent(
  params: RouteSessionUsageLimitRecoveryWaitResumeEnableParams,
  metadata: Record<string, unknown>,
): Promise<SessionUsageLimitRecoveryV1 | null> {
  const existing = parseRecoveryIntent(metadata);
  const issueFingerprint =
    typeof params.request.issueFingerprint === 'string' && params.request.issueFingerprint.trim().length > 0
      ? params.request.issueFingerprint.trim()
      : undefined;
  const rawExisting = metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY];
  const resumePromptMode = await resolveRoutedUsageLimitRecoveryResumePromptMode({
    explicit: params.request.resumePromptMode,
    existingIntent: rawExisting,
    ...params.resumePromptTierSources,
  });
  const base = existing ?? buildRecoveryIntentFromLatestUsageLimitIssue({
    rawSession: params.rawSession,
    resumePromptMode,
    ...(issueFingerprint ? { issueFingerprint } : {}),
  });
  if (!base) return null;
  return {
    ...base,
    status: 'waiting',
    ...(existing?.status === 'cancelled' ? { attemptCount: 0 } : {}),
    ...(issueFingerprint ? { issueFingerprint } : {}),
    resumePromptMode,
    lastProbeError: null,
  };
}

async function persistUsageLimitRecoveryMetadata(
  params: RouteSessionUsageLimitRecoveryControlParams,
  updater: (metadata: Record<string, unknown>) => Record<string, unknown>,
  mode: 'converge' | 'rearm' | 'explicit_rearm' | 'cancel' = 'converge',
): Promise<Record<string, unknown> | null> {
  if (!params.credentials) return null;
  const currentMetadata = params.metadata ?? {};
  return await persistUsageLimitRecoveryFieldDurably({
    token: params.token,
    credentials: params.credentials,
    sessionId: params.sessionId,
    rawSession: params.rawSession,
    currentMetadata,
    nextMetadata: updater(currentMetadata),
    mode,
  });
}

async function ensureLocalInactiveControlContext(
  params: RouteSessionUsageLimitRecoveryControlParams,
): Promise<Readonly<
  | { ok: true; metadata: Record<string, unknown>; sessionMachineId: string }
  | { ok: false; result: ReturnType<typeof stableError> }
>> {
  const metadata = params.metadata;
  if (!metadata) {
    return { ok: false, result: stableError('session_usage_limit_recovery_control_metadata_unavailable') };
  }

  const currentMachineId = readString(params.currentMachineId);
  if (!currentMachineId) {
    return { ok: false, result: stableError('session_usage_limit_recovery_control_current_machine_unknown') };
  }

  const sessionMachineId = readString(metadata.machineId) ?? resolveRawSessionString(params.rawSession, 'machineId');
  if (!sessionMachineId) {
    return { ok: false, result: stableError('session_usage_limit_recovery_control_session_machine_unknown') };
  }
  if (
    !await resolveMachineControlLocalityProof({
      sessionMachineId,
      currentMachineId,
      sessionHost: resolveSessionMachineHost(metadata, params.rawSession),
      sessionHomeDir: resolveSessionMachineHomeDir(metadata, params.rawSession),
      currentMachineHost: params.currentMachineHost,
      currentMachineHomeDir: params.currentMachineHomeDir,
      credentials: { token: params.token },
    })
  ) {
    return { ok: false, result: stableError('session_usage_limit_recovery_control_remote_unavailable') };
  }

  return { ok: true, metadata, sessionMachineId };
}

export async function routeSessionUsageLimitRecoveryWaitResumeEnable(
  params: RouteSessionUsageLimitRecoveryWaitResumeEnableParams,
): Promise<unknown> {
  if (params.rawSession.active === true) {
    const liveResult = await params.callLiveSessionRpc();
    if (!shouldFallbackFromLiveSessionUsageLimitRpc(liveResult)) {
      return operationResult(params, liveResult);
    }
  }

  const context = await ensureLocalInactiveControlContext(params);
  if (!context.ok) return operationResult(params, context.result);

  const nextIntent = await buildEnabledRecoveryIntent(params, context.metadata);
  if (!nextIntent) {
    return operationResult(params, stableError('session_usage_limit_recovery_control_inactive'));
  }

  const persistedMetadata = await persistUsageLimitRecoveryMetadata(params, (currentMetadata) => ({
    ...currentMetadata,
    [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: nextIntent,
  }), 'explicit_rearm');

  const persistedIntent = persistedMetadata ? parseRecoveryIntent(persistedMetadata) : null;

  return attachCliSessionUsageLimitRecoveryOperationMetadata(operationResult(params, {
    ok: true,
    recovery: { status: persistedIntent?.status ?? nextIntent.status },
    ...(persistedMetadata ? { metadata: persistedMetadata } : {}),
  }), persistedMetadata);
}

export async function routeSessionUsageLimitRecoveryWaitResumeCancel(
  params: RouteSessionUsageLimitRecoveryWaitResumeCancelParams,
): Promise<unknown> {
  if (params.rawSession.active === true) {
    const liveResult = await params.callLiveSessionRpc();
    if (!shouldFallbackFromLiveSessionUsageLimitRpc(liveResult)) {
      return operationResult(params, liveResult);
    }
  }

  const context = await ensureLocalInactiveControlContext(params);
  if (!context.ok) return operationResult(params, context.result);

  const existing = parseRecoveryIntent(context.metadata);
  const requestedFingerprint = params.request.issueFingerprint;
  const requestedArmedAtMs = params.request.armedAtMs;
  if (
    !existing
    || typeof requestedFingerprint !== 'string'
    || requestedFingerprint.trim().length === 0
    || typeof requestedArmedAtMs !== 'number'
  ) {
    return operationResult(params, stableError('session_usage_limit_recovery_control_attempt_identity_required'));
  }
  const requestedIdentity = {
    issueFingerprint: requestedFingerprint.trim(),
    armedAtMs: Math.trunc(requestedArmedAtMs),
    ...(typeof params.request.runtimeAuthRecoveryAttemptId === 'string'
      && params.request.runtimeAuthRecoveryAttemptId.trim().length > 0
      ? { runtimeAuthRecoveryAttemptId: params.request.runtimeAuthRecoveryAttemptId.trim() }
      : {}),
  };
  if (!hasSameUsageLimitRecoveryIdentity(existing, requestedIdentity)) {
    return operationResult(params, stableError('session_usage_limit_recovery_control_issue_mismatch'));
  }

  const persistedMetadata = await persistUsageLimitRecoveryMetadata(params, (currentMetadata) => ({
    ...currentMetadata,
    [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
      ...existing,
      status: 'cancelled',
      nextCheckAtMs: null,
    },
  }), 'cancel');
  const persistedIntent = persistedMetadata ? parseRecoveryIntent(persistedMetadata) : null;
  if (
    persistedIntent
    && (
      !hasSameUsageLimitRecoveryIdentity(persistedIntent, existing)
      || persistedIntent.status !== 'cancelled'
    )
  ) {
    return operationResult(params, stableError('session_usage_limit_recovery_control_issue_mismatch'));
  }

  return attachCliSessionUsageLimitRecoveryOperationMetadata(operationResult(params, {
    ok: true,
    recovery: { status: 'cancelled' },
    ...(persistedMetadata ? { metadata: persistedMetadata } : {}),
  }), persistedMetadata);
}

export async function routeSessionUsageLimitRecoveryCheckNow(
  params: RouteSessionUsageLimitRecoveryCheckNowParams,
): Promise<unknown> {
  const operation = params.request?.operation === 'consume_reset_credit' ? 'consumeResetCredit' : 'checkNow';
  if (params.retryTemporaryThrottleNow && isRetryableTemporaryThrottleIssue(params.rawSession)) {
    return operationResult(
      params,
      await params.retryTemporaryThrottleNow({ sessionId: params.sessionId }),
    );
  }

  if (operation === 'checkNow' && params.rawSession.active === true) {
    const liveResult = await params.callLiveSessionRpc();
    if (!shouldFallbackFromLiveSessionUsageLimitRpc(liveResult)) {
      return operationResult(params, liveResult);
    }
    const latestUsageLimitIssue = params.rawSession.latestTurnStatus === 'failed'
      ? readLatestUsageLimitFailureIssue(params.rawSession)
      : null;
    if (
      latestUsageLimitIssue
      && params.metadata
      && params.ensureSessionRuntimeForPendingInput
      && shouldEnsureSessionRuntimeAfterLiveFailure(liveResult)
    ) {
      const ensured = await params.ensureSessionRuntimeForPendingInput({
        sessionId: params.sessionId,
        rawSession: params.rawSession,
        metadata: params.metadata,
        requestId: `session.usageLimit.checkNow:${latestUsageLimitIssue.providerTurnId ?? latestUsageLimitIssue.occurredAt}`,
      });
      return ensured
        ? operationResult(params, { ok: true, status: 'resumed', sessionId: params.sessionId })
        : operationResult(params, liveResult);
    }
  }

  const context = await ensureLocalInactiveControlContext(params);
  if (!context.ok) return operationResult(params, context.result);

  const resolveAdapter = params.resolveAdapter ?? getSessionUsageLimitRecoveryControlAdapter;
  const adapterAgentId = resolveAgentIdFromFlavor(params.request?.provider) ?? resolveAgentId(context.metadata);
  const adapter = await resolveAdapter(adapterAgentId);
  const adapterOperation = operation === 'consumeResetCredit' ? adapter?.consumeResetCredit : adapter?.checkNow;
  if (!adapterOperation) {
    return operationResult(params, stableError('session_usage_limit_recovery_control_provider_unsupported'));
  }

  const rateLimit = inactiveCheckNowRateLimiter.check(`${params.sessionId}\0${adapterAgentId ?? 'unknown'}`);
  if (!rateLimit.allowed) {
    return operationResult(params, stableRateLimitedError(rateLimit.retryAfterMs));
  }

  const result = await persistAdapterMetadataResult(
    params,
    await adapterOperation(await buildAdapterParams(params, context.metadata, context.sessionMachineId)),
  );
  const resultMetadata = readMetadataResult(result);
  const normalizedResult = operationResult(params, result);
  if (normalizedResult.ok && normalizedResult.status === 'ready' && params.resumeInactiveSessionWhenReady) {
    const resumed = await params.resumeInactiveSessionWhenReady({
      sessionId: params.sessionId,
      rawSession: params.rawSession,
      metadata: resultMetadata ?? context.metadata,
    });
    if (resumed) {
      const settledMetadata = await persistUsageLimitRecoveryMetadata(params, (currentMetadata) => {
        const currentRecovery = parseRecoveryIntent(currentMetadata)
          ?? (resultMetadata ? parseRecoveryIntent(resultMetadata) : null);
        if (!currentRecovery) return currentMetadata;
        return {
          ...currentMetadata,
          [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
            ...currentRecovery,
            status: 'cancelled',
            nextCheckAtMs: null,
          },
        };
      });
      return attachCliSessionUsageLimitRecoveryOperationMetadata(operationResult(params, {
        ...normalizedResult,
        status: 'resumed',
      }), settledMetadata ?? resultMetadata);
    }
    return operationResult(params, stableError('session_usage_limit_recovery_resume_failed'));
  }
  return attachCliSessionUsageLimitRecoveryOperationMetadata(normalizedResult, resultMetadata);
}
