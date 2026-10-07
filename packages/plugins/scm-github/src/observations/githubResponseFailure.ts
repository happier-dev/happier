import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';
import { isBoundedInvocationDeadline } from '@happier-dev/triage-sources/runtime';

import {
  readGithubApiResponseFacts,
  readGithubContentCreationThrottleRetryAfterMs,
  readGithubRateLimitRetryAfterMs,
  type GithubApiResponseV1,
  type GithubResponseFactsV1,
} from './githubApiClient.js';

/**
 * The one GitHub HTTP failure classifier. Triage, Channels, and the Automation
 * observer all answer the same provider questions — is this credential usable,
 * is this a throttle with an exact retry instruction, is this resource
 * unreachable, is this worth retrying at all — so they read one ladder here and
 * map its classes onto their own vocabularies. A second per-vertical ladder is
 * how the observer came to report a deleted repository as a missing credential.
 *
 * OBSERVED GITHUB BEHAVIOUR THIS MODULE RELIES ON — recorded 2026-08-14 against GitHub's
 * published REST documentation and OpenAPI description for API version `2026-03-10`:
 *
 *  - `GET /repos/{owner}/{repo}/issues/{number}` distinguishes three statuses, and the
 *    distinction is the whole reason absence is issue-specific:
 *      `301` the issue was TRANSFERRED and the successor is readable;
 *      `404` transferred OR deleted into/within a repository the viewer CANNOT read;
 *      `410` deleted, and the viewer CAN read the repository.
 *    Therefore `404` is `unresolved`, never `absent`: a live issue transferred into a
 *    repository this credential cannot see is indistinguishable from a deletion, and
 *    treating it as absence deletes a real row with its marks and Session links.
 *  - `GET /repos/{owner}/{repo}/pulls/{number}` publishes no such `410`/`301` contract.
 *    Pull requests do not transfer; they close. Its absence ladder therefore stays
 *    `404` plus a readable-repository confirmation, and the issue ladder is NOT
 *    generalized onto it.
 *  - A bare `404` on either endpoint is permission-masked and indistinguishable from
 *    "exists but you cannot see it".
 *  - `403` is NOT globally throttling. GitHub answers `403` with
 *    `x-accepted-github-permissions` when a permission is missing, and uses `403` for a
 *    secondary rate limit only with the documented limit message or an exhausted
 *    `x-ratelimit-remaining`.
 *
 * Where GitHub cannot be distinguished for an endpoint, the answer is the conservative
 * arm — `unknown` — never absence.
 */

export type GithubResponseFailureClassV1 =
  | 'authentication'
  | 'permission'
  | 'rateLimit'
  | 'transient'
  | 'unsupportedContract'
  | 'unknown';

export type GithubResponseFailureV1 = Readonly<{
  class: GithubResponseFailureClassV1;
  code: string;
  /** Absolute epoch milliseconds, derived only from provider retry evidence. */
  retryNotBeforeMs?: number;
}>;

/**
 * The published failure codes. Consumers that must separate an unreachable
 * resource from an unclassified status read these rather than restating a
 * status ladder of their own.
 */
export const GITHUB_RESPONSE_FAILURE_CODE = Object.freeze({
  unauthorized: 'github_unauthorized',
  forbidden: 'github_forbidden',
  insufficientScope: 'insufficient_scope',
  notFound: 'github_not_found',
  gone: 'github_gone',
  unprocessable: 'github_unprocessable',
  serverError: 'github_server_error',
  rateLimited: 'github_rate_limited',
  secondaryRateLimited: 'github_secondary_rate_limited',
});

/** GitHub names the permission a rejected request required on this response header. */
const ACCEPTED_PERMISSIONS_HEADER = 'x-accepted-github-permissions';

/**
 * GitHub answered about this exact resource: it is deleted, renamed, or masked
 * by a credential that cannot see it. Retrying the same request cannot change
 * the answer, and it is not the unclassified-status arm.
 */
export function isGithubInaccessibleResourceFailure(failure: GithubResponseFailureV1): boolean {
  return failure.class === 'unknown'
    && (failure.code === GITHUB_RESPONSE_FAILURE_CODE.notFound
      || failure.code === GITHUB_RESPONSE_FAILURE_CODE.gone);
}

