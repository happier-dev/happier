import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  readSessionMetadataRuntimeDescriptor,
  type HostRuntimeControlServiceV1,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';
import type { FetchRuntimeServiceV1 } from '@happier-dev/plugin-sdk';

import { readCodexEnvironmentAuthTokens } from '../../../cli/auth/environment.js';
import { consumeCodexRateLimitResetCredit } from '../../../auth/services/quota/rateLimitResetCreditsClient.js';
import {
  buildCodexUsageLimitRecoveryProbeResult,
  resolveCodexUsageLimitRecoveryIntent,
} from '../../../auth/services/usage/limit/recovery/intent.js';
import { readCodexRuntimeRateLimitsSnapshot } from '../../../auth/services/quota/runtimeRateLimits.js';

type UsageLimitRecoveryInput<TParams> = Readonly<{
  runtimeControl: HostRuntimeControlServiceV1;
  params: TParams;
}>;

type UsageLimitRecoveryParams = Readonly<{
  sessionId?: string | null;
  cwd: string | null;
  metadata: Record<string, unknown>;
  rawSession: Readonly<{
    latestTurnStatus?: unknown;
    lastRuntimeIssue?: unknown;
  }>;
  issueFingerprint?: string | null;
  resumePromptMode?: unknown;
}>;

function stableError(errorCode: string): Readonly<{ ok: false; errorCode: string; error: string }> {
  return { ok: false, errorCode, error: errorCode };
}

