/**
 * Plugin-local GitLab failure → public source failure.
 *
 * GitLab produces the canonical source failure shape, including issued request
 * identity and provider retry evidence.
 */

import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import type { GitlabFailure } from './types.js';

/**
 * `retryNotBeforeMs` survives only when GitLab supplied its own deadline. This
 * mapper never invents one, and no successful result arm can carry it.
 */
export function projectGitlabSourceFailure(failure: GitlabFailure): TriageSourceFailureV1 {
  return failure;
}
