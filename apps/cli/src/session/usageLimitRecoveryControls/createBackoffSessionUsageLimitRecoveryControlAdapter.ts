import {
  SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY,
  ConnectedServiceIdSchema,
  SessionRuntimeIssueV1Schema,
  SessionUsageLimitRecoveryV1Schema,
  type ConnectedServiceId,
  type SessionRuntimeIssueV1,
  type SessionUsageLimitRecoveryV1,
} from '@happier-dev/protocol';

import { deriveUsageLimitRecoveryTiming } from './deriveUsageLimitRecoveryTiming';
import type {
  SessionUsageLimitRecoveryControlAdapter,
  SessionUsageLimitRecoveryControlAdapterParams,
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

function readNonNegativeIntegerFromEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  defaultValue: number,
): number {
  const raw = typeof env[key] === 'string' ? env[key]?.trim() : '';
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : defaultValue;
}

function readRecoveryIntent(metadata: MetadataRecord): SessionUsageLimitRecoveryV1 | null {
  const parsed = SessionUsageLimitRecoveryV1Schema.safeParse(metadata[SESSION_USAGE_LIMIT_RECOVERY_METADATA_KEY]);
  return parsed.success ? parsed.data : null;
}

function isPendingRecoveryIntentStatus(status: SessionUsageLimitRecoveryV1['status']): boolean {
  return status === 'waiting' || status === 'armed' || status === 'checking';
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
  if (input.params.rawSession.latestTurnStatus != null && input.params.rawSession.latestTurnStatus !== 'failed') {
    return null;
  }

  const parsed = SessionRuntimeIssueV1Schema.safeParse(input.params.rawSession.lastRuntimeIssue);
  if (!parsed.success || parsed.data.source !== 'usage_limit' || !parsed.data.usageLimit) {
    return null;
  }
  if (input.issueProviderFilter && parsed.data.provider !== input.issueProviderFilter) {
    return null;
  }
  return parsed.data;
}

function buildUsageLimitIssueFingerprint(input: Readonly<{
  issue: SessionRuntimeIssueV1;
  providerId: string;
}>): string {
  return [
    'usage-limit',
    input.issue.provider ?? input.providerId,
    input.issue.providerTurnId ?? 'unknown-turn',
    String(input.issue.occurredAt),
    input.issue.usageLimit?.resetAtMs === null || input.issue.usageLimit?.resetAtMs === undefined
      ? 'no-reset'
      : String(input.issue.usageLimit.resetAtMs),
  ].join(':');
}

