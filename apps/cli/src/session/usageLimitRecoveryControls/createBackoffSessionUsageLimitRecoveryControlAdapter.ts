import { SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY, readSessionUsageLimitRecoveryForIssue } from '@happier-dev/protocol/sessions/state/valueSchemas/usageLimitRecovery';
import type { SessionRuntimeIssueV1, SessionUsageLimitRecoveryV1 } from '@happier-dev/protocol';

import { buildRecoveryIntentFromUsageLimitIssue } from './buildUsageLimitRecoveryIntent';
import { resolveUsageLimitRecoverySelectedAuthFromIssue } from './usageLimitRecoverySelectedAuth';
import { readLatestUsageLimitFailureIssue } from './readLatestUsageLimitFailureIssue';
import type {
  SessionUsageLimitRecoveryBackoffPolicy,
  SessionUsageLimitRecoveryControlAdapter,
  SessionUsageLimitRecoveryControlAdapterParams,
  SessionUsageLimitRecoveryReadinessProbeResult,
} from './sessionUsageLimitRecoveryControlTypes';

type MetadataRecord = Record<string, unknown>;

type BackoffUsageLimitRecoveryControlResult =
  | Readonly<{ ok: true; status: 'ready' | 'waiting'; metadata: MetadataRecord }>
  | Readonly<{ ok: false; errorCode: string; error: string; metadata?: MetadataRecord }>;

const USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS_EXHAUSTED_ERROR =
  'usage_limit_recovery_max_attempts_exhausted' as const;

export const USAGE_LIMIT_RECOVERY_SUPERSEDED_BY_TURN_COMPLETION_ERROR =
  'session_usage_limit_recovery_control_superseded_by_turn_completion' as const;

function stableError(errorCode: string): Readonly<{ ok: false; errorCode: string; error: string }> {
  return { ok: false, errorCode, error: errorCode };
}

function isPendingRecoveryIntentStatus(status: SessionUsageLimitRecoveryV1['status']): boolean {
  return status === 'waiting' || status === 'armed' || status === 'checking';
}

function normalizePersistedNativeSelection(
  intent: SessionUsageLimitRecoveryV1 | null,
  issue: SessionRuntimeIssueV1 | null,
  metadata: MetadataRecord,
): SessionUsageLimitRecoveryV1 | null {
  if (!intent || !issue || intent.runtimeAuthRecoveryAttemptId
    || (!isPendingRecoveryIntentStatus(intent.status) && intent.status !== 'paused')
    || intent.selectedAuth.kind !== 'profile'
    || intent.selectedAuth.profileId !== issue.usageLimit?.connectedService?.profileId) return intent;
  const selectedAuth = resolveUsageLimitRecoverySelectedAuthFromIssue({
    issue,
    requiredConnectedServiceId: intent.selectedAuth.serviceId,
    connectedServices: metadata.connectedServices ?? null,
  });
  return selectedAuth?.kind === 'native' ? { ...intent, selectedAuth } : intent;
}

/**
 * A persisted intent may only arm a resume when the session's latest turn is
 * still interrupted. A turn that later completed (or was cancelled) normally
 * supersedes the intent — re-arming it would spawn an involuntary resume into
 * a session that already moved on. Unknown turn status keeps the intent
 * (no evidence either way), matching readLatestUsageLimitIssue's convention.
 */
function isPersistedIntentSupersededByTurnCompletion(input: Readonly<{
  intent: SessionUsageLimitRecoveryV1 | null;
  latestTurnStatus: SessionUsageLimitRecoveryControlAdapterParams['rawSession']['latestTurnStatus'];
}>): boolean {
  if (!input.intent || !isPendingRecoveryIntentStatus(input.intent.status)) return false;
  return input.latestTurnStatus != null && input.latestTurnStatus !== 'failed';
}

function readLatestUsageLimitIssue(input: Readonly<{
  params: SessionUsageLimitRecoveryControlAdapterParams;
  issueProviderFilter?: string | null;
}>): SessionRuntimeIssueV1 | null {
  const issue = readLatestUsageLimitFailureIssue(input.params.rawSession);
  if (!issue || (input.issueProviderFilter && issue.agentId !== input.issueProviderFilter)) {
    return null;
  }
  return issue;
}

