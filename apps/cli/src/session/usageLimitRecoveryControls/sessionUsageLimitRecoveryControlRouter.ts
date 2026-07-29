import {
  inferAgentIdFromSessionMetadata,
  resolveAgentIdFromFlavor,
  type AgentId,
} from '@happier-dev/agents';
import { writeSessionStateFieldToMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import {
  isSameMachineLocality,
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  SessionRuntimeIssueV1Schema,
  SessionUsageLimitRecoveryV1Schema,
  type SessionUsageLimitRecoveryResumePromptModeV1,
  type SessionUsageLimitRecoveryV1,
  type SessionMetadata,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';

import { resolveInactiveSessionUsageLimitRecoveryControls } from './catalogHooks';
import type { Credentials } from '@/persistence';
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
  UsageLimitCheckNowRateLimiter,
  USAGE_LIMIT_CHECK_NOW_RATE_LIMITED_CODE,
} from './usageLimitCheckNowRateLimiter';
import {
  buildUsageLimitRecoveryOperationSuccess,
  normalizeUsageLimitRecoveryOperationResult,
} from './sessionUsageLimitRecoveryOperationResult';
import {
  persistUsageLimitRecoveryFieldDurably,
  type StageUsageLimitRecoveryMutation,
} from './persistUsageLimitRecoveryFieldDurably';
import { resolveRoutedUsageLimitRecoveryResumePromptMode } from './resolveRoutedUsageLimitRecoveryResumePromptMode';
import { hasSameUsageLimitRecoveryIdentity } from './mergeUsageLimitRecoveryIntent';

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
  stageUsageLimitRecoveryMutation: StageUsageLimitRecoveryMutation;
  resolveAdapter?: ResolveSessionUsageLimitRecoveryControlAdapter;
  retryTemporaryThrottleNow?: (input: Readonly<{
    sessionId: string;
  }>) => Promise<unknown> | unknown;
  resumeInactiveSessionWhenReady?: (input: Readonly<{
    sessionId: string;
    rawSession: RawSessionRecord;
    metadata: Record<string, unknown>;
  }>) => Promise<boolean>;
  resumePromptTierSources?: Readonly<{
    accountSettings?: unknown;
    loadGroupPolicy?: (selectedAuth: SessionUsageLimitRecoveryV1['selectedAuth'] | null) => Promise<unknown> | unknown;
  }>;
}>;

type RouteSessionUsageLimitRecoveryWaitResumeEnableParams =
  RouteSessionUsageLimitRecoveryControlParams & Readonly<{
    request: Readonly<{
      sessionId: string;
      issueFingerprint?: string;
      remember?: boolean;
      rememberPreference?: boolean;
      resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
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
      agentId?: string;
      issueFingerprint?: string;
      operation?: 'check_now' | 'switch_account_now' | 'consume_reset_credit';
      resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1;
    }>;
  }>;

function stableError(
  errorCode: string,
  sessionId: string,
): ReturnType<typeof normalizeUsageLimitRecoveryOperationResult> {
  return normalizeUsageLimitRecoveryOperationResult(
    { ok: false, errorCode, error: errorCode },
    { sessionId },
  );
}

const inactiveCheckNowRateLimiter = new UsageLimitCheckNowRateLimiter({ nowMs: () => Date.now() });

