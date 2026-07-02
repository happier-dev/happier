import type { HostRuntimeControlServiceV1 } from '@happier-dev/agents';
import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY } from '@happier-dev/protocol';

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
  cwd: string | null;
  metadata: Record<string, unknown>;
  rawSession: Readonly<{
    latestTurnStatus?: unknown;
    lastRuntimeIssue?: unknown;
  }>;
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
