/**
 * Turning one target-supplied configured instance into one authorized GitLab
 * invocation.
 *
 * The configured deployment origin is GitLab's source-native instance scope and
 * therefore travels as `localInstanceKey`. It is re-admitted on every invocation
 * rather than trusted: an origin that stopped being admissible must stop being
 * read, and the materialization is bound to that same origin so material minted
 * for one deployment can never be sent to another.
 */

import type { TriageConfiguredSourceInstanceV1 } from '@happier-dev/triage-protocol/v1';

import { decodeGitlabConfiguration } from './configuration.js';
import { GITLAB_CONNECTED_ACCOUNT_PURPOSE } from './contribution.js';
import {
  authorizeGitlabInvocation,
  type GitlabAuthorizedInvocation,
  type GitlabConnectedAccounts,
} from './http/gitlabClient.js';
import { admitGitlabV1Deployment } from './origin.js';
import type { GitlabConfiguredOrigin } from './origin.js';
import type { GitlabFailure } from './types.js';

export type GitlabConfiguredInvocation = Readonly<{
  origin: GitlabConfiguredOrigin;
  invocation: GitlabAuthorizedInvocation;
}>;

export type GitlabConfiguredInvocationResult =
  | Readonly<{ kind: 'authorized'; resolved: GitlabConfiguredInvocation }>
  | Readonly<{ kind: 'failed'; failure: GitlabFailure }>;

export async function authorizeGitlabConfiguredInstance(input: Readonly<{
  instance: TriageConfiguredSourceInstanceV1;
  connectedAccounts: GitlabConnectedAccounts;
  signal: AbortSignal;
}>): Promise<GitlabConfiguredInvocationResult> {
  if (input.instance.binding.purpose !== GITLAB_CONNECTED_ACCOUNT_PURPOSE) {
    return {
      kind: 'failed',
      failure: {
        class: 'unsupportedContract',
        code: 'unexpected-account-purpose',
        detail: 'The configured instance names an account purpose this source does not declare.',
      },
    };
  }

  if (decodeGitlabConfiguration(input.instance.configuration) === null) {
    return {
      kind: 'failed',
      failure: {
        class: 'unsupportedContract',
        code: 'unsupported-configuration',
        detail: 'The configured GitLab instance carries a configuration this source did not mint.',
      },
    };
  }

  const admission = admitGitlabV1Deployment(input.instance.localInstanceKey);
  if (admission.kind === 'rejected') return { kind: 'failed', failure: admission.failure };

  const authorization = await authorizeGitlabInvocation({
    connectedAccounts: input.connectedAccounts,
    purpose: input.instance.binding.purpose,
    account: input.instance.binding.account,
    origin: admission.origin,
    signal: input.signal,
  });
  if (authorization.kind === 'failed') return { kind: 'failed', failure: authorization.failure };

  return {
    kind: 'authorized',
    resolved: { origin: admission.origin, invocation: authorization.invocation },
  };
}
