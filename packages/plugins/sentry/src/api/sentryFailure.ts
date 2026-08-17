/**
 * The single owner of Sentry's failure classification (`SENTRY.md` §9.2).
 *
 * Rate limiting is `429`, never `403`: `[DOC]` documents `403` as insufficient
 * permission and `[SCHEMA]` declares it on the issue endpoints alongside `401`
 * and `404`. Folding the two together turns a permanently missing scope into an
 * endless retry loop.
 *
 * A failure carries a bounded class/code pair and, on an actual `429` with
 * usable provider evidence, an absolute deadline. It never carries a raw status,
 * response body, or header dump.
 */

import {
  SENTRY_FAILURE_CODES,
  SENTRY_SELF_HOSTED_UNSUPPORTED_CODES,
  type SentryFailureV1,
  type SentryOperationV1,
} from '../sentryContracts.js';

import { readSentryRateLimitSnapshot, resolveSentryRetryNotBeforeMs } from './sentryRateLimit.js';

export type SentrySettledResponseV1 = Readonly<{
  status: number;
  headers: Readonly<Record<string, string>>;
  bodyText: string;
}>;

export type SentryFailureInputV1 =
  | Readonly<{
    kind: 'status';
    operation: SentryOperationV1;
    nowMs: number;
    response: SentrySettledResponseV1;
  }>
  /** The request never produced a response: DNS, socket, TLS or timeout. */
  | Readonly<{ kind: 'transport'; operation: SentryOperationV1 }>
  | Readonly<{ kind: 'cancelled'; operation: SentryOperationV1 }>
  /** A response arrived but its required fields could not be characterized. */
  | Readonly<{ kind: 'unparseable'; operation: SentryOperationV1 }>
  /** An allowed public operation is absent, renamed, or shaped differently. */
  | Readonly<{ kind: 'selfHostedUnsupported'; operation: SentryOperationV1 }>;

/**
 * `[SOURCE]` `src/sentry/api/event_search.py` raises `InvalidSearchQuery` and the
 * endpoint returns its message in the `detail` field of a `400`. Only that body
 * shape is a contract rejection of the query; any other `400` stays unknown.
 */
function isInvalidSearchQueryBody(bodyText: string): boolean {
  return /InvalidSearchQuery/u.test(bodyText);
}

export function classifySentryFailure(input: SentryFailureInputV1): SentryFailureV1 {
  switch (input.kind) {
    case 'transport':
      return Object.freeze({
        class: 'transient' as const,
        code: SENTRY_FAILURE_CODES.upstreamUnavailable,
      });
    case 'cancelled':
      return Object.freeze({
        class: 'transient' as const,
        code: SENTRY_FAILURE_CODES.cancelled,
      });
    case 'unparseable':
      return Object.freeze({
        class: 'unsupportedContract' as const,
        code: SENTRY_FAILURE_CODES.responseUnparseable,
      });
    case 'selfHostedUnsupported':
      return Object.freeze({
        class: 'unsupportedContract' as const,
        code: SENTRY_SELF_HOSTED_UNSUPPORTED_CODES[input.operation],
      });
    default:
      break;
  }

  const { response, nowMs } = input;
  if (response.status === 401) {
    return Object.freeze({
      class: 'authentication' as const,
      code: SENTRY_FAILURE_CODES.tokenInvalid,
    });
  }
  if (response.status === 403) {
    return Object.freeze({
      class: 'permission' as const,
      code: SENTRY_FAILURE_CODES.insufficientPermission,
    });
  }
  if (response.status === 429) {
    const retryNotBeforeMs = resolveSentryRetryNotBeforeMs(
      readSentryRateLimitSnapshot(response.headers),
      nowMs,
    );
    return retryNotBeforeMs === null
      ? Object.freeze({
        class: 'rateLimit' as const,
        code: SENTRY_FAILURE_CODES.rateLimitedUnhinted,
      })
      : Object.freeze({
        class: 'rateLimit' as const,
        code: SENTRY_FAILURE_CODES.rateLimited,
        retryNotBeforeMs,
      });
  }
  if (response.status === 400 && isInvalidSearchQueryBody(response.bodyText)) {
    return Object.freeze({
      class: 'unsupportedContract' as const,
      code: SENTRY_FAILURE_CODES.queryRejected,
    });
  }
  if (response.status === 404) {
    return Object.freeze({
      class: 'unknown' as const,
      code: SENTRY_FAILURE_CODES.notFoundUnverified,
    });
  }
  if (response.status >= 500 && response.status <= 599) {
    return Object.freeze({
      class: 'transient' as const,
      code: SENTRY_FAILURE_CODES.upstreamUnavailable,
    });
  }
  return Object.freeze({
    class: 'unknown' as const,
    code: SENTRY_FAILURE_CODES.unexpectedStatus,
  });
}