function normalizeCwd(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function headersToRecord(headers: Headers | undefined): Readonly<Record<string, string>> {
  const record: Record<string, string> = {};
  if (!headers) return record;
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function toRequestBody(value: unknown): BodyInit | null | undefined {
  if (
    value === undefined
    || value === null
    || typeof value === 'string'
    || value instanceof ArrayBuffer
    || value instanceof Blob
    || value instanceof FormData
    || value instanceof URLSearchParams
    || value instanceof ReadableStream
  ) {
    return value;
  }
  return JSON.stringify(value);
}

function defaultRuntimeFetch(): FetchRuntimeServiceV1 {
  return async ({ url, method, headers, body, signal }) => {
    const response = await fetch(url, {
      method,
      headers,
      body: toRequestBody(body),
      signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      headers: headersToRecord(response.headers),
      text: async () => await response.text(),
      json: async () => await response.json(),
      arrayBuffer: async () => await response.arrayBuffer(),
    };
  };
}

function stableHash(input: string): string {
  let hash = 2_166_136_261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

function readRecoveryIssueFingerprint(params: UsageLimitRecoveryParams): string {
  if (typeof params.issueFingerprint === 'string') {
    const trimmed = params.issueFingerprint.trim();
    if (trimmed.length > 0) return trimmed;
  }
  const value = params.metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'unknown-issue';
  const fingerprint = (value as Readonly<{ issueFingerprint?: unknown }>).issueFingerprint;
  if (typeof fingerprint !== 'string') return 'unknown-issue';
  const trimmed = fingerprint.trim();
  return trimmed.length > 0 ? trimmed : 'unknown-issue';
}

function buildResetCreditIdempotencyKey(params: UsageLimitRecoveryParams): string {
  const sessionId = typeof params.sessionId === 'string' && params.sessionId.trim().length > 0
    ? params.sessionId.trim()
    : 'unknown-session';
  const raw = `session:${sessionId}:codex_reset_credit:${readRecoveryIssueFingerprint(params)}`;
  return raw.length <= 240
    ? raw
    : `session:hashed:${stableHash(raw)}:codex_reset_credit`;
}

function buildCodexAuthEnv(runtimeControl: HostRuntimeControlServiceV1): Readonly<Record<string, string | undefined>> {
  const runtimeDescriptor = readSessionMetadataRuntimeDescriptor(runtimeControl.context.metadata, 'codex');
  return {
    ...process.env,
    ...(runtimeControl.context.processEnv ?? {}),
    ...(runtimeDescriptor?.homePath ? { CODEX_HOME: runtimeDescriptor.homePath } : {}),
  };
}

function deriveTiming(issue: Readonly<{
  occurredAt?: unknown;
  usageLimit?: Readonly<{
    resetAtMs?: unknown;
    retryAfterMs?: unknown;
  }> | null;
}>): Readonly<{
  nextCheckAtMs: number | null;
  resetAtMs: number | null;
}> {
  const occurredAtMs = typeof issue.occurredAt === 'number' && Number.isFinite(issue.occurredAt)
    ? Math.trunc(issue.occurredAt)
    : Date.now();
  const resetAtMs = typeof issue.usageLimit?.resetAtMs === 'number' && Number.isFinite(issue.usageLimit.resetAtMs)
    ? Math.trunc(issue.usageLimit.resetAtMs)
    : null;
  const retryAfterMs = typeof issue.usageLimit?.retryAfterMs === 'number' && Number.isFinite(issue.usageLimit.retryAfterMs)
    ? Math.max(0, Math.trunc(issue.usageLimit.retryAfterMs))
    : null;
  return {
    resetAtMs,
    nextCheckAtMs: resetAtMs ?? (retryAfterMs !== null ? occurredAtMs + retryAfterMs : null),
  };
}

function resolveMaxAttemptsExhaustion(intent: ReturnType<typeof resolveCodexUsageLimitRecoveryIntent>) {
  if (!intent) return null;
  if (intent.maxAttempts <= 0 || intent.attemptCount < intent.maxAttempts) return null;
  return {
    ...intent,
    status: 'exhausted',
    attemptCount: intent.attemptCount + 1,
    lastProbeError: intent.lastProbeError ?? 'usage_limit_recovery_max_attempts_exhausted',
  };
}

export async function checkCodexUsageLimitRecoveryNow(
  input: UsageLimitRecoveryInput<UsageLimitRecoveryParams>,
): Promise<unknown> {
  const intent = resolveCodexUsageLimitRecoveryIntent({
    metadata: input.params.metadata,
    latestTurnStatus: input.params.rawSession.latestTurnStatus,
    lastRuntimeIssue: input.params.rawSession.lastRuntimeIssue,
    resumePromptMode: input.params.resumePromptMode,
    deriveTiming,
  });
  if (!intent) {
    return stableError('session_usage_limit_recovery_control_inactive');
  }

  // A persisted intent may only arm a resume while the session's latest turn is
  // still interrupted. A turn that later completed (or was cancelled) normally
  // supersedes the intent: cancel it instead of probing, so a stale intent never
  // fires an involuntary resume into a session that already moved on. Unknown
  // turn status keeps the intent (no evidence either way).
  if (
    (intent.status === 'waiting' || intent.status === 'armed' || intent.status === 'checking')
    && input.params.rawSession.latestTurnStatus != null
    && input.params.rawSession.latestTurnStatus !== 'failed'
  ) {
    const errorCode = 'session_usage_limit_recovery_control_superseded_by_turn_completion';
    return {
      ok: false,
      errorCode,
      error: errorCode,
      metadata: {
        ...input.params.metadata,
        [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
          ...intent,
          status: 'cancelled',
        },
      },
    };
  }

  const exhaustedIntent = resolveMaxAttemptsExhaustion(intent);
  if (exhaustedIntent) {
    return {
      ok: true,
      status: 'waiting',
      metadata: {
        ...input.params.metadata,
        [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: exhaustedIntent,
      },
    };
  }

  const cwd = normalizeCwd(input.params.cwd);
  if (!cwd) return stableError('session_usage_limit_recovery_control_cwd_unavailable');

  const { rawSnapshot } = await readCodexRuntimeRateLimitsSnapshot({
    request: async (_method, params) => {
      const result = await input.runtimeControl.appServer.request({
        method: 'account/rateLimits/read',
        params,
      });
      if (!result.ok) throw new Error(result.error);
      return result.value;
    },
  });

  const probeResult = buildCodexUsageLimitRecoveryProbeResult({
    intent,
    rawSnapshot,
  });
  return {
    ok: true,
    status: probeResult.status,
    metadata: {
      ...input.params.metadata,
      [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: probeResult.intent,
    },
  };
}

export async function consumeCodexUsageLimitResetCredit(
  input: UsageLimitRecoveryInput<UsageLimitRecoveryParams>,
): Promise<unknown> {
  const authTokens = readCodexEnvironmentAuthTokens(buildCodexAuthEnv(input.runtimeControl));
  const accessToken = authTokens.accessToken ?? authTokens.idToken;
  if (!accessToken) {
    return stableError('codex_reset_credit_native_auth_unavailable');
  }

  try {
    await consumeCodexRateLimitResetCredit({
      accessToken,
      accountId: authTokens.accountId,
      idempotencyKey: buildResetCreditIdempotencyKey(input.params),
      runtimeFetch: defaultRuntimeFetch(),
    });
  } catch {
    return stableError('codex_reset_credit_consume_failed');
  }

  return await checkCodexUsageLimitRecoveryNow(input);
}
