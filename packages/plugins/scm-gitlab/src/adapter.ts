import type { ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  HostingProviderCompareUrlInput as ScmHostingProviderCompareUrlInput,
  HostingProviderRemoteDetectionInput as ScmHostingProviderRemoteDetectionInput,
  HostingProviderRoutingCapability as ScmHostingProviderRoutingCapability,
} from '@happier-dev/plugin-sdk/scm/hosting';

import { GITLAB_PLUGIN_ID } from './triage/contribution.js';
import { encodeCompareRef, parseScmRemoteUrl, stripTrailingSlash } from './remoteUrl.js';

export const GITLAB_SCM_HOSTING_PROVIDER_LOCAL_ID = 'gitlab';
export const GITLAB_SCM_HOSTING_PROVIDER_ID = `${GITLAB_PLUGIN_ID}/${GITLAB_SCM_HOSTING_PROVIDER_LOCAL_ID}`;
export const GITLAB_REMOTE_HOST_MATCHERS = Object.freeze({
  exactHosts: Object.freeze(['gitlab.com']),
});
export const GITLAB_URL_SAFETY = Object.freeze({
  allowedSchemes: Object.freeze(['https:']),
  allowedBaseUrls: Object.freeze(GITLAB_REMOTE_HOST_MATCHERS.exactHosts.map((host) => `https://${host}`)),
  allowedOrigins: Object.freeze(GITLAB_REMOTE_HOST_MATCHERS.exactHosts.map((host) => `https://${host}`)),
});

export type GitlabScmHostingProviderAdapter = ScmHostingProviderRoutingCapability & Readonly<{
  detectRemote(input: ScmHostingProviderRemoteDetectionInput): ScmHostingProviderRef | null;
  buildCompareUrl(input: ScmHostingProviderCompareUrlInput): string | null;
}>;

type GitlabHostMatcher = (host: string) => boolean;

export type GitlabScmHostingProviderAdapterOptions = Readonly<{
  hostMatcher?: GitlabHostMatcher;
  exactHosts?: readonly string[];
}>;

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function createExactHostMatcher(exactHosts: readonly string[]): GitlabHostMatcher {
  const normalizedHosts = new Set(exactHosts.map(normalizeHost));
  return (host) => normalizedHosts.has(normalizeHost(host));
}

function readNameWithOwner(path: string): string | null {
  const segments = path.split('/').filter(Boolean);
  return segments.length >= 2 ? segments.join('/') : null;
}

function isSafeNameWithOwner(value: string): boolean {
  const segments = value.split('/');
  return segments.length >= 2 && segments.every((segment) => (
    segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && !segment.includes('?')
    && !segment.includes('#')
  ));
}

function readTrustedBaseUrl(provider: ScmHostingProviderRef, matchesHost: GitlabHostMatcher): string | null {
  try {
    const parsed = new URL(provider.baseUrl);
    if (parsed.protocol !== 'https:') return null;
    if (parsed.port || parsed.search || parsed.hash || !matchesHost(parsed.hostname)) return null;
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    if (pathSegments.some((segment) => segment === '.' || segment === '..')) return null;
    const pathPrefix = parsed.pathname.replace(/\/+$/, '');
    return `${parsed.origin}${pathPrefix}`;
  } catch {
    return null;
  }
}

export function createGitlabScmHostingProviderAdapter(
  options?: GitlabScmHostingProviderAdapterOptions,
): GitlabScmHostingProviderAdapter {
  const matchesHost = options?.hostMatcher
    ?? createExactHostMatcher(options?.exactHosts ?? GITLAB_REMOTE_HOST_MATCHERS.exactHosts);

  return Object.freeze({
    detectRemote(input: ScmHostingProviderRemoteDetectionInput) {
      const parsed = parseScmRemoteUrl(input.remoteUrl);
      if (!parsed || !matchesHost(parsed.host)) return null;
      const nameWithOwner = readNameWithOwner(parsed.path);
      if (!nameWithOwner) return null;
      const baseUrl = `https://${parsed.host}`;
      const urlSafety = {
        allowedSchemes: ['https:'],
        allowedBaseUrls: [baseUrl],
        allowedOrigins: [baseUrl],
      };
      return {
        id: GITLAB_SCM_HOSTING_PROVIDER_ID,
        kind: 'gitlab' as const,
        displayName: 'GitLab',
        baseUrl,
        nameWithOwner,
        repositoryWebUrl: `${baseUrl}/${nameWithOwner}`,
        remoteName: input.remoteName ?? undefined,
        urlSafety,
      };
    },
    buildCompareUrl(input: ScmHostingProviderCompareUrlInput) {
      const { provider } = input;
      if (
        provider.id !== GITLAB_SCM_HOSTING_PROVIDER_ID
        || provider.kind !== 'gitlab'
        || !provider.nameWithOwner
        || !isSafeNameWithOwner(provider.nameWithOwner)
      ) {
        return null;
      }
      const baseUrl = readTrustedBaseUrl(provider, matchesHost);
      if (!baseUrl) return null;
      return `${stripTrailingSlash(baseUrl)}/${provider.nameWithOwner}/-/compare/${encodeCompareRef(input.base)}...${encodeCompareRef(input.head)}`;
    },
  });
}

export const gitlabHostingProviderAdapter = createGitlabScmHostingProviderAdapter();
