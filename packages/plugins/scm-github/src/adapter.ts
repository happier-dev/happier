import type { ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  HostingProviderCompareUrlInput as ScmHostingProviderCompareUrlInput,
  HostingProviderRemoteDetectionInput as ScmHostingProviderRemoteDetectionInput,
  HostingProviderRuntimeAdapter as ScmHostingProviderRuntimeAdapter,
} from '@happier-dev/plugin-sdk/scm/hosting';

import { GITHUB_PLUGIN_ID } from './observations/githubProviderContracts.js';
import { encodeCompareRef, parseScmRemoteUrl, stripTrailingSlash } from './remoteUrl.js';

export const GITHUB_SCM_HOSTING_PROVIDER_LOCAL_ID = 'github';
export const GITHUB_SCM_HOSTING_PROVIDER_ID = `${GITHUB_PLUGIN_ID}/${GITHUB_SCM_HOSTING_PROVIDER_LOCAL_ID}`;
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

function readTrustedBaseUrl(baseUrl: string, matchesHost: GithubHostMatcher): string | null {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:' || parsed.pathname.replace(/\/+$/, '') !== '') return null;
    if (parsed.username || parsed.password || parsed.port || parsed.search || parsed.hash || !matchesHost(parsed.hostname)) return null;
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
  const defaultHosts = options?.exactHosts ?? (options?.hostMatcher ? [] : GITHUB_REMOTE_HOST_MATCHERS.exactHosts);
  const admittedBases = (connectedAccountBases: readonly string[] = []) => new Set([
    ...defaultHosts.map((host) => readTrustedBaseUrl(`https://${host}`, matchesHost)),
    ...connectedAccountBases.map((base) => readTrustedBaseUrl(base, () => true)),
  ].filter((base): base is string => base !== null));

  return Object.freeze({
    listDeployments(input: Readonly<{ connectedAccountBases?: readonly string[] }>) {
      return [...admittedBases(input.connectedAccountBases)].map((baseUrl) => ({
        id: GITHUB_SCM_HOSTING_PROVIDER_ID, kind: 'github' as const, displayName: 'GitHub', baseUrl,
      }));
    },
    detectRemote(input: ScmHostingProviderRemoteDetectionInput) {
      const parsed = parseScmRemoteUrl(input.remoteUrl);
      if (!parsed || (!matchesHost(parsed.host) && !admittedBases(input.connectedAccountBases).has(`https://${parsed.host}`))) return null;
      // An exactly matched host is the binding's own origin, which carries no port. A ported
      // remote names a different endpoint and must never be re-spelled as `https://<host>`.
      if (parsed.syntax === 'url' && parsed.port !== null) return null;
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
      const baseUrl = readTrustedBaseUrl(provider.baseUrl, (host) => matchesHost(host)
        || admittedBases(input.connectedAccountBases).has(`https://${host}`));
      if (!baseUrl) return null;
      return `${stripTrailingSlash(baseUrl)}/${provider.nameWithOwner}/compare/${encodeCompareRef(input.base)}...${encodeCompareRef(input.head)}`;
    },
  });
}

export const githubHostingProviderAdapter = createGithubScmHostingProviderAdapter();
