import type {
  HostingProviderRepositoryCreateInput as ScmHostingProviderRepositoryCreateInput,
  HostingProviderRepositoryDescribeCloneTargetsInput as ScmHostingProviderRepositoryDescribeCloneTargetsInput,
  HostingProviderRepositoryDescribePublishTargetsInput as ScmHostingProviderRepositoryDescribePublishTargetsInput,
  HostingProviderRepositoryDescribePublishTargetsResult as ScmHostingProviderRepositoryDescribePublishTargetsResult,
  HostingProviderRepositoryGetInput as ScmHostingProviderRepositoryGetInput,
} from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ScmHostingRepositoryAuthSummary,
  ScmHostingRepositorySummary,
  ScmRepositoryCloneTarget,
  ScmRepositoryCloneTargetDescription,
} from '@happier-dev/plugin-sdk/scm';
import type {
  ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';

import { githubHostingProviderAdapter } from '../adapter.js';
import { parseScmRemoteUrl } from '../remoteUrl.js';
import {
  createGithubRepositoryAuthRequiredError,
  createGithubRepositoryNotFoundError,
  createGithubRepositoryUnsupportedError,
  isGithubRepositoryAuthRequiredError,
} from './githubRepositoryErrors.js';
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

/**
 * The bound GitHub Connected Account is the sole authenticated authority for
 * repository reads and mutations. A host with no qualified Connected Account
 * path — every non-`github.com` host, including GitHub Enterprise — is refused
 * typed rather than executed with whatever credentials happen to be present on
 * the machine.
 */
function requireBoundAccountHost(provider: ScmHostingProviderRef): void {
  if (shouldTryRest(provider)) return;
  throw createGithubRepositoryAuthRequiredError(
    'GitHub repository operations require a bound github.com Connected Account; '
    + 'this host has no qualified GitHub Connected Account.',
  );
}

export function createGithubRepositoryProvisioningAdapter(params?: Readonly<{
  restAdapter?: Partial<GithubRepositoryRestAdapter>;
}>): GithubRepositoryProvisioningAdapter {
  const restAdapter = params?.restAdapter ?? createGithubRepositoryRestAdapter();

  return Object.freeze({
    ...githubHostingProviderAdapter,
    async describePublishTargets(input: ScmHostingProviderRepositoryDescribePublishTargetsInput) {
      if (!shouldTryRest(input.provider) || !restAdapter.describePublishTargets) {
        return createNoAuthTargetDiscoveryResult();
      }
      try {
        return await restAdapter.describePublishTargets(input);
      } catch (error) {
        if (isGithubRepositoryAuthRequiredError(error)) {
          return createNoAuthTargetDiscoveryResult();
        }
        throw error;
      }
    },
    async describeCloneTargets(input: ScmHostingProviderRepositoryDescribeCloneTargetsInput) {
      requireBoundAccountHost(input.provider);
      const repositorySelector = parseNameWithOwner(input.repository.nameWithOwner);
      if (!repositorySelector) {
        throw createGithubRepositoryUnsupportedError('GitHub repository clone requires a valid owner/name selector');
      }
      const repository = restAdapter.getRepository
        ? await restAdapter.getRepository({
            provider: input.provider,
            owner: repositorySelector.owner,
            repositoryName: repositorySelector.repositoryName,
            ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
          })
        : null;
      if (!repository) throw createGithubRepositoryNotFoundError();
      return describeRepositoryCloneTargets({
        provider: input.provider,
        repository,
        auth: { state: 'authenticated', profileKind: 'connected_account' },
      });
    },
    async createRepository(input: ScmHostingProviderRepositoryCreateInput) {
      requireBoundAccountHost(input.provider);
      if (!restAdapter.createRepository) throw createGithubRepositoryAuthRequiredError();
      return await restAdapter.createRepository(input);
    },
    async getRepository(input: ScmHostingProviderRepositoryGetInput) {
      requireBoundAccountHost(input.provider);
      if (!restAdapter.getRepository) throw createGithubRepositoryAuthRequiredError();
      return await restAdapter.getRepository(input);
    },
  });
}

export const githubRepositoryProvisioningAdapter = createGithubRepositoryProvisioningAdapter();
