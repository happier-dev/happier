import {
  MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1,
  projectTriageDisplayTextV1,
} from '@happier-dev/triage-protocol/v1';

import {
  isBitbucketRateLimitedStatus,
  readBitbucketRetryNotBeforeMs,
} from './bitbucketRateLimit.js';

export type BitbucketFailureClass =
  | 'authentication'
  | 'permission'
  | 'rateLimit'
  | 'notFound'
  | 'transient'
  | 'unsupportedContract'
  | 'cancelled'
  | 'unknown';

export type BitbucketTriageFailure = Readonly<{
  class: BitbucketFailureClass;
  code: string;
  detail?: string;
  retryNotBeforeMs?: number;
}>;

export function createBitbucketFailure(
  failureClass: BitbucketFailureClass,
  code: string,
  extra?: Readonly<{ detail?: string; retryNotBeforeMs?: number }>,
): BitbucketTriageFailure {
  return {
    class: failureClass,
    code,
    ...(extra?.detail === undefined ? {} : { detail: extra.detail }),
    ...(extra?.retryNotBeforeMs === undefined ? {} : { retryNotBeforeMs: extra.retryNotBeforeMs }),
  };
}

/**
 * Reads only `error.message` from Bitbucket's documented `error` envelope. `error.detail` and
 * `error.data` are deliberately not surfaced: they are endpoint-specific and can echo request
 * content, and a failure detail crosses more boundaries than the response itself.
 */
function readBoundedFailureDetail(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== 'object' || error === null) return undefined;
  const message = (error as { message?: unknown }).message;
  if (typeof message !== 'string') return undefined;
  // The published bound is the only ledger, and the detail is projected into one line
  // here: `detail` is a single-line V1 string, and the strict target rejects a
  // control-bearing or over-bound result ATOMICALLY. A source-local ceiling that merely
  // agreed once is exactly the shape of that failure.
  const detail = projectTriageDisplayTextV1(message, MAX_TRIAGE_FAILURE_DETAIL_UTF8_BYTES_V1);
  return detail.value.length === 0 ? undefined : detail.value;
}

export function classifyBitbucketHttpFailure(
  input: Readonly<{
    status: number;
    headers: Readonly<Record<string, string>>;
    body: unknown;
    nowMs: number;
  }>,
): BitbucketTriageFailure {
  const detail = readBoundedFailureDetail(input.body);
  const withDetail = (
    failureClass: BitbucketFailureClass,
    code: string,
    retryNotBeforeMs?: number,
  ): BitbucketTriageFailure => createBitbucketFailure(failureClass, code, {
    ...(detail === undefined ? {} : { detail }),
    ...(retryNotBeforeMs === undefined ? {} : { retryNotBeforeMs }),
  });

  if (isBitbucketRateLimitedStatus(input.status)) {
    const retryNotBeforeMs = readBitbucketRetryNotBeforeMs(input.headers, input.nowMs);
    return withDetail('rateLimit', 'request-throttled', retryNotBeforeMs ?? undefined);
  }

  switch (input.status) {
    // Atlassian moved app passwords to end of life on 2026-07-28; a 401 on a connection that
    // previously worked means the credential itself is no longer valid, not a transient blip.
    case 401:
      return withDetail('authentication', 'credential-invalid');
    // Bitbucket does not publish a token's granted permissions, so a missing permission is only
    // ever learned here. A 403 is never globally equated with throttling on this forge.
    case 403:
      return withDetail('permission', 'insufficient-scope');
    case 404:
      return withDetail('notFound', 'route-not-found');
    case 410:
      return withDetail('unknown', 'resource-gone');
    // Non-standard, documented only on the raw-diff route: "If the diff was too large and timed out."
    case 555:
      return withDetail('unsupportedContract', 'provider-oversized-response');
    default:
      break;
  }

  if (input.status >= 500) return withDetail('transient', 'server-error');
  if (input.status >= 400) return withDetail('unknown', 'unexpected-status');
  return withDetail('unsupportedContract', 'unexpected-success-status');
}

export function classifyBitbucketTransportFailure(error: unknown): BitbucketTriageFailure {
  const name = typeof error === 'object' && error !== null
    ? (error as { name?: unknown }).name
    : undefined;
  if (name === 'TimeoutError') {
    return createBitbucketFailure('transient', 'invocation-deadline-exceeded');
  }
  if (name === 'AbortError') {
    return createBitbucketFailure('cancelled', 'invocation-cancelled');
  }
  return createBitbucketFailure('transient', 'transport-failure');
}
