import {
  resolveAgentIdFromFlavor,
  resolveAgentIdFromSessionMetadata,
} from '@happier-dev/agents';
import { writeSessionStateFieldToMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY, SessionUsageLimitRecoveryV1Schema, readSessionUsageLimitRecoveryForIssue } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { SessionRuntimeIssueV1Schema } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';
import type { SessionUsageLimitRecoveryResumePromptModeV1, SessionUsageLimitRecoveryV1, SessionMetadata, SessionRuntimeIssueV1 } from '@happier-dev/protocol';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

import { resolveInactiveSessionUsageLimitRecoveryControls } from './catalogHooks';
import type { StoredCredentials } from '@/persistence';
import {
  resolveMachineControlLocalityProof,
  resolveSessionMachineWorkspacePath,
} from '@/session/machineControlLocality';
import type { SessionStoredContentCryptoContext } from '@/session/transport/encryption/sessionEncryptionContext';
import type { RawSessionRecord } from '@/session/transport/http/sessionsHttp';
import type {
  ResolveSessionUsageLimitRecoveryControlAdapter,
  SessionUsageLimitRecoveryControlAdapterParams,
} from './sessionUsageLimitRecoveryControlTypes';
import { buildUsageLimitIssueFingerprint } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import { readLatestUsageLimitFailureIssue } from './readLatestUsageLimitFailureIssue';
import { buildRecoveryIntentFromLatestUsageLimitIssue } from './buildUsageLimitRecoveryIntent';
export { buildRecoveryIntentFromLatestUsageLimitIssue, buildRecoveryIntentFromUsageLimitIssue } from './buildUsageLimitRecoveryIntent';
import {
  buildUsageLimitRecoveryOperationError,
  buildUsageLimitRecoveryOperationSuccess,
  normalizeUsageLimitRecoveryOperationResult,
} from './sessionUsageLimitRecoveryOperationResult';
import {
  persistUsageLimitRecoveryFieldDurably,
  type StageUsageLimitRecoveryMutation,
} from './persistUsageLimitRecoveryFieldDurably';
import { resolveRoutedUsageLimitRecoveryResumePromptMode } from './resolveRoutedUsageLimitRecoveryResumePromptMode';
import { hasSameUsageLimitRecoveryIdentity } from './mergeUsageLimitRecoveryIntent';
import { createBackoffSessionUsageLimitRecoveryControlAdapter } from './createBackoffSessionUsageLimitRecoveryControlAdapter';
import type { UsageLimitContinuationResult } from '@/daemon/connectedServices/continuation/continueSessionAfterUsageLimitReset';
import { readRuntimeAuthUsageLimitRecoveryAttemptId, routeRuntimeAuthUsageLimitRecoveryCheckNow, type CheckRuntimeAuthUsageLimitRecovery } from './runtimeAuthUsageLimitRecoveryControl';