function buildNextIntent(params: Readonly<{
  intent: SessionUsageLimitRecoveryV1;
  nowMs: number;
}>): Readonly<{
  adapterStatus: 'ready' | 'waiting';
  intent: SessionUsageLimitRecoveryV1;
}> {
  const nextCheckAtMs = params.intent.nextCheckAtMs;
  const baseIntent: SessionUsageLimitRecoveryV1 = {
    ...params.intent,
    nextCheckAtMs,
  };

  if (baseIntent.maxAttempts > 0 && baseIntent.attemptCount >= baseIntent.maxAttempts) {
    return {
      adapterStatus: 'waiting',
      intent: {
        ...baseIntent,
        status: 'exhausted',
        lastProbeError: baseIntent.lastProbeError ?? USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS_EXHAUSTED_ERROR,
      },
    };
  }

  if (nextCheckAtMs !== null && params.nowMs >= nextCheckAtMs) {
    return {
      adapterStatus: 'ready',
      intent: {
        ...baseIntent,
        status: 'paused',
        nextCheckAtMs: null,
        lastProbeError: null,
      },
    };
  }

  return {
    adapterStatus: 'waiting',
    intent: {
      ...baseIntent,
      status: 'waiting',
      lastProbeError: null,
    },
  };
}

export function createBackoffSessionUsageLimitRecoveryControlAdapter(options: SessionUsageLimitRecoveryBackoffPolicy & Readonly<{
  nowMs?: () => number;
  readinessProbe?: (
    params: SessionUsageLimitRecoveryControlAdapterParams,
  ) => Promise<SessionUsageLimitRecoveryReadinessProbeResult>;
}>): SessionUsageLimitRecoveryControlAdapter {
  const nowMs = options.nowMs ?? (() => Date.now());

  return {
    checkNow: async (params): Promise<BackoffUsageLimitRecoveryControlResult> => {
      const now = nowMs();
      const latestIssue = readLatestUsageLimitIssue({
        params,
        issueProviderFilter: options.issueProviderFilter ?? null,
      });
      const persistedIntent = normalizePersistedNativeSelection(readSessionUsageLimitRecoveryForIssue(
        params.metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY], latestIssue, options.providerId,
      ), latestIssue, params.metadata);
      if (isPersistedIntentSupersededByTurnCompletion({
        intent: persistedIntent,
        latestTurnStatus: params.rawSession.latestTurnStatus,
      }) && persistedIntent) {
        return {
          ok: false,
          errorCode: USAGE_LIMIT_RECOVERY_SUPERSEDED_BY_TURN_COMPLETION_ERROR,
          error: USAGE_LIMIT_RECOVERY_SUPERSEDED_BY_TURN_COMPLETION_ERROR,
          metadata: {
            ...params.metadata,
            [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: {
              ...persistedIntent,
              status: 'cancelled',
            } satisfies SessionUsageLimitRecoveryV1,
          },
        };
      }
      const intent = persistedIntent && persistedIntent.status !== 'cancelled'
        ? persistedIntent
        : latestIssue
          ? buildRecoveryIntentFromUsageLimitIssue({
            issue: latestIssue,
            providerId: options.providerId,
            defaultNativeServiceId: options.defaultNativeServiceId ?? null,
            connectedServices: params.metadata.connectedServices ?? null,
          })
          : null;
      if (!intent) {
        return stableError('session_usage_limit_recovery_control_inactive');
      }

      let next = buildNextIntent({
        intent,
        nowMs: now,
      });
      if (next.intent.status !== 'exhausted' && options.readinessProbe
        && (next.adapterStatus === 'ready' || next.intent.nextCheckAtMs === null)) {
        let probe: SessionUsageLimitRecoveryReadinessProbeResult;
        try {
          probe = await options.readinessProbe(params);
        } catch {
          probe = {
            status: 'unavailable',
            errorCode: 'usage_limit_recovery_readiness_probe_failed',
          };
        }
        if (probe.status === 'ready') {
          next = { adapterStatus: 'ready', intent: { ...next.intent, status: 'paused', nextCheckAtMs: null, lastProbeError: null } };
        } else {
          const requestedRetryAfterMs = probe.status === 'waiting'
            ? probe.retryAfterMs
            : undefined;
          const retryAfterMs = typeof requestedRetryAfterMs === 'number'
            && Number.isFinite(requestedRetryAfterMs)
            && requestedRetryAfterMs >= 0
            ? Math.trunc(requestedRetryAfterMs)
            : null;
          next = {
            adapterStatus: 'waiting',
            intent: {
              ...next.intent,
              status: 'waiting',
              nextCheckAtMs: retryAfterMs === null ? null : now + retryAfterMs,
              lastProbeError: probe.status === 'unavailable'
                ? probe.errorCode
                : null,
            },
          };
        }
      }

      return {
        ok: true,
        status: next.adapterStatus,
        metadata: {
          ...params.metadata,
          [SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]: next.intent,
        },
      };
    },
  };
}
