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
  ScmOperationErrorCode,
  ScmHostingProviderRef,
  ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

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

function readErrorCode(error: unknown): ScmOperationErrorCode | null {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { errorCode?: unknown }).errorCode;
  return typeof code === 'string' && Object.values(SCM_OPERATION_ERROR_CODES).includes(code as ScmOperationErrorCode)
    ? code as ScmOperationErrorCode
    : null;
}

function hasRecoverableHttpStatus(message: string): boolean {
  const match = /\bstatus\s+(\d{3})\b/i.exec(message);
  if (!match) return false;
  const status = Number(match[1]);
  return status === 408 || status === 429 || status >= 500;
}

function isRecoverableGithubRestFailure(error: unknown): boolean {
  if (isGithubAuthRequiredError(error)) return true;
  if (error instanceof TypeError) return true;
  if (!error || typeof error !== 'object') return false;
  const code = readErrorCode(error);
  if (code === SCM_OPERATION_ERROR_CODES.COMMAND_FAILED) {
    const message = error instanceof Error ? error.message : '';
    return hasRecoverableHttpStatus(message)
      || /\b(fetch failed|network|econnreset|etimedout|socket hang up)\b/i.test(message);
  }
  return false;
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
    if (!isRecoverableGithubRestFailure(error)) throw error;
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
