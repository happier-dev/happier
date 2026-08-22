import { readTriageResponseHeaderV1 } from '@happier-dev/triage-protocol/v1';

import {
  isGithubRateLimited,
  readGithubRateLimitRetryAfterMs,
  type GithubApiResponseV1,
} from '../observations/githubApiClient.js';

import type { GithubTriageFailureV1 } from './types.js';

/**
 * GitHub failure classification for the Triage vertical.
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
 * arm — `unresolved` — never `absent`.
 */

/** GitHub names the permission a rejected request required on this response header. */
const ACCEPTED_PERMISSIONS_HEADER = 'x-accepted-github-permissions';

export function isGithubSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * Classifies a non-success GitHub response. `nowMs` is the invocation's single captured
 * clock reading: the emitted `retryNotBeforeMs` is an ABSOLUTE instant derived from
 * GitHub's own retry evidence, never from a guessed schedule.
 */
export function classifyGithubResponseFailure(
  response: GithubApiResponseV1,
  nowMs: number,
): GithubTriageFailureV1 {
  if (isGithubRateLimited(response)) {
    const durationMs = readGithubRateLimitRetryAfterMs(response, nowMs);
    return Object.freeze({
      class: 'rateLimit',
      code: response.status === 429 ? 'github_rate_limited' : 'github_secondary_rate_limited',
      ...(durationMs === null ? {} : { retryNotBeforeMs: nowMs + durationMs }),
    });
  }
  if (response.status === 401) {
    return Object.freeze({ class: 'authentication', code: 'github_unauthorized' });
  }
  if (response.status === 403) {
    return Object.freeze({
      class: 'permission',
      code: readTriageResponseHeaderV1(response.headers, ACCEPTED_PERMISSIONS_HEADER) === null
        ? 'github_forbidden'
        : 'insufficient_scope',
    });
  }
  if (response.status === 404) {
    return Object.freeze({ class: 'unknown', code: 'github_not_found' });
  }
  if (response.status === 410) {
    return Object.freeze({ class: 'unknown', code: 'github_gone' });
  }
  if (response.status === 422) {
    return Object.freeze({ class: 'unsupportedContract', code: 'github_unprocessable' });
  }
  if (response.status >= 500) {
    return Object.freeze({ class: 'transient', code: 'github_server_error' });
  }
  return Object.freeze({ class: 'unknown', code: `github_status_${response.status}` });
}

/** A thrown transport/cancellation outcome, classified without inspecting a credential. */
export function classifyGithubTransportFailure(error: unknown): GithubTriageFailureV1 {
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return Object.freeze({ class: 'transient', code: 'github_request_cancelled' });
  }
  const code = typeof error === 'object'
    && error !== null
    && 'code' in error
    && typeof (error as { code: unknown }).code === 'string'
    ? (error as { code: string }).code
    : null;
  if (code === 'github_credential_unavailable' || code === 'github_credential_mismatch') {
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

export const GITHUB_ROUTE_BODY_MISMATCH_FAILURE: GithubTriageFailureV1 = Object.freeze({
  class: 'unknown',
  code: 'route-body-mismatch',
});

export const GITHUB_MISSING_LOCATOR_FAILURE: GithubTriageFailureV1 = Object.freeze({
  class: 'unknown',
  code: 'github_locator_unusable',
});
