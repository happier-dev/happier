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

import {
  type TriageConfiguredSourceConnectedAccountInstanceV1,
  type TriageConfiguredSourceInstanceV1,
} from '@happier-dev/triage-protocol/v1';
import { readTriageSourceAccountListingV1 } from '@happier-dev/triage-sources/runtime';

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

type GitlabInstanceAuthority = Pick<TriageConfiguredSourceInstanceV1, 'binding' | 'localInstanceKey' | 'configuration'>;
type GitlabConnectedInstanceAuthority = Pick<TriageConfiguredSourceConnectedAccountInstanceV1, 'binding' | 'localInstanceKey' | 'configuration'>;

export type GitlabConfiguredInstanceResolution =
  | Readonly<{
    kind: 'resolved';
    origin: GitlabConfiguredOrigin;
    instance: GitlabConnectedInstanceAuthority;
  }>
  | Readonly<{ kind: 'failed'; failure: GitlabFailure }>;

/** Pure configured-instance admission, shared by pre-credential token checks and authorization. */
export function resolveGitlabConfiguredInstance(
  instance: GitlabInstanceAuthority,
): GitlabConfiguredInstanceResolution {
  if (!('account' in instance.binding)) {
    return {
      kind: 'failed',
      failure: {
        class: 'unsupportedContract',
        code: 'unsupported-credential-source',
        detail: 'This GitLab source requires a connected account.',
      },
    };
  }
  if (instance.binding.purpose !== GITLAB_CONNECTED_ACCOUNT_PURPOSE) {
    return {
      kind: 'failed',
      failure: {
        class: 'unsupportedContract',
        code: 'unexpected-account-purpose',
        detail: 'The configured instance names an account purpose this source does not declare.',
      },
    };
  }

  if (decodeGitlabConfiguration(instance.configuration) === null) {
    return {
      kind: 'failed',
      failure: {
        class: 'unsupportedContract',
        code: 'unsupported-configuration',
        detail: 'The configured GitLab instance carries a configuration this source did not mint.',
      },
    };
  }

  const admission = admitGitlabV1Deployment(instance.localInstanceKey);
  return admission.kind === 'rejected'
    ? { kind: 'failed', failure: admission.failure }
    : { kind: 'resolved', origin: admission.origin, instance: { ...instance, binding: instance.binding } };
}

function isSameAccount(
  left: TriageConfiguredSourceConnectedAccountInstanceV1['binding']['account'],
  right: TriageConfiguredSourceConnectedAccountInstanceV1['binding']['account'],
): boolean {
  return left.accountId === right.accountId
    && left.service.pluginId === right.service.pluginId
    && left.service.localId === right.service.localId;
}

/**
 * Reconfirms the exact path-bearing configured base at the Connected Account
 * owner. HostAccess and materialization deliberately admit the bare origin, so
 * neither can distinguish two GitLab deployments mounted below the same host.
 */
async function confirmGitlabConfiguredBaseIsCurrent(input: Readonly<{
  instance: Pick<GitlabConnectedInstanceAuthority, 'binding'>;
  origin: GitlabConfiguredOrigin;
  connectedAccounts: GitlabConnectedAccounts;
  signal: AbortSignal;
}>): Promise<GitlabFailure | null> {
  const outcome = await readTriageSourceAccountListingV1({
    connectedAccounts: input.connectedAccounts,
    purpose: input.instance.binding.purpose,
    signal: input.signal,
  });
  if (outcome.kind === 'failed') {
    return {
      class: 'transient',
      code: outcome.reason === 'deadline'
        ? 'deadline-exceeded'
        : outcome.reason === 'cancelled'
          ? 'cancelled'
          : 'account-listing-failed',
      detail: 'The configured GitLab account could not be reconfirmed.',
    };
  }

  const listed = outcome.kind === 'listed'
    ? outcome.listing.accounts.find((candidate) => (
      isSameAccount(candidate.account, input.instance.binding.account)
    ))
    : undefined;
  if (listed === undefined) {
    if (outcome.kind === 'listed' && outcome.listing.status === 'truncated') {
      return {
        class: 'transient',
        code: 'configured-account-listing-truncated',
        detail: 'The Connected Accounts listing ended before this configured GitLab account could be confirmed.',
      };
    }
    return {
      class: 'authentication',
      code: 'configured-account-unavailable',
      detail: 'The GitLab account this configured instance is bound to is no longer connected.',
    };
  }
  if (!listed.connectedAccountBases.includes(input.origin.normalized)) {
    return {
      class: 'unsupportedContract',
      code: 'configured-base-stale',
      detail: 'This GitLab account no longer publishes the deployment base this configured instance reads.',
    };
  }
  return null;
}

export async function authorizeGitlabConfiguredInstance(input: Readonly<{
  requestId?: string;
  instance: GitlabInstanceAuthority;
  connectedAccounts: GitlabConnectedAccounts;
  signal: AbortSignal;
}>): Promise<GitlabConfiguredInvocationResult> {
  const resolution = resolveGitlabConfiguredInstance(input.instance);
  if (resolution.kind === 'failed') return resolution;
  return authorizeGitlabBoundAccount({ ...input, origin: resolution.origin, instance: resolution.instance });
}

/** Exact-account/base authorization shared by Triage and repository Event setup. */
export async function authorizeGitlabBoundAccount(input: Readonly<{
  requestId?: string;
  instance: Pick<GitlabConnectedInstanceAuthority, 'binding'>;
  origin: GitlabConfiguredOrigin;
  connectedAccounts: GitlabConnectedAccounts;
  signal: AbortSignal;
}>): Promise<GitlabConfiguredInvocationResult> {
  const { origin, instance } = input;
  const stale = await confirmGitlabConfiguredBaseIsCurrent({
    instance,
    origin,
    connectedAccounts: input.connectedAccounts,
    signal: input.signal,
  });
  if (stale !== null) return { kind: 'failed', failure: stale };

  const authorization = await authorizeGitlabInvocation({
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    connectedAccounts: input.connectedAccounts,
    purpose: instance.binding.purpose,
    account: instance.binding.account,
    origin,
    signal: input.signal,
  });
  if (authorization.kind === 'failed') return { kind: 'failed', failure: authorization.failure };

  // Materialization is an awaited authority boundary. Recheck after it so an
  // account retarget cannot make newly minted credentials cross from /A to /B.
  const retargeted = await confirmGitlabConfiguredBaseIsCurrent({
    instance,
    origin,
    connectedAccounts: input.connectedAccounts,
    signal: input.signal,
  });
  if (retargeted !== null) return { kind: 'failed', failure: retargeted };

  return {
    kind: 'authorized',
    resolved: { origin, invocation: authorization.invocation },
  };
}