function parseConnectedServiceId(value: unknown): ConnectedServiceId | null {
  const parsed = ConnectedServiceIdSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function buildSelectedAuth(input: Readonly<{
  issue: SessionRuntimeIssueV1;
  defaultNativeServiceId?: ConnectedServiceId | null;
}>): SessionUsageLimitRecoveryV1['selectedAuth'] {
  const connectedService = input.issue.usageLimit?.connectedService;
  if (connectedService?.groupId) {
    return {
      kind: 'group',
      serviceId: connectedService.serviceId,
      groupId: connectedService.groupId,
      profileId: connectedService.profileId ?? null,
    };
  }
  if (connectedService?.profileId) {
    return {
      kind: 'profile',
      serviceId: connectedService.serviceId,
      profileId: connectedService.profileId,
    };
  }
  const serviceId = parseConnectedServiceId(connectedService?.serviceId) ?? input.defaultNativeServiceId ?? null;
  return serviceId ? { kind: 'native', serviceId } : { kind: 'native' };
}

function resolveFallbackNextCheckAtMs(params: Readonly<{
  intent: Pick<SessionUsageLimitRecoveryV1, 'armedAtMs'>;
  issue: SessionRuntimeIssueV1 | null;
  fallbackBackoffMs: number;
  nowMs: number;
}>): number {
  const anchorMs = Number.isInteger(params.intent.armedAtMs) && params.intent.armedAtMs >= 0
    ? params.intent.armedAtMs
    : params.issue?.occurredAt ?? params.nowMs;
  return anchorMs + params.fallbackBackoffMs;
}

function resolveIntentNextCheckAtMs(params: Readonly<{
  intent: SessionUsageLimitRecoveryV1;
  issue: SessionRuntimeIssueV1 | null;
  fallbackBackoffMs: number;
  nowMs: number;
}>): number {
  if (typeof params.intent.nextCheckAtMs === 'number' && Number.isFinite(params.intent.nextCheckAtMs)) {
    return params.intent.nextCheckAtMs;
  }

  const usageLimit = params.issue?.usageLimit;
  if (usageLimit) {
    const timing = deriveUsageLimitRecoveryTiming({
      occurredAtMs: params.issue.occurredAt,
      resetAtMs: usageLimit.resetAtMs,
      retryAfterMs: usageLimit.retryAfterMs,
    });
    if (timing.nextCheckAtMs !== null) return timing.nextCheckAtMs;
  }

  return resolveFallbackNextCheckAtMs(params);
}

function buildRecoveryIntentFromLatestUsageLimitIssue(params: Readonly<{
  issue: SessionRuntimeIssueV1;
  providerId: string;
  defaultNativeServiceId?: ConnectedServiceId | null;
  fallbackBackoffMs: number;
  maxAttempts: number;
  nowMs: number;
}>): SessionUsageLimitRecoveryV1 {
  const usageLimit = params.issue.usageLimit;
  const timing = usageLimit
    ? deriveUsageLimitRecoveryTiming({
      occurredAtMs: params.issue.occurredAt,
      resetAtMs: usageLimit.resetAtMs,
      retryAfterMs: usageLimit.retryAfterMs,
    })
    : { resetAtMs: null, nextCheckAtMs: null };
  const intent: SessionUsageLimitRecoveryV1 = {
    v: 1,
    status: 'waiting',
    resumePromptMode: 'standard',
    issueFingerprint: buildUsageLimitIssueFingerprint({
      issue: params.issue,
      providerId: params.providerId,
    }),
    armedAtMs: params.issue.occurredAt,
    resetAtMs: timing.resetAtMs,
    nextCheckAtMs: timing.nextCheckAtMs,
    attemptCount: 0,
    maxAttempts: params.maxAttempts,
    lastProbeError: null,
    selectedAuth: buildSelectedAuth({
      issue: params.issue,
      defaultNativeServiceId: params.defaultNativeServiceId,
    }),
  };

  return {
    ...intent,
    nextCheckAtMs: intent.nextCheckAtMs ?? resolveFallbackNextCheckAtMs({
      intent,
      issue: params.issue,
      fallbackBackoffMs: params.fallbackBackoffMs,
      nowMs: params.nowMs,
    }),
  };
}

function buildNextIntent(params: Readonly<{
  intent: SessionUsageLimitRecoveryV1;
  issue: SessionRuntimeIssueV1 | null;
  fallbackBackoffMs: number;
  nowMs: number;
}>): Readonly<{
  adapterStatus: 'ready' | 'waiting';
  intent: SessionUsageLimitRecoveryV1;
}> {
  const nextCheckAtMs = resolveIntentNextCheckAtMs(params);
  const baseIntent: SessionUsageLimitRecoveryV1 = {
    ...params.intent,
    nextCheckAtMs,
  };
  const attemptCount = baseIntent.attemptCount + 1;

  if (baseIntent.maxAttempts > 0 && baseIntent.attemptCount >= baseIntent.maxAttempts) {
    return {
      adapterStatus: 'waiting',
      intent: {
        ...baseIntent,
        status: 'exhausted',
        attemptCount,
        lastProbeError: baseIntent.lastProbeError ?? USAGE_LIMIT_RECOVERY_MAX_ATTEMPTS_EXHAUSTED_ERROR,
      },
    };
  }

  if (params.nowMs >= nextCheckAtMs) {
    return {
      adapterStatus: 'ready',
      intent: {
        ...baseIntent,
        status: 'cancelled',
        attemptCount,
        lastProbeError: null,
      },
    };
  }

  return {
    adapterStatus: 'waiting',
    intent: {
      ...baseIntent,
      status: 'waiting',
      attemptCount,
      lastProbeError: null,
    },
  };
}

export function createBackoffSessionUsageLimitRecoveryControlAdapter(options: Readonly<{
  providerId: string;
  fallbackBackoffEnvKey: string;
  maxAttemptsEnvKey: string;
  defaultFallbackBackoffMs: number;
  defaultMaxAttempts: number;
  defaultNativeServiceId?: ConnectedServiceId | null;
  issueProviderFilter?: string | null;
  nowMs?: () => number;
  processEnv?: NodeJS.ProcessEnv;
}>): SessionUsageLimitRecoveryControlAdapter {
  const nowMs = options.nowMs ?? (() => Date.now());
  const processEnv = options.processEnv ?? process.env;

  return {
    checkNow: async (params): Promise<BackoffUsageLimitRecoveryControlResult> => {
      const now = nowMs();
      const latestIssue = readLatestUsageLimitIssue({
        params,
        issueProviderFilter: options.issueProviderFilter ?? null,
      });
      const persistedIntent = readRecoveryIntent(params.metadata);
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
      const fallbackBackoffMs = readNonNegativeIntegerFromEnv(
        processEnv,
        options.fallbackBackoffEnvKey,
        options.defaultFallbackBackoffMs,
      );
      const intent = persistedIntent && persistedIntent.status !== 'cancelled'
        ? persistedIntent
        : latestIssue
          ? buildRecoveryIntentFromLatestUsageLimitIssue({
            issue: latestIssue,
            providerId: options.providerId,
            defaultNativeServiceId: options.defaultNativeServiceId ?? null,
            fallbackBackoffMs,
            maxAttempts: readNonNegativeIntegerFromEnv(
              processEnv,
              options.maxAttemptsEnvKey,
              options.defaultMaxAttempts,
            ),
            nowMs: now,
          })
          : null;
      if (!intent) {
        return stableError('session_usage_limit_recovery_control_inactive');
      }

      const next = buildNextIntent({
        intent,
        issue: latestIssue,
        fallbackBackoffMs,
        nowMs: now,
      });

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
