import type {
  ScmHostingProviderRepositoryCreateInput,
  ScmHostingProviderRepositoryDescribePublishTargetsInput,
  ScmHostingProviderRepositoryDescribePublishTargetsResult,
  ScmHostingProviderRepositoryGetInput,
} from '@happier-dev/plugin-sdk';
import type {
  ScmHostingProviderRef,
  ScmHostingRepositorySummary,
} from '@happier-dev/protocol';

import { githubHostingProviderAdapter } from '../adapter.js';
import {
  createGithubRepositoryAuthRequiredError,
  isGithubRepositoryAuthRequiredError,
} from './githubRepositoryErrors.js';
import {
  createGithubRepositoryCliAdapter,
  type GithubRepositoryCliAdapter,
} from './githubRepositoryCliAdapter.js';
import {
  isGithubDotComRepositoryProvider,
} from './githubRepositoryApiBase.js';
import {
  createGithubRepositoryRestAdapter,
  type GithubRepositoryRestAdapter,
} from './githubRepositoryRestAdapter.js';

export type GithubRepositoryProvisioningAdapter = typeof githubHostingProviderAdapter & Readonly<{
  describePublishTargets(
    input: ScmHostingProviderRepositoryDescribePublishTargetsInput
  ): Promise<ScmHostingProviderRepositoryDescribePublishTargetsResult>;
  createRepository(input: ScmHostingProviderRepositoryCreateInput): Promise<ScmHostingRepositorySummary>;
  getRepository(input: ScmHostingProviderRepositoryGetInput): Promise<ScmHostingRepositorySummary | null>;
}>;

type GithubRepositoryOperationName =
  | 'describePublishTargets'
  | 'createRepository'
  | 'getRepository';

function shouldTryRest(provider: ScmHostingProviderRef): boolean {
  return isGithubDotComRepositoryProvider(provider);
}

function createNoAuthTargetDiscoveryResult(): ScmHostingProviderRepositoryDescribePublishTargetsResult {
  return {
    auth: {
      state: 'authentication_required',
      profileKind: 'no_auth',
      remediation: {
        kind: 'auth_required',
      },
    },
    targets: [],
  };
}

async function runWithAuthChain<TResult>(
  input: Readonly<{
    provider: ScmHostingProviderRef;
    operationName: GithubRepositoryOperationName;
    runRest: () => Promise<TResult>;
    runCli: () => Promise<TResult>;
    noAuthFallback?: () => TResult;
  }>,
): Promise<TResult> {
  if (!shouldTryRest(input.provider)) {
    try {
      return await input.runCli();
    } catch (error) {
      if (input.noAuthFallback && isGithubRepositoryAuthRequiredError(error)) {
        return input.noAuthFallback();
      }
      throw error;
    }
  }

  try {
    return await input.runRest();
  } catch (error) {
    if (!isGithubRepositoryAuthRequiredError(error)) throw error;
  }

  try {
    return await input.runCli();
  } catch (error) {
    if (input.noAuthFallback && isGithubRepositoryAuthRequiredError(error)) {
      return input.noAuthFallback();
    }
    throw error;
  }
}

export function createGithubRepositoryProvisioningAdapter(params?: Readonly<{
  restAdapter?: Partial<GithubRepositoryRestAdapter>;
  cliAdapter?: Partial<GithubRepositoryCliAdapter>;
}>): GithubRepositoryProvisioningAdapter {
  const restAdapter = params?.restAdapter ?? createGithubRepositoryRestAdapter();
  const cliAdapter = params?.cliAdapter ?? createGithubRepositoryCliAdapter();

  return Object.freeze({
    ...githubHostingProviderAdapter,
    describePublishTargets(input: ScmHostingProviderRepositoryDescribePublishTargetsInput) {
      return runWithAuthChain({
        provider: input.provider,
        operationName: 'describePublishTargets',
        runRest: () => restAdapter.describePublishTargets
          ? restAdapter.describePublishTargets(input)
          : Promise.reject(createGithubRepositoryAuthRequiredError()),
        runCli: () => cliAdapter.describePublishTargets
          ? cliAdapter.describePublishTargets(input)
          : Promise.reject(createGithubRepositoryAuthRequiredError()),
        noAuthFallback: createNoAuthTargetDiscoveryResult,
      });
    },
    createRepository(input: ScmHostingProviderRepositoryCreateInput) {
      return runWithAuthChain({
        provider: input.provider,
        operationName: 'createRepository',
        runRest: () => restAdapter.createRepository
          ? restAdapter.createRepository(input)
          : Promise.reject(createGithubRepositoryAuthRequiredError()),
        runCli: () => cliAdapter.createRepository
          ? cliAdapter.createRepository(input)
          : Promise.reject(createGithubRepositoryAuthRequiredError()),
      });
    },
    getRepository(input: ScmHostingProviderRepositoryGetInput) {
      return runWithAuthChain({
        provider: input.provider,
        operationName: 'getRepository',
        runRest: () => restAdapter.getRepository
          ? restAdapter.getRepository(input)
          : Promise.reject(createGithubRepositoryAuthRequiredError()),
        runCli: () => cliAdapter.getRepository
          ? cliAdapter.getRepository(input)
          : Promise.reject(createGithubRepositoryAuthRequiredError()),
      });
    },
  });
}

export const githubRepositoryProvisioningAdapter = createGithubRepositoryProvisioningAdapter();
