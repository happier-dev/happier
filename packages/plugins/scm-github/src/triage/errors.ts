import type { GithubApiResponseV1 } from '../observations/githubApiClient.js';
import {
  classifyGithubResponseFailure as classifyGithubResponse,
} from '../observations/githubResponseFailure.js';

import type { GithubTriageFailureV1 } from './types.js';

/**
 * Triage's view of GitHub failure classification.
 *
 * The ladder itself — which status is a rejected credential, a withheld
 * permission, a throttle with an exact retry instruction, an unreachable
 * resource, or an unclassified answer — belongs to the one GitHub classifier in
 * `observations/githubResponseFailure.ts`, together with the observed GitHub
 * behaviour it records. Triage only names that answer in its own vocabulary, so
 * a Triage read and a Channel or Automation observation of the same response can
 * never disagree about what GitHub said.
 */

export function isGithubSuccessStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * A GitHub 5xx is an answer about the server, not proof that the request had no
 * effect. Every mutation owner must reconcile it with its authoritative read;
 * 4xx responses remain the provider's definite rejection.
 */
export function isGithubWriteResponseAmbiguous(response: GithubApiResponseV1): boolean {
  return response.status >= 500;
}

/**
 * Classifies a non-success GitHub response. `nowMs` is the invocation's single
 * captured clock reading: the emitted `retryNotBeforeMs` is an ABSOLUTE instant
 * derived from GitHub's own retry evidence, never from a guessed schedule.
 */
export function classifyGithubResponseFailure(
  response: GithubApiResponseV1,
  nowMs: number,
): GithubTriageFailureV1 {
  return classifyGithubResponse(response, nowMs);
}

/** A thrown transport/cancellation outcome, classified without inspecting a credential. */
export { classifyGithubTransportFailure } from '../observations/githubResponseFailure.js';

export const GITHUB_ROUTE_BODY_MISMATCH_FAILURE: GithubTriageFailureV1 = Object.freeze({
  class: 'unknown',
  code: 'route-body-mismatch',
});

export const GITHUB_MISSING_LOCATOR_FAILURE: GithubTriageFailureV1 = Object.freeze({
  class: 'unknown',
  code: 'github_locator_unusable',
});