type RouteSessionUsageLimitRecoveryControlParams = Readonly<{
  token: string;
  credentials?: StoredCredentials;
  sessionId: string;
  rawSession: RawSessionRecord;
  metadata: Record<string, unknown> | null;
  currentMachineId: string | null;
  currentMachineHost?: string | null;
  currentMachineHomeDir?: string | null;
  callLiveSessionRpc: () => Promise<unknown>;
  checkRuntimeAuthUsageLimitRecovery?: CheckRuntimeAuthUsageLimitRecovery;
  /** The live Session leaves the routed result for its scheduler to settle. */
  stageUsageLimitRecoveryMutation?: StageUsageLimitRecoveryMutation;
  resolveAdapter?: ResolveSessionUsageLimitRecoveryControlAdapter;
  readTemporaryThrottleRecovery?: (sessionId: string) => Readonly<{ issueFingerprint: string; armedAtMs: number }> | null;
  cancelTemporaryThrottleRecovery?: (input: Readonly<{ sessionId: string; issueFingerprint?: string; armedAtMs?: number }>) => Promise<unknown> | unknown;
  retryTemporaryThrottleNow?: (input: Readonly<{
    sessionId: string;
  }>) => Promise<unknown> | unknown;
  resumeInactiveSessionWhenReady?: (input: Readonly<{
    sessionId: string;
    rawSession: RawSessionRecord;
    metadata: Record<string, unknown>;
    readiness?: 'provider_ready';
  }>) => Promise<boolean | UsageLimitContinuationResult>;
  /**
   * Reads the current record from the recovery lifecycle owner (the daemon's inactive
   * usage-limit recovery scheduler store). A readiness probe is a long network round trip,
   * so the attempt it started under can be cancelled, exhausted or replaced while it runs:
   * the route rechecks this immediately before every durable mutation and spawn effect so a
   * terminal decision cannot be undone by a probe that is already stale.
   */
  readCurrentUsageLimitRecovery?: (input: Readonly<{ sessionId: string }>) =>
    | SessionUsageLimitRecoveryV1
    | null
    | Promise<SessionUsageLimitRecoveryV1 | null>;
  resumePromptTierSources?: Readonly<{
    accountSettings?: unknown;
    loadGroupPolicy?: (selectedAuth: SessionUsageLimitRecoveryV1['selectedAuth'] | null) => Promise<unknown> | unknown;
  }>;
}> & SessionStoredContentCryptoContext;

