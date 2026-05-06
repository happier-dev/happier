import type {
  ScmHostingProviderDefaultBranchInput,
  ScmHostingProviderDefaultBranchMetadata,
  ScmHostingProviderPullRequestCheckoutReferenceInput,
  ScmHostingProviderPullRequestCheckoutReferenceMetadata,
  ScmHostingProviderPullRequestCreateInput,
  ScmHostingProviderPullRequestGetInput,
  ScmHostingProviderPullRequestListInput,
} from '@happier-dev/plugin-sdk';
import type {
  ScmHostingProviderRef,
  ScmPullRequestSummary,
} from '@happier-dev/protocol';

import { githubHostingProviderAdapter } from '../adapter.js';
import { createGithubCliAdapter, type GithubCliPullRequestAdapter } from './cliAdapter.js';
import { isGithubAuthRequiredError } from './errors.js';
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

type GithubPullRequestOperationName =
  | 'listPullRequests'
  | 'getPullRequest'
  | 'createPullRequest'
  | 'getDefaultBranch'
  | 'resolvePullRequestCheckoutReference';

function shouldTryRest(provider: ScmHostingProviderRef): boolean {
  return isGithubDotComProvider(provider);
}

async function runWithAuthChain<TResult>(
  input: Readonly<{
    provider: ScmHostingProviderRef;
    operationName: GithubPullRequestOperationName;
    runRest: () => Promise<TResult>;
    runCli: () => Promise<TResult>;
  }>,
): Promise<TResult> {
  if (!shouldTryRest(input.provider)) {
    return input.runCli();
  }
  try {
    return await input.runRest();
  } catch (error) {
    if (!isGithubAuthRequiredError(error)) throw error;
    return input.runCli();
  }
}

export function createGithubPullRequestAdapter(params?: Readonly<{
  restAdapter?: Partial<GithubRestPullRequestAdapter>;
  cliAdapter?: Partial<GithubCliPullRequestAdapter>;
}>): GithubPullRequestAdapter {
  const restAdapter = params?.restAdapter ?? createGithubRestAdapter();
  const cliAdapter = params?.cliAdapter ?? createGithubCliAdapter();

  return Object.freeze({
    ...githubHostingProviderAdapter,
    getPullRequestAuthProfileKey(input: Readonly<{ provider: ScmHostingProviderRef }>) {
      return typeof restAdapter.getPullRequestAuthProfileKey === 'function'
        ? restAdapter.getPullRequestAuthProfileKey(input)
        : null;
    },
    listPullRequests(input: ScmHostingProviderPullRequestListInput) {
      return runWithAuthChain({
        provider: input.provider,
        operationName: 'listPullRequests',
        runRest: () => restAdapter.listPullRequests
          ? restAdapter.listPullRequests(input)
          : Promise.reject(new Error('REST pull request listing is unavailable')),
        runCli: () => cliAdapter.listPullRequests
          ? cliAdapter.listPullRequests(input)
          : Promise.reject(new Error('GitHub CLI pull request listing is unavailable')),
      });
    },
    getPullRequest(input: ScmHostingProviderPullRequestGetInput) {
      return runWithAuthChain({
        provider: input.provider,
        operationName: 'getPullRequest',
        runRest: () => restAdapter.getPullRequest
          ? restAdapter.getPullRequest(input)
          : Promise.reject(new Error('REST pull request lookup is unavailable')),
        runCli: () => cliAdapter.getPullRequest
          ? cliAdapter.getPullRequest(input)
          : Promise.reject(new Error('GitHub CLI pull request lookup is unavailable')),
      });
    },
    createPullRequest(input: ScmHostingProviderPullRequestCreateInput) {
      return runWithAuthChain({
        provider: input.provider,
        operationName: 'createPullRequest',
        runRest: () => restAdapter.createPullRequest
          ? restAdapter.createPullRequest(input)
          : Promise.reject(new Error('REST pull request creation is unavailable')),
        runCli: () => cliAdapter.createPullRequest
          ? cliAdapter.createPullRequest(input)
          : Promise.reject(new Error('GitHub CLI pull request creation is unavailable')),
      });
    },
    getDefaultBranch(input: ScmHostingProviderDefaultBranchInput) {
      return runWithAuthChain({
        provider: input.provider,
        operationName: 'getDefaultBranch',
        runRest: () => restAdapter.getDefaultBranch
          ? restAdapter.getDefaultBranch(input)
          : Promise.reject(new Error('REST default branch lookup is unavailable')),
        runCli: () => cliAdapter.getDefaultBranch
          ? cliAdapter.getDefaultBranch(input)
          : Promise.reject(new Error('GitHub CLI default branch lookup is unavailable')),
      });
    },
    resolvePullRequestCheckoutReference(input: ScmHostingProviderPullRequestCheckoutReferenceInput) {
      return runWithAuthChain({
        provider: input.provider,
        operationName: 'resolvePullRequestCheckoutReference',
        runRest: () => restAdapter.resolvePullRequestCheckoutReference
          ? restAdapter.resolvePullRequestCheckoutReference(input)
          : Promise.reject(new Error('REST checkout reference lookup is unavailable')),
        runCli: () => cliAdapter.resolvePullRequestCheckoutReference
          ? cliAdapter.resolvePullRequestCheckoutReference(input)
          : Promise.reject(new Error('GitHub CLI checkout reference lookup is unavailable')),
      });
    },
  });
}

export const githubPullRequestAdapter = createGithubPullRequestAdapter();
