import type { PluginContextV1 } from '@happier-dev/plugin-sdk';
import type { RuntimeEventV1, SessionRuntimeIssueV1 } from '@happier-dev/protocol';

import { buildOpenCodeRuntimeIssue, publishOpenCodeTurnFailed } from './openCodeRuntimeEvents.js';
import {
  buildOpenCodeRetryStatusError,
  type OpenCodeRetryStatusError,
  isOpenCodeUsageLimitRetryStatusError,
} from './openCodeRetryStatus.js';
import type { OpenCodeServerRuntimeState } from './state.js';

function normalizeRetryAfterMs(value: number | undefined): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.trunc(value));
}

function buildOpenCodeRetryUsageLimitDetails(
  retryError: OpenCodeRetryStatusError,
): NonNullable<SessionRuntimeIssueV1['usageLimit']> {
  return {
    v: 1,
    resetAtMs: null,
    retryAfterMs: normalizeRetryAfterMs(retryError.retryAfterMs),
    quotaScope: 'account',
    recoverability: 'wait',
    limitCategory: retryError.name === 'GoUsageLimitError' ? 'rate_limit' : 'usage_limit',
  };
}

export async function maybeFailOnOpenCodeRetryStatus(params: Readonly<{
  ctx: PluginContextV1;
  publishRuntimeEvent: (event: RuntimeEventV1) => void;
  status: unknown;
  state: OpenCodeServerRuntimeState;
  happierSessionId: string;
}>): Promise<boolean> {
  const retryError = buildOpenCodeRetryStatusError(params.status);
  if (!retryError || !params.state.activeTurnId) return false;

  const genericRetryWaitMs = retryError.retryAfterMs ?? 0;
  if (!isOpenCodeUsageLimitRetryStatusError(retryError) && genericRetryWaitMs < 120_000) {
    return false;
  }

  const isUsageLimitRetry = isOpenCodeUsageLimitRetryStatusError(retryError);
  const issue = buildOpenCodeRuntimeIssue({
    code: retryError.code,
    source: isUsageLimitRetry ? 'usage_limit' : 'provider_status_error',
    message: retryError.message,
    occurredAt: Date.now(),
    ...(isUsageLimitRetry ? { usageLimit: buildOpenCodeRetryUsageLimitDetails(retryError) } : {}),
  });
  await publishOpenCodeTurnFailed({
    publishRuntimeEvent: params.publishRuntimeEvent,
    sessionId: params.happierSessionId,
    turnId: params.state.activeTurnId,
    issue,
    emittedAtMs: issue.occurredAt,
  });
  params.state.turnInFlight = false;
  params.state.currentTurnObservedMessageIds.clear();
  params.state.currentTurnObservedToolCallKeys.clear();
  throw retryError;
}
