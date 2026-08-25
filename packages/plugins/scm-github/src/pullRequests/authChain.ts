import type {
  HostingProviderDefaultBranchInput as ScmHostingProviderDefaultBranchInput,
  HostingProviderDefaultBranchMetadata as ScmHostingProviderDefaultBranchMetadata,
  HostingProviderPullRequestCheckoutReferenceInput as ScmHostingProviderPullRequestCheckoutReferenceInput,
  HostingProviderPullRequestCheckoutReferenceMetadata as ScmHostingProviderPullRequestCheckoutReferenceMetadata,
  HostingProviderPullRequestCreateInput as ScmHostingProviderPullRequestCreateInput,
  HostingProviderPullRequestGetInput as ScmHostingProviderPullRequestGetInput,
  HostingProviderPullRequestListInput as ScmHostingProviderPullRequestListInput,
} from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/scm';
import type {
  ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';

import { githubHostingProviderAdapter } from '../adapter.js';
import { createGithubAuthRequiredError } from './errors.js';
import {
  createGithubRestAdapter,
  isGithubDotComProvider,
  type GithubRestPullRequestAdapter,
} from './restAdapter.js';

export type GithubPullRequestAdapter = typeof githubHostingProviderAdapter & Readonly<{
  getPullRequestAuthProfileKey(input: Readonly<{ provider: ScmHostingProviderRef }>): string | null;
  listPullRequests(input: ScmHostingProviderPullRequestListInput): Promise<readonly ScmPullRequestSummary[]>;
  getPullRequest(input: ScmHostingProviderPullRequestGetInput): Promise<ScmPullRequestSummary | null>;
  createPullRequest(input: ScmHostingProviderPullRequestCreateInput): Promise<ScmPullRequestSummary>;
  getDefaultBranch(input: ScmHostingProviderDefaultBranchInput): Promise<ScmHostingProviderDefaultBranchMetadata>;
  resolvePullRequestCheckoutReference(
    input: ScmHostingProviderPullRequestCheckoutReferenceInput
  ): Promise<ScmHostingProviderPullRequestCheckoutReferenceMetadata>;
}>;

/**
 * The bound GitHub Connected Account is the sole authenticated authority for
 * pull-request reads and mutations. A host with no qualified Connected Account
 * path — every non-`github.com` host, including GitHub Enterprise — is refused
 * typed rather than executed with whatever credentials happen to be present on
 * the machine.
 */
function requireBoundAccountHost(provider: ScmHostingProviderRef): void {
  if (isGithubDotComProvider(provider)) return;
  throw createGithubAuthRequiredError(
    'GitHub pull request operations require a bound github.com Connected Account; '
    + 'this host has no qualified GitHub Connected Account.',
  );
}

export function createGithubPullRequestAdapter(params?: Readonly<{
  restAdapter?: Partial<GithubRestPullRequestAdapter>;
}>): GithubPullRequestAdapter {
  const restAdapter = params?.restAdapter ?? createGithubRestAdapter();

  return Object.freeze({
    ...githubHostingProviderAdapter,
    getPullRequestAuthProfileKey(input: Readonly<{ provider: ScmHostingProviderRef }>) {
      return typeof restAdapter.getPullRequestAuthProfileKey === 'function'
        ? restAdapter.getPullRequestAuthProfileKey(input)
        : null;
    },
    async listPullRequests(input: ScmHostingProviderPullRequestListInput) {
      requireBoundAccountHost(input.provider);
      if (!restAdapter.listPullRequests) {
        throw createGithubAuthRequiredError('GitHub pull request listing is unavailable');
      }
      return await restAdapter.listPullRequests(input);
    },
    async getPullRequest(input: ScmHostingProviderPullRequestGetInput) {
      requireBoundAccountHost(input.provider);
      if (!restAdapter.getPullRequest) {
        throw createGithubAuthRequiredError('GitHub pull request lookup is unavailable');
      }
      return await restAdapter.getPullRequest(input);
    },
    async createPullRequest(input: ScmHostingProviderPullRequestCreateInput) {
      requireBoundAccountHost(input.provider);
      if (!restAdapter.createPullRequest) {
        throw createGithubAuthRequiredError('GitHub pull request creation is unavailable');
      }
      return await restAdapter.createPullRequest(input);
    },
    async getDefaultBranch(input: ScmHostingProviderDefaultBranchInput) {
      requireBoundAccountHost(input.provider);
      if (!restAdapter.getDefaultBranch) {
        throw createGithubAuthRequiredError('GitHub default branch lookup is unavailable');
      }
      return await restAdapter.getDefaultBranch(input);
    },
    async resolvePullRequestCheckoutReference(
      input: ScmHostingProviderPullRequestCheckoutReferenceInput,
    ) {
      requireBoundAccountHost(input.provider);
      if (!restAdapter.resolvePullRequestCheckoutReference) {
        throw createGithubAuthRequiredError('GitHub checkout reference lookup is unavailable');
      }
      return await restAdapter.resolvePullRequestCheckoutReference(input);
    },
  });
}

export const githubPullRequestAdapter = createGithubPullRequestAdapter();
