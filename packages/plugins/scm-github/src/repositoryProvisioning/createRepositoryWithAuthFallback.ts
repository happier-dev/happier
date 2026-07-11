import type {
  ScmHostingProviderRepositoryCreateInput,
  ScmHostingProviderRepositoryDescribeCloneTargetsInput,
  ScmHostingProviderRepositoryDescribePublishTargetsInput,
  ScmHostingProviderRepositoryDescribePublishTargetsResult,
  ScmHostingProviderRepositoryGetInput,
} from '@happier-dev/plugin-sdk';
import type {
  ScmOperationErrorCode,
  ScmHostingProviderRef,
  ScmHostingRepositoryAuthSummary,
  ScmHostingRepositorySummary,
  ScmRepositoryCloneTarget,
  ScmRepositoryCloneTargetDescription,
} from '@happier-dev/plugin-sdk/scm';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/plugin-sdk/scm';

import { githubHostingProviderAdapter } from '../adapter.js';
import { parseScmRemoteUrl } from '../remoteUrl.js';
import {
  createGithubRepositoryAuthRequiredError,
  createGithubRepositoryNotFoundError,
  createGithubRepositoryUnsupportedError,
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
  describeCloneTargets(
    input: ScmHostingProviderRepositoryDescribeCloneTargetsInput
  ): Promise<ScmRepositoryCloneTargetDescription>;
  createRepository(input: ScmHostingProviderRepositoryCreateInput): Promise<ScmHostingRepositorySummary>;
  getRepository(input: ScmHostingProviderRepositoryGetInput): Promise<ScmHostingRepositorySummary | null>;
}>;

type GithubRepositoryOperationName =
  | 'describePublishTargets'
  | 'describeCloneTargets'
  | 'createRepository'
  | 'getRepository';

function shouldTryRest(provider: ScmHostingProviderRef): boolean {
  return isGithubDotComRepositoryProvider(provider);
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

function isRecoverableGithubRepositoryRestFailure(error: unknown): boolean {
  if (isGithubRepositoryAuthRequiredError(error)) return true;
  if (error instanceof TypeError) return true;
  if (!error || typeof error !== 'object') return false;
  const code = readErrorCode(error);
  if (code !== SCM_OPERATION_ERROR_CODES.COMMAND_FAILED) return false;
  const message = error instanceof Error ? error.message : '';
  return hasRecoverableHttpStatus(message)
    || /\b(fetch failed|network|econnreset|etimedout|socket hang up)\b/i.test(message);
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

function parseNameWithOwner(value: string): Readonly<{ owner: string; repositoryName: string }> | null {
  const segments = value.split('/');
  if (segments.length !== 2) return null;
  const [owner, repositoryName] = segments.map((segment) => segment.trim());
  if (!owner || !repositoryName) return null;
  if ([owner, repositoryName].some((segment) => (
    segment === '.'
    || segment === '..'
    || segment.includes('\\')
    || segment.includes('?')
    || segment.includes('#')
  ))) return null;
  return { owner, repositoryName };
}

function readProviderOrigin(provider: ScmHostingProviderRef): URL | null {
  try {
    const parsed = new URL(provider.baseUrl);
    return parsed.protocol === 'https:' && parsed.hostname ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeRepositoryPath(path: string): string {
  const stripped = path.replace(/^\/+/, '').replace(/\/+$/, '');
  return stripped.endsWith('.git') ? stripped.slice(0, -4) : stripped;
}

function isSafeHttpsCloneUrl(input: Readonly<{
  provider: ScmHostingProviderRef;
  repository: ScmHostingRepositorySummary;
  cloneUrl: string;
}>): boolean {
  const providerOrigin = readProviderOrigin(input.provider);
  if (!providerOrigin) return false;
  try {
    const parsed = new URL(input.cloneUrl);
    return parsed.protocol === 'https:'
      && parsed.origin === providerOrigin.origin
      && normalizeRepositoryPath(decodeURIComponent(parsed.pathname)) === input.repository.nameWithOwner;
  } catch {
    return false;
  }
}

function isSafeSshCloneUrl(input: Readonly<{
  provider: ScmHostingProviderRef;
  repository: ScmHostingRepositorySummary;
  sshUrl: string;
}>): boolean {
  const providerOrigin = readProviderOrigin(input.provider);
  if (!providerOrigin) return false;
  const parsed = parseScmRemoteUrl(input.sshUrl);
  if (!parsed) return false;
  return parsed.host === providerOrigin.hostname.toLowerCase()
    && parsed.path === input.repository.nameWithOwner;
}

function describeRepositoryCloneTargets(input: Readonly<{
  auth: ScmHostingRepositoryAuthSummary;
  provider: ScmHostingProviderRef;
  repository: ScmHostingRepositorySummary;
}>): ScmRepositoryCloneTargetDescription {
  const targets: ScmRepositoryCloneTarget[] = [];
  const cloneUrl = input.repository.cloneUrl && isSafeHttpsCloneUrl({
    provider: input.provider,
    repository: input.repository,
    cloneUrl: input.repository.cloneUrl,
  }) ? input.repository.cloneUrl : null;
  const sshUrl = input.repository.sshUrl && isSafeSshCloneUrl({
    provider: input.provider,
    repository: input.repository,
    sshUrl: input.repository.sshUrl,
  }) ? input.repository.sshUrl : null;

  if (cloneUrl) {
    targets.push({
      protocol: 'https',
      url: cloneUrl,
      isDefault: true,
    });
  }
  if (sshUrl) {
    targets.push({
      protocol: 'ssh',
      url: sshUrl,
    });
  }
  if (targets.length === 0) {
    throw createGithubRepositoryUnsupportedError('GitHub repository did not expose a safe clone target');
  }

  return {
    auth: input.auth,
    repository: {
      provider: input.repository.provider,
      nameWithOwner: input.repository.nameWithOwner,
      webUrl: input.repository.webUrl,
      ...(cloneUrl ? { cloneUrl } : {}),
      ...(sshUrl ? { sshUrl } : {}),
      visibility: input.repository.visibility,
      ...(input.repository.defaultBranch !== undefined ? { defaultBranch: input.repository.defaultBranch } : {}),
    },
    targets,
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
    if (!isRecoverableGithubRepositoryRestFailure(error)) throw error;
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
    describeCloneTargets(input: ScmHostingProviderRepositoryDescribeCloneTargetsInput) {
      const repositorySelector = parseNameWithOwner(input.repository.nameWithOwner);
      if (!repositorySelector) {
        throw createGithubRepositoryUnsupportedError('GitHub repository clone requires a valid owner/name selector');
      }

      const getRepositoryInput = {
        provider: input.provider,
        owner: repositorySelector.owner,
        repositoryName: repositorySelector.repositoryName,
        ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
      };
      return runWithAuthChain({
        provider: input.provider,
        operationName: 'describeCloneTargets',
        runRest: async () => {
          const repository = restAdapter.getRepository
            ? await restAdapter.getRepository(getRepositoryInput)
            : null;
          if (!repository) throw createGithubRepositoryNotFoundError();
          return describeRepositoryCloneTargets({
            provider: input.provider,
            repository,
            auth: { state: 'authenticated', profileKind: 'connected_account' },
          });
        },
        runCli: async () => {
          const repository = cliAdapter.getRepository
            ? await cliAdapter.getRepository(getRepositoryInput)
            : null;
          if (!repository) throw createGithubRepositoryNotFoundError();
          return describeRepositoryCloneTargets({
            provider: input.provider,
            repository,
            auth: { state: 'authenticated', profileKind: 'provider_cli' },
          });
        },
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
