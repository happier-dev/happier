/**
 * Plugin-local GitLab failure → public source failure.
 *
 * The two classifications happen to enumerate the same six members today. The
 * mapping is still written as an explicit total switch rather than a cast, so a
 * future divergence in either vocabulary fails to compile instead of silently
 * re-labelling a permission answer as a throttle.
 */

import type { TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';

import type { GitlabFailure, GitlabFailureClass } from './types.js';

function projectFailureClass(value: GitlabFailureClass): TriageSourceFailureV1['class'] {
  switch (value) {
    case 'authentication':
      return 'authentication';
    case 'permission':
      return 'permission';
    case 'rateLimit':
      return 'rateLimit';
    case 'transient':
      return 'transient';
    case 'unsupportedContract':
      return 'unsupportedContract';
    case 'unknown':
      return 'unknown';
  }
}

/**
 * `retryNotBeforeMs` survives only when GitLab supplied its own deadline. This
 * mapper never invents one, and no successful result arm can carry it.
 */
export function projectGitlabSourceFailure(failure: GitlabFailure): TriageSourceFailureV1 {
  return {
    class: projectFailureClass(failure.class),
    code: failure.code,
    ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    ...(failure.retryNotBeforeMs === undefined
      ? {}
      : { retryNotBeforeMs: failure.retryNotBeforeMs }),
  };
}
