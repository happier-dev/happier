import type { ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm';
import type {
  ScmHostingProviderCompareUrlInput,
  ScmHostingProviderRemoteDetectionInput,
  ScmHostingProviderRuntimeAdapter,
} from '@happier-dev/plugin-sdk';

import { encodeCompareRef, parseScmRemoteUrl, stripTrailingSlash } from './remoteUrl.js';

export const GITHUB_SCM_HOSTING_PROVIDER_ID = 'scm.github';
export const GITHUB_REMOTE_HOST_MATCHERS = Object.freeze({
  exactHosts: Object.freeze(['github.com']),
});
export const GITHUB_URL_SAFETY = Object.freeze({
  allowedSchemes: Object.freeze(['https:']),
  allowedBaseUrls: Object.freeze(GITHUB_REMOTE_HOST_MATCHERS.exactHosts.map((host) => `https://${host}`)),
  allowedOrigins: Object.freeze(GITHUB_REMOTE_HOST_MATCHERS.exactHosts.map((host) => `https://${host}`)),
});

export type GithubScmHostingProviderAdapter = ScmHostingProviderRuntimeAdapter & Readonly<{
  detectRemote(input: ScmHostingProviderRemoteDetectionInput): ScmHostingProviderRef | null;
  buildCompareUrl(input: ScmHostingProviderCompareUrlInput): string | null;
}>;

type GithubHostMatcher = (host: string) => boolean;

export type GithubScmHostingProviderAdapterOptions = Readonly<{
  hostMatcher?: GithubHostMatcher;
  exactHosts?: readonly string[];
}>;

function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

function createExactHostMatcher(exactHosts: readonly string[]): GithubHostMatcher {
  const normalizedHosts = new Set(exactHosts.map(normalizeHost));
  return (host) => normalizedHosts.has(normalizeHost(host));
}

function readNameWithOwner(path: string): string | null {
  const segments = path.split('/').filter(Boolean);
  return segments.length === 2 ? segments.join('/') : null;
}

function isSafeNameWithOwner(value: string): boolean {
  const segments = value.split('/');
  return segments.length === 2 && segments.every((segment) => (
    segment.length > 0
    && segment !== '.'
    && segment !== '..'
    && !segment.includes('?')
    && !segment.includes('#')
  ));
}

function readTrustedBaseUrl(provider: ScmHostingProviderRef, matchesHost: GithubHostMatcher): string | null {
  try {
    const parsed = new URL(provider.baseUrl);
    if (parsed.protocol !== 'https:' || parsed.pathname.replace(/\/+$/, '') !== '') return null;
    if (parsed.port || parsed.search || parsed.hash || !matchesHost(parsed.hostname)) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export function createGithubScmHostingProviderAdapter(
  options?: GithubScmHostingProviderAdapterOptions,
): GithubScmHostingProviderAdapter {
  const matchesHost = options?.hostMatcher
    ?? createExactHostMatcher(options?.exactHosts ?? GITHUB_REMOTE_HOST_MATCHERS.exactHosts);

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
        id: GITHUB_SCM_HOSTING_PROVIDER_ID,
        kind: 'github' as const,
        displayName: 'GitHub',
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
        provider.id !== GITHUB_SCM_HOSTING_PROVIDER_ID
        || provider.kind !== 'github'
        || !provider.nameWithOwner
        || !isSafeNameWithOwner(provider.nameWithOwner)
      ) {
        return null;
      }
      const baseUrl = readTrustedBaseUrl(provider, matchesHost);
      if (!baseUrl) return null;
      return `${stripTrailingSlash(baseUrl)}/${provider.nameWithOwner}/compare/${encodeCompareRef(input.base)}...${encodeCompareRef(input.head)}`;
    },
  });
}

export const githubHostingProviderAdapter = createGithubScmHostingProviderAdapter();