function stableRateLimitedError(
  retryAfterMs: number,
  sessionId: string,
): ReturnType<typeof normalizeUsageLimitRecoveryOperationResult> {
  return normalizeUsageLimitRecoveryOperationResult(
    {
      ok: false,
      errorCode: USAGE_LIMIT_CHECK_NOW_RATE_LIMITED_CODE,
      error: USAGE_LIMIT_CHECK_NOW_RATE_LIMITED_CODE,
      retryAfterMs,
    },
    { sessionId },
  );
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readResumePromptMode(value: unknown): SessionUsageLimitRecoveryResumePromptModeV1 | null {
  return value === 'standard' || value === 'off' || value === 'custom' ? value : null;
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

function isCurrentDaemonReplacementForSessionMachine(params: Readonly<{
  metadata: Record<string, unknown>;
  rawSession: RawSessionRecord;
  currentMachineHost?: string | null;
  currentMachineHomeDir?: string | null;
}>): boolean {
  const sessionHost = resolveSessionMachineHost(params.metadata, params.rawSession);
  const currentHost = readString(params.currentMachineHost);
  const currentHomeDir = readString(params.currentMachineHomeDir);
  return isSameMachineLocality({
    sessionHost,
    sessionHomeDir: resolveSessionMachineHomeDir(params.metadata, params.rawSession),
    currentHost,
    currentHomeDir,
    homeDir: currentHomeDir,
  });
}

function shouldFallbackFromLiveSessionUsageLimitRpc(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const raw = result as Record<string, unknown>;
  const errorCode = typeof raw.errorCode === 'string' ? raw.errorCode : '';
  const error = typeof raw.error === 'string' ? raw.error : '';
  return errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
    || errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND
    || errorCode === 'unsupported_session_runtime_method'
    || errorCode === 'session_rpc_failed'
    || error === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
    || error === RPC_ERROR_CODES.METHOD_NOT_FOUND
    || error === 'unsupported_session_runtime_method'
    || error === 'session_rpc_failed';
}

function buildAdapterParams(
  params: RouteSessionUsageLimitRecoveryControlParams,
  metadata: Record<string, unknown>,
  sessionMachineId: string,
  resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1,
  issueFingerprint?: string,
): SessionUsageLimitRecoveryControlAdapterParams {
  return {
    token: params.token,
    ...(params.credentials ? { credentials: params.credentials } : {}),
    sessionId: params.sessionId,
    rawSession: params.rawSession,
    metadata,
    currentMachineId: params.currentMachineId,
    sessionMachineId,
    cwd: resolveRawSessionString(params.rawSession, 'path') ?? readString(metadata.path),
    ...(issueFingerprint ? { issueFingerprint } : {}),
    ...(resumePromptMode ? { resumePromptMode } : {}),
    ctx: params.ctx,
    mode: params.mode,
  };
}

function readMetadataResult(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const metadata = (value as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  return metadata as Record<string, unknown>;
}

function readOkStatus(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  return raw.ok === true && typeof raw.status === 'string' ? raw.status : null;
}

function readUsageLimitRecoveryMetadataValue(metadata: Record<string, unknown>): SessionUsageLimitRecoveryV1 | null {
  if (!Object.prototype.hasOwnProperty.call(metadata, SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY)) return null;
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}

async function persistAdapterMetadataResult(
  params: RouteSessionUsageLimitRecoveryControlParams,
  result: unknown,
): Promise<unknown> {
  const nextMetadata = readMetadataResult(result);
  const usageLimitRecovery = nextMetadata ? readUsageLimitRecoveryMetadataValue(nextMetadata) : null;
  if (!usageLimitRecovery || !params.credentials) return result;
  const persisted = await persistUsageLimitRecoveryFieldDurably({
    sessionId: params.sessionId,
    currentMetadata: params.metadata ?? {},
    nextMetadata: writeSessionStateFieldToMetadata(
      (params.metadata ?? {}) as SessionMetadata,
      'runtime.usageLimitRecovery',
      usageLimitRecovery,
    ) as Record<string, unknown>,
    stageUsageLimitRecoveryMutation: params.stageUsageLimitRecoveryMutation,
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
    issue.agentId ?? 'unknown-agent',
    issue.agentTurnId ?? 'unknown-turn',
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
  }>,
): SessionUsageLimitRecoveryV1 | null {
  if (params.rawSession.latestTurnStatus != null && params.rawSession.latestTurnStatus !== 'failed') {
    return null;
  }

  const issueParsed = SessionRuntimeIssueV1Schema.safeParse(params.rawSession.lastRuntimeIssue);
  if (!issueParsed.success || issueParsed.data.source !== 'usage_limit' || !issueParsed.data.usageLimit) {
    return null;
  }

  const connectedService = issueParsed.data.usageLimit.connectedService;
  const selectedAuth: SessionUsageLimitRecoveryV1['selectedAuth'] =
    connectedService?.groupId
      ? {
        kind: 'group',
        serviceId: connectedService.serviceId,
        groupId: connectedService.groupId,
        profileId: connectedService.profileId ?? null,
      }
      : connectedService?.profileId
        ? {
          kind: 'profile',
          serviceId: connectedService.serviceId,
          profileId: connectedService.profileId,
        }
        : { kind: 'native' };

  const timing = deriveUsageLimitRecoveryTiming({
    occurredAtMs: issueParsed.data.occurredAt,
    resetAtMs: issueParsed.data.usageLimit.resetAtMs,
    retryAfterMs: issueParsed.data.usageLimit.retryAfterMs,
  });

  return {
    v: 1,
    status: 'waiting',
    resumePromptMode: 'standard',
    issueFingerprint: params.issueFingerprint ?? buildUsageLimitIssueFingerprint(issueParsed.data),
    armedAtMs: issueParsed.data.occurredAt,
    resetAtMs: timing.resetAtMs,
    nextCheckAtMs: timing.nextCheckAtMs,
    attemptCount: 0,
    maxAttempts: 3,
    lastProbeError: null,
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
  const base = existing ?? buildRecoveryIntentFromLatestUsageLimitIssue({
    rawSession: params.rawSession,
    ...(issueFingerprint ? { issueFingerprint } : {}),
  });
  if (!base) return null;
  const resumePromptMode = await resolveRoutedUsageLimitRecoveryResumePromptMode({
    explicit: params.request.resumePromptMode,
    existingIntent: existing,
    accountSettings: params.resumePromptTierSources?.accountSettings,
    loadGroupPolicy: params.resumePromptTierSources?.loadGroupPolicy
      ? () => params.resumePromptTierSources!.loadGroupPolicy!(base.selectedAuth)
      : undefined,
  });
  return {
    ...base,
    status: 'waiting',
    ...(existing?.status === 'cancelled' ? { attemptCount: 0 } : {}),
    resumePromptMode,
    ...(issueFingerprint ? { issueFingerprint } : {}),
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
  const nextMetadata = updater(currentMetadata);
  return await persistUsageLimitRecoveryFieldDurably({
    sessionId: params.sessionId,
    currentMetadata,
    nextMetadata,
    mode,
    stageUsageLimitRecoveryMutation: params.stageUsageLimitRecoveryMutation,
  });
}

function ensureLocalInactiveControlContext(
  params: RouteSessionUsageLimitRecoveryControlParams,
): Readonly<
  | { ok: true; metadata: Record<string, unknown>; sessionMachineId: string }
  | { ok: false; result: ReturnType<typeof normalizeUsageLimitRecoveryOperationResult> }
> {
  const metadata = params.metadata;
  if (!metadata) {
    return {
      ok: false,
      result: stableError('session_usage_limit_recovery_control_metadata_unavailable', params.sessionId),
    };
  }

  const currentMachineId = readString(params.currentMachineId);
  if (!currentMachineId) {
    return {
      ok: false,
      result: stableError('session_usage_limit_recovery_control_current_machine_unknown', params.sessionId),
    };
  }

  const sessionMachineId = readString(metadata.machineId) ?? resolveRawSessionString(params.rawSession, 'machineId');
  if (!sessionMachineId) {
    return {
      ok: false,
      result: stableError('session_usage_limit_recovery_control_session_machine_unknown', params.sessionId),
    };
  }
  if (
    sessionMachineId !== currentMachineId
    && !isCurrentDaemonReplacementForSessionMachine({
      metadata,
      rawSession: params.rawSession,
      currentMachineHost: params.currentMachineHost,
      currentMachineHomeDir: params.currentMachineHomeDir,
    })
  ) {
    return {
      ok: false,
      result: stableError('session_usage_limit_recovery_control_remote_unavailable', params.sessionId),
    };
  }

  return { ok: true, metadata, sessionMachineId };
}

export async function routeSessionUsageLimitRecoveryWaitResumeEnable(
  params: RouteSessionUsageLimitRecoveryWaitResumeEnableParams,
): Promise<unknown> {
  if (params.rawSession.active === true) {
    const liveResult = normalizeUsageLimitRecoveryOperationResult(await params.callLiveSessionRpc(), {
      sessionId: params.sessionId,
    });
    if (!shouldFallbackFromLiveSessionUsageLimitRpc(liveResult)) {
      return liveResult;
    }
  }

  const context = ensureLocalInactiveControlContext(params);
  if (!context.ok) return context.result;

  const nextIntent = await buildEnabledRecoveryIntent(params, context.metadata);
  if (!nextIntent) return stableError('session_usage_limit_recovery_control_inactive', params.sessionId);

  const persistedMetadata = await persistUsageLimitRecoveryMetadata(params, (currentMetadata) => ({
    ...currentMetadata,
    [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: nextIntent,
  }), 'explicit_rearm');

  return buildUsageLimitRecoveryOperationSuccess({
    sessionId: params.sessionId,
    status: 'waiting',
    metadata: persistedMetadata,
  });
}

export async function routeSessionUsageLimitRecoveryWaitResumeCancel(
  params: RouteSessionUsageLimitRecoveryWaitResumeCancelParams,
): Promise<unknown> {
  if (params.rawSession.active === true) {
    const liveResult = normalizeUsageLimitRecoveryOperationResult(await params.callLiveSessionRpc(), {
      sessionId: params.sessionId,
    });
    if (!shouldFallbackFromLiveSessionUsageLimitRpc(liveResult)) {
      return liveResult;
    }
  }

  const context = ensureLocalInactiveControlContext(params);
  if (!context.ok) return context.result;

  const existing = parseRecoveryIntent(context.metadata);
  const requestedFingerprint = params.request.issueFingerprint;
  const requestedArmedAtMs = params.request.armedAtMs;
  if (
    !existing
    || typeof requestedFingerprint !== 'string'
    || requestedFingerprint.trim().length === 0
    || typeof requestedArmedAtMs !== 'number'
  ) {
    return stableError('session_usage_limit_recovery_control_attempt_identity_required', params.sessionId);
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
    return stableError('session_usage_limit_recovery_control_issue_mismatch', params.sessionId);
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
  ) return stableError('session_usage_limit_recovery_control_issue_mismatch', params.sessionId);

  return buildUsageLimitRecoveryOperationSuccess({
    sessionId: params.sessionId,
    status: 'cancelled',
    metadata: persistedMetadata,
  });
}

export async function routeSessionUsageLimitRecoveryCheckNow(
  params: RouteSessionUsageLimitRecoveryCheckNowParams,
): Promise<unknown> {
  const operation = params.request?.operation === 'consume_reset_credit' ? 'consume_reset_credit' : 'check_now';

  if (operation === 'check_now' && params.retryTemporaryThrottleNow && isRetryableTemporaryThrottleIssue(params.rawSession)) {
    return normalizeUsageLimitRecoveryOperationResult(
      await params.retryTemporaryThrottleNow({ sessionId: params.sessionId }),
      { sessionId: params.sessionId },
    );
  }

  if (operation === 'check_now' && params.rawSession.active === true) {
    const liveResult = normalizeUsageLimitRecoveryOperationResult(await params.callLiveSessionRpc(), {
      sessionId: params.sessionId,
    });
    if (!shouldFallbackFromLiveSessionUsageLimitRpc(liveResult)) {
      return liveResult;
    }
  }

  const context = ensureLocalInactiveControlContext(params);
  if (!context.ok) return context.result;
  const existingPromptIntent = parseRecoveryIntent(context.metadata);
  const resumePromptMode = await resolveRoutedUsageLimitRecoveryResumePromptMode({
    explicit: params.request?.resumePromptMode,
    existingIntent: existingPromptIntent,
    accountSettings: params.resumePromptTierSources?.accountSettings,
    loadGroupPolicy: params.resumePromptTierSources?.loadGroupPolicy
      ? () => params.resumePromptTierSources!.loadGroupPolicy!(existingPromptIntent?.selectedAuth ?? null)
      : undefined,
  });
  const requestIssueFingerprint = readString(params.request?.issueFingerprint);
  const existingIntent = parseRecoveryIntent(context.metadata);
  const requestedIntent = operation === 'consume_reset_credit' && requestIssueFingerprint
    ? existingIntent?.issueFingerprint === requestIssueFingerprint
      ? existingIntent
      : buildRecoveryIntentFromLatestUsageLimitIssue({
        rawSession: params.rawSession,
        issueFingerprint: requestIssueFingerprint,
      })
    : null;
  const adapterMetadata = requestedIntent
    ? {
      ...context.metadata,
      [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
        ...requestedIntent,
        issueFingerprint: requestIssueFingerprint,
        resumePromptMode,
      },
    }
    : context.metadata;

  const adapterAgentId = resolveAgentIdFromFlavor(params.request?.agentId)
    ?? inferAgentIdFromSessionMetadata(adapterMetadata);
  const adapter = await (params.resolveAdapter ?? resolveInactiveSessionUsageLimitRecoveryControls)(
    adapterAgentId,
  );
  const control = operation === 'consume_reset_credit'
    ? adapter?.consumeResetCredit
    : adapter?.checkNow;
  if (!control) {
    return stableError('session_usage_limit_recovery_control_provider_unsupported', params.sessionId);
  }

  const rateLimit = inactiveCheckNowRateLimiter.check(`${params.sessionId}\0${adapterAgentId ?? 'unknown'}\0${operation}`);
  if (!rateLimit.allowed) {
    return stableRateLimitedError(rateLimit.retryAfterMs, params.sessionId);
  }

  const result = await persistAdapterMetadataResult(
    params,
    await control(buildAdapterParams(
      params,
      adapterMetadata,
      context.sessionMachineId,
      resumePromptMode,
      requestIssueFingerprint ?? undefined,
    )),
  );
  if (
    result
    && typeof result === 'object'
    && !Array.isArray(result)
    && readOkStatus(result) === 'ready'
    && resumePromptMode !== 'off'
    && await params.resumeInactiveSessionWhenReady?.({
      sessionId: params.sessionId,
      rawSession: params.rawSession,
      metadata: readMetadataResult(result) ?? context.metadata,
    }) === true
  ) {
    return normalizeUsageLimitRecoveryOperationResult({
      ...(result as Record<string, unknown>),
      status: 'resumed',
    }, { sessionId: params.sessionId });
  }
  return normalizeUsageLimitRecoveryOperationResult(result, { sessionId: params.sessionId });
}