type RouteSessionUsageLimitRecoveryWaitResumeEnableParams =
  RouteSessionUsageLimitRecoveryControlParams & Readonly<{
    stageUsageLimitRecoveryMutation: StageUsageLimitRecoveryMutation;
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
    stageUsageLimitRecoveryMutation: StageUsageLimitRecoveryMutation;
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

function shouldFallbackFromLiveSessionUsageLimitRpc(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const raw = result as Record<string, unknown>;
  const errorCode = typeof raw.errorCode === 'string' ? raw.errorCode : '';
  const error = typeof raw.error === 'string' ? raw.error : '';
  return errorCode === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
    || errorCode === RPC_ERROR_CODES.METHOD_NOT_FOUND
    || errorCode === 'unsupported_session_runtime_method'
    || error === RPC_ERROR_CODES.METHOD_NOT_AVAILABLE
    || error === RPC_ERROR_CODES.METHOD_NOT_FOUND
    || error === 'unsupported_session_runtime_method';
}

function buildAdapterParams(
  params: RouteSessionUsageLimitRecoveryControlParams,
  metadata: Record<string, unknown>,
  sessionMachineId: string,
  resumePromptMode?: SessionUsageLimitRecoveryResumePromptModeV1,
  issueFingerprint?: string,
): SessionUsageLimitRecoveryControlAdapterParams {
  const base = {
    token: params.token,
    ...(params.credentials ? { credentials: params.credentials } : {}),
    sessionId: params.sessionId,
    rawSession: params.rawSession,
    metadata,
    currentMachineId: params.currentMachineId,
    sessionMachineId,
    cwd: resolveSessionMachineWorkspacePath({
      metadata,
      currentMachineId: params.currentMachineId,
      candidatePath: resolveRawSessionString(params.rawSession, 'path') ?? readString(metadata.path),
    }),
    ...(issueFingerprint ? { issueFingerprint } : {}),
    ...(resumePromptMode ? { resumePromptMode } : {}),
  } as const;
  return params.mode === 'plain'
    ? { ...base, mode: params.mode, ctx: params.ctx }
    : { ...base, mode: params.mode, ctx: params.ctx };
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

async function applyAdapterMetadataResult(
  params: RouteSessionUsageLimitRecoveryControlParams,
  result: unknown,
): Promise<unknown> {
  const nextMetadata = readMetadataResult(result);
  const usageLimitRecovery = nextMetadata ? readUsageLimitRecoveryMetadataValue(nextMetadata) : null;
  if (!usageLimitRecovery || !params.credentials) return result;
  const metadata = await applyUsageLimitRecoveryMetadata(params, currentMetadata => writeSessionStateFieldToMetadata(
    currentMetadata as SessionMetadata,
    'runtime.usageLimitRecovery',
    usageLimitRecovery,
  ) as Record<string, unknown>);
  return { ...(result as Record<string, unknown>), metadata };
}

/**
 * Fences an in-flight recovery effect against the current lifecycle record. Returns the
 * terminal outcome to report when the attempt the effect belongs to is no longer the current
 * one, or `null` when the effect may proceed.
 */
async function resolveSupersededUsageLimitRecoveryEffect(
  params: RouteSessionUsageLimitRecoveryControlParams,
  intended: SessionUsageLimitRecoveryV1 | null,
): Promise<ReturnType<typeof buildUsageLimitRecoveryOperationError> | null> {
  if (!intended || !params.readCurrentUsageLimitRecovery) return null;
  const current = await params.readCurrentUsageLimitRecovery({ sessionId: params.sessionId });
  if (!current) return null;
  if (!hasSameUsageLimitRecoveryIdentity(current, intended)) {
    return buildUsageLimitRecoveryOperationError({
      errorCode: 'session_usage_limit_recovery_control_issue_mismatch',
      status: 'inactive',
      sessionId: params.sessionId,
    });
  }
  if (current.status !== 'cancelled' && current.status !== 'exhausted') return null;
  return buildUsageLimitRecoveryOperationError({
    errorCode: 'session_usage_limit_recovery_control_inactive',
    status: current.status,
    sessionId: params.sessionId,
  });
}

function parseRecoveryIntent(metadata: Record<string, unknown>, rawSession?: RawSessionRecord): SessionUsageLimitRecoveryV1 | null {
  return readSessionUsageLimitRecoveryForIssue(
    metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY],
    rawSession ? readLatestUsageLimitFailureIssue(rawSession) : null,
  );
}

function isRetryableTemporaryThrottleIssue(rawSession: RawSessionRecord): boolean {
  const issueParsed = SessionRuntimeIssueV1Schema.safeParse(rawSession.lastRuntimeIssue);
  return issueParsed.success
    && issueParsed.data.temporaryThrottle?.v === 1
    && issueParsed.data.temporaryThrottle.recoverability === 'retry';
}

async function buildEnabledRecoveryIntent(
  params: RouteSessionUsageLimitRecoveryWaitResumeEnableParams,
  metadata: Record<string, unknown>,
): Promise<SessionUsageLimitRecoveryV1 | null> {
  const existing = parseRecoveryIntent(metadata, params.rawSession);
  const issueFingerprint =
    typeof params.request.issueFingerprint === 'string' && params.request.issueFingerprint.trim().length > 0
      ? params.request.issueFingerprint.trim()
      : undefined;
  const base = existing ?? buildRecoveryIntentFromLatestUsageLimitIssue({
    rawSession: params.rawSession,
    connectedServices: metadata.connectedServices ?? null,
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

async function applyUsageLimitRecoveryMetadata(
  params: RouteSessionUsageLimitRecoveryControlParams,
  updater: (metadata: Record<string, unknown>) => Record<string, unknown>,
  mode: 'converge' | 'rearm' | 'explicit_rearm' | 'cancel' = 'converge',
): Promise<Record<string, unknown> | null> {
  if (!params.credentials) return null;
  const currentMetadata = params.metadata ?? {};
  const nextMetadata = updater(currentMetadata);
  if (!params.stageUsageLimitRecoveryMutation) return nextMetadata;
  return await persistUsageLimitRecoveryFieldDurably({
    sessionId: params.sessionId,
    currentMetadata,
    nextMetadata,
    mode,
    stageUsageLimitRecoveryMutation: params.stageUsageLimitRecoveryMutation,
  });
}

async function ensureLocalInactiveControlContext(
  params: RouteSessionUsageLimitRecoveryControlParams,
): Promise<Readonly<
  | { ok: true; metadata: Record<string, unknown>; sessionMachineId: string }
  | { ok: false; result: ReturnType<typeof normalizeUsageLimitRecoveryOperationResult> }
>> {
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
  if (isRetryableTemporaryThrottleIssue(params.rawSession) || parseRecoveryIntent(params.metadata ?? {}, params.rawSession)?.issueFingerprint.startsWith('temporary-throttle:')) {
    return await routeSessionUsageLimitRecoveryCheckNow({ ...params, request: { sessionId: params.sessionId } });
  }
  if (params.rawSession.active === true) {
    const liveResult = normalizeUsageLimitRecoveryOperationResult(await params.callLiveSessionRpc(), {
      sessionId: params.sessionId,
    });
    if (!shouldFallbackFromLiveSessionUsageLimitRpc(liveResult)) {
      return liveResult;
    }
  }

  const context = await ensureLocalInactiveControlContext(params);
  if (!context.ok) return context.result;

  const nextIntent = await buildEnabledRecoveryIntent(params, context.metadata);
  if (!nextIntent) return stableError('session_usage_limit_recovery_control_inactive', params.sessionId);

  const persistedMetadata = await applyUsageLimitRecoveryMetadata(params, (currentMetadata) => ({
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
  if (params.request.issueFingerprint?.startsWith('temporary-throttle:') || isRetryableTemporaryThrottleIssue(params.rawSession)) {
    const context = await ensureLocalInactiveControlContext(params);
    if (!context.ok) return context.result;
    const recovery = params.readTemporaryThrottleRecovery?.(params.sessionId);
    if (!recovery || !params.cancelTemporaryThrottleRecovery) {
      return stableError('session_usage_limit_recovery_control_inactive', params.sessionId);
    }
    const fingerprint = recovery.issueFingerprint.startsWith('temporary-throttle:')
      ? recovery.issueFingerprint : `temporary-throttle:${recovery.issueFingerprint}`;
    if (params.request.issueFingerprint !== fingerprint || params.request.armedAtMs !== recovery.armedAtMs) {
      return stableError('session_usage_limit_recovery_control_issue_mismatch', params.sessionId);
    }
    const cancelled = await params.cancelTemporaryThrottleRecovery({
      sessionId: params.sessionId, issueFingerprint: recovery.issueFingerprint, armedAtMs: recovery.armedAtMs,
    });
    if (!cancelled) return stableError('session_usage_limit_recovery_control_inactive', params.sessionId);
    return buildUsageLimitRecoveryOperationSuccess({ sessionId: params.sessionId, status: 'cancelled' });
  }
  if (params.rawSession.active === true) {
    const liveResult = normalizeUsageLimitRecoveryOperationResult(await params.callLiveSessionRpc(), {
      sessionId: params.sessionId,
    });
    if (!shouldFallbackFromLiveSessionUsageLimitRpc(liveResult)) {
      return liveResult;
    }
  }

  const context = await ensureLocalInactiveControlContext(params);
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

  const persistedMetadata = await applyUsageLimitRecoveryMetadata(params, (currentMetadata) => ({
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

  const currentIssue = readLatestUsageLimitFailureIssue(params.rawSession);
  if (operation === 'check_now' && readRuntimeAuthUsageLimitRecoveryAttemptId(params.metadata, currentIssue)) {
    const context = await ensureLocalInactiveControlContext(params);
    if (!context.ok) return context.result;
    return await routeRuntimeAuthUsageLimitRecoveryCheckNow({
      sessionId: params.sessionId, metadata: context.metadata, currentIssue,
      resumePromptMode: params.request?.resumePromptMode,
      checkRuntimeAuthUsageLimitRecovery: params.checkRuntimeAuthUsageLimitRecovery,
    });
  }

  if (isRetryableTemporaryThrottleIssue(params.rawSession) || parseRecoveryIntent(params.metadata ?? {}, params.rawSession)?.issueFingerprint.startsWith('temporary-throttle:')) {
    const context = await ensureLocalInactiveControlContext(params);
    if (!context.ok) return context.result;
    if (operation !== 'check_now' || !params.retryTemporaryThrottleNow) {
      return stableError('session_usage_limit_recovery_control_inactive', params.sessionId);
    }
    return normalizeUsageLimitRecoveryOperationResult(
      await params.retryTemporaryThrottleNow({ sessionId: params.sessionId }),
      { sessionId: params.sessionId },
    );
  }

  let liveProbeResult: unknown;
  if (operation === 'check_now' && params.rawSession.active === true) {
    const nativeResult = await params.callLiveSessionRpc();
    const liveResult = normalizeUsageLimitRecoveryOperationResult(nativeResult, { sessionId: params.sessionId });
    if (!shouldFallbackFromLiveSessionUsageLimitRpc(liveResult)) {
      // A native control reports quota evidence. The host still owns continuation.
      if (liveResult.ok && (liveResult.status === 'ready'
        || (liveResult.status === 'waiting' && readOkStatus(nativeResult) === null))) {
        liveProbeResult = liveResult;
      } else {
        return liveResult;
      }
    }
  }

  const context = await ensureLocalInactiveControlContext(params);
  if (!context.ok) return context.result;
  const existingPromptIntent = parseRecoveryIntent(context.metadata, params.rawSession);
  const resumePromptMode = await resolveRoutedUsageLimitRecoveryResumePromptMode({
    explicit: params.request?.resumePromptMode,
    existingIntent: existingPromptIntent,
    accountSettings: params.resumePromptTierSources?.accountSettings,
    loadGroupPolicy: params.resumePromptTierSources?.loadGroupPolicy
      ? () => params.resumePromptTierSources!.loadGroupPolicy!(existingPromptIntent?.selectedAuth ?? null)
      : undefined,
  });
  const requestIssueFingerprint = readString(params.request?.issueFingerprint);
  const existingIntent = parseRecoveryIntent(context.metadata, params.rawSession);
  const requestedIntent = operation === 'consume_reset_credit' && requestIssueFingerprint
    ? existingIntent?.issueFingerprint === requestIssueFingerprint
      ? existingIntent
      : buildRecoveryIntentFromLatestUsageLimitIssue({
        rawSession: params.rawSession,
        connectedServices: context.metadata.connectedServices ?? null,
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
    ?? resolveAgentIdFromSessionMetadata(adapterMetadata);
  const adapter = liveProbeResult ? null : await (params.resolveAdapter ?? resolveInactiveSessionUsageLimitRecoveryControls)(adapterAgentId);
  const recovery = parseRecoveryIntent(adapterMetadata, params.rawSession);
  const dueAtMs = recovery?.nextCheckAtMs;
  const timedAdapter = operation === 'check_now' && (!adapter?.checkNow
    || (typeof dueAtMs === 'number' && dueAtMs <= Date.now()))
    ? createBackoffSessionUsageLimitRecoveryControlAdapter({
      providerId: adapterAgentId ?? readLatestUsageLimitFailureIssue(params.rawSession)?.agentId ?? 'unknown',
    }) : null;
  const control = operation === 'consume_reset_credit'
    ? adapter?.consumeResetCredit
    : timedAdapter?.checkNow ?? adapter?.checkNow;
  if (!liveProbeResult && !control) {
    return stableError('session_usage_limit_recovery_control_provider_unsupported', params.sessionId);
  }
  const intendedIntent = parseRecoveryIntent(adapterMetadata);
  const probeResult = liveProbeResult ?? await control!(buildAdapterParams(
    params, adapterMetadata, context.sessionMachineId, resumePromptMode, requestIssueFingerprint ?? undefined,
  ));
  const supersededBeforePersist = await resolveSupersededUsageLimitRecoveryEffect(params, intendedIntent);
  if (supersededBeforePersist) return supersededBeforePersist;

  // Normalize the plugin boundary before inspecting status or applying effects.
  const normalizedProbe = normalizeUsageLimitRecoveryOperationResult(probeResult, { sessionId: params.sessionId });
  const probeMetadata = readMetadataResult(probeResult) ?? adapterMetadata;
  const probeRecovery = parseRecoveryIntent(probeMetadata) ?? intendedIntent
    ?? buildRecoveryIntentFromLatestUsageLimitIssue({ rawSession: params.rawSession,
      connectedServices: probeMetadata.connectedServices, resumePromptMode });
  const retryAfterMs = normalizedProbe.ok && 'retryAfterMs' in normalizedProbe
    && typeof normalizedProbe.retryAfterMs === 'number' && Number.isFinite(normalizedProbe.retryAfterMs)
    && normalizedProbe.retryAfterMs >= 0 ? normalizedProbe.retryAfterMs : null;
  const preparedResult = normalizedProbe.ok && probeRecovery
    && (normalizedProbe.status === 'ready' || normalizedProbe.status === 'waiting')
    ? { ...normalizedProbe, metadata: { ...probeMetadata,
      [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: { ...probeRecovery, resumePromptMode,
        status: normalizedProbe.status === 'ready' && resumePromptMode === 'off' ? 'paused' : 'waiting',
        resetAtMs: normalizedProbe.status === 'waiting' && retryAfterMs !== null && probeRecovery.resetAtMs === null
          ? Date.now() + retryAfterMs : probeRecovery.resetAtMs,
        nextCheckAtMs: normalizedProbe.status === 'ready'
          ? resumePromptMode === 'off' ? null : Date.now()
          : retryAfterMs !== null ? Date.now() + retryAfterMs
            : probeRecovery.nextCheckAtMs,
      } } }
    : { ...normalizedProbe, ...(readMetadataResult(probeResult) ? { metadata: readMetadataResult(probeResult) } : {}) };
  const result = await applyAdapterMetadataResult(params, preparedResult);
  const resultMetadata = readMetadataResult(result);
  const normalizedResult = normalizeUsageLimitRecoveryOperationResult(result, { sessionId: params.sessionId });
  if (normalizedResult.ok && normalizedResult.status === 'ready' && resumePromptMode !== 'off'
    && params.resumeInactiveSessionWhenReady) {
    const supersededBeforeResume = await resolveSupersededUsageLimitRecoveryEffect(params, intendedIntent);
    if (supersededBeforeResume) return supersededBeforeResume;
    const resumed = await params.resumeInactiveSessionWhenReady({ sessionId: params.sessionId,
      rawSession: params.rawSession, metadata: resultMetadata ?? context.metadata,
      ...(!timedAdapter || liveProbeResult ? { readiness: 'provider_ready' as const } : {}) });
    const continuationStatus = typeof resumed === 'boolean'
      ? resumed ? 'continued' : 'runtime_unavailable' : resumed.status;
    if (continuationStatus === 'continued' || continuationStatus === 'suppressed' || continuationStatus === 'superseded') {
      const settledMetadata = await applyUsageLimitRecoveryMetadata(params, currentMetadata => {
        const currentRecovery = parseRecoveryIntent(currentMetadata) ?? (resultMetadata ? parseRecoveryIntent(resultMetadata) : null);
        return !currentRecovery ? currentMetadata : { ...currentMetadata,
          [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: { ...currentRecovery, status: 'cancelled', nextCheckAtMs: null } };
      });
      return { ...normalizedResult, status: continuationStatus === 'continued' ? 'resumed' : 'cancelled',
        metadata: settledMetadata ?? resultMetadata };
    }
    if (continuationStatus === 'disabled') return result;
    const retryMetadata = await applyUsageLimitRecoveryMetadata(params, currentMetadata => {
      const current = parseRecoveryIntent(currentMetadata);
      return !current || current.status === 'cancelled' || current.status === 'exhausted' ? currentMetadata : {
        ...currentMetadata, [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: { ...current, status: 'waiting',
          nextCheckAtMs: null,
          lastProbeError: 'session_usage_limit_recovery_resume_failed' } };
    });
    return { ...stableError('session_usage_limit_recovery_resume_failed', params.sessionId), metadata: retryMetadata };
  }
  return result;
}