/**
 * The one ladder, over the facts every carrier can supply. `nowMs` is the
 * invocation's single captured clock reading: the emitted `retryNotBeforeMs` is
 * an ABSOLUTE instant derived from GitHub's own retry evidence, never from a
 * guessed schedule.
 *
 * A carrier that cannot supply headers degrades here rather than diverging: an
 * unhinted `403` classifies as `permission`, exactly as it does today.
 */
export function classifyGithubResponseFacts(
  facts: GithubResponseFactsV1,
  nowMs: number,
): GithubResponseFailureV1 {
  // Every throttle family GitHub publishes, wherever it reports it: the primary
  // and secondary limits, and a content-creation `422` GitHub itself says to
  // retry. A throttle is never a permanent failure.
  const retryAfterMs = readGithubRateLimitRetryAfterMs(facts, nowMs)
    ?? readGithubContentCreationThrottleRetryAfterMs(facts, nowMs);
  if (retryAfterMs !== null) {
    return Object.freeze({
      class: 'rateLimit',
      code: facts.status === 429
        ? GITHUB_RESPONSE_FAILURE_CODE.rateLimited
        : GITHUB_RESPONSE_FAILURE_CODE.secondaryRateLimited,
      retryNotBeforeMs: nowMs + retryAfterMs,
    });
  }
  if (facts.status === 401) {
    return Object.freeze({ class: 'authentication', code: GITHUB_RESPONSE_FAILURE_CODE.unauthorized });
  }
  if (facts.status === 403) {
    return Object.freeze({
      class: 'permission',
      code: readTriageResponseHeaderV1(facts.headers, ACCEPTED_PERMISSIONS_HEADER) === null
        ? GITHUB_RESPONSE_FAILURE_CODE.forbidden
        : GITHUB_RESPONSE_FAILURE_CODE.insufficientScope,
    });
  }
  if (facts.status === 404) {
    return Object.freeze({ class: 'unknown', code: GITHUB_RESPONSE_FAILURE_CODE.notFound });
  }
  if (facts.status === 410) {
    return Object.freeze({ class: 'unknown', code: GITHUB_RESPONSE_FAILURE_CODE.gone });
  }
  if (facts.status === 422) {
    return Object.freeze({ class: 'unsupportedContract', code: GITHUB_RESPONSE_FAILURE_CODE.unprocessable });
  }
  if (facts.status >= 500) {
    return Object.freeze({ class: 'transient', code: GITHUB_RESPONSE_FAILURE_CODE.serverError });
  }
  return Object.freeze({ class: 'unknown', code: `github_status_${facts.status}` });
}

/** Classifies a non-success response from the `github-api` client. */
export function classifyGithubResponseFailure(
  response: GithubApiResponseV1,
  nowMs: number,
): GithubResponseFailureV1 {
  return classifyGithubResponseFacts(readGithubApiResponseFacts(response), nowMs);
}

/**
 * One wording for "GitHub throttled this request", so each consumer vocabulary
 * names the same answer the same way. `retryNotBeforeMs` is the classifier's
 * absolute instant.
 */
export function describeGithubRateLimitFailure(retryNotBeforeMs: number | undefined): string {
  return retryNotBeforeMs === undefined
    ? 'GitHub rate limited this request. Retry later.'
    : `GitHub rate limited this request. Retry after ${new Date(retryNotBeforeMs).toISOString()}.`;
}

/** A thrown transport/cancellation outcome, classified without inspecting a credential. */
export function classifyGithubTransportFailure(error: unknown): GithubResponseFailureV1 {
  if (isBoundedInvocationDeadline(error)) {
    return Object.freeze({ class: 'transient', code: 'github_request_timed_out' });
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return Object.freeze({ class: 'transient', code: 'github_request_cancelled' });
  }
  const code = typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof (error as { code: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
  if (code === 'github_credential_unavailable'
    || code === 'github_credential_mismatch'
    || code === 'plugin_connected_account_native_unavailable') {
    return Object.freeze({ class: 'authentication', code });
  }
  // The shared exact-account materializer converts an abort into a typed reason rather
  // than letting the `AbortError` propagate, so cancellation reaches here as a code.
  if (code === 'github_request_cancelled') {
    return Object.freeze({ class: 'transient', code });
  }
  if (code !== null) {
    return Object.freeze({ class: 'unsupportedContract', code });
  }
  return Object.freeze({ class: 'transient', code: 'github_request_failed' });
}
