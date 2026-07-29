import type { ScmHostingProviderRef } from '@happier-dev/plugin-sdk/experimental/scm';

import { PLUGIN_MANIFEST } from './manifest.js';
import { encodeCompareRef, parseScmRemoteUrl, stripTrailingSlash } from './remoteUrl.js';

export const BITBUCKET_SCM_HOSTING_PROVIDER_LOCAL_ID = 'bitbucket';
export const BITBUCKET_SCM_HOSTING_PROVIDER_ID = `${PLUGIN_MANIFEST.id}/${BITBUCKET_SCM_HOSTING_PROVIDER_LOCAL_ID}`;
export const BITBUCKET_REMOTE_HOST_MATCHERS = Object.freeze({
  exactHosts: Object.freeze(['bitbucket.org']),
});
export const BITBUCKET_URL_SAFETY = Object.freeze({
  allowedSchemes: Object.freeze(['https:']),
  allowedBaseUrls: Object.freeze(['https://bitbucket.org']),
  allowedOrigins: Object.freeze(['https://bitbucket.org']),
});

export type ScmHostingProviderDetectionInput = Readonly<{
  remoteName: string | null;
  remoteUrl: string;
}>;

export type ScmHostingProviderCompareUrlInput = Readonly<{
  provider: ScmHostingProviderRef;
  base: string;
  head: string;
}>;

export type BitbucketScmHostingProviderAdapter = Readonly<{
  detectRemote(input: ScmHostingProviderDetectionInput): ScmHostingProviderRef | null;
  buildCompareUrl(input: ScmHostingProviderCompareUrlInput): string | null;
}>;

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

function readTrustedBaseUrl(provider: ScmHostingProviderRef): string | null {
  try {
    const parsed = new URL(provider.baseUrl);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'bitbucket.org') return null;
    if (parsed.port || parsed.pathname.replace(/\/+$/, '') !== '' || parsed.search || parsed.hash) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export const bitbucketHostingProviderAdapter: BitbucketScmHostingProviderAdapter = Object.freeze({
  detectRemote(input) {
    const parsed = parseScmRemoteUrl(input.remoteUrl);
    if (!parsed || parsed.host !== 'bitbucket.org') return null;
    const nameWithOwner = readNameWithOwner(parsed.path);
    if (!nameWithOwner) return null;
    return {
      id: BITBUCKET_SCM_HOSTING_PROVIDER_ID,
      kind: 'bitbucket',
      displayName: 'Bitbucket',
      baseUrl: 'https://bitbucket.org',
      nameWithOwner,
      repositoryWebUrl: `https://bitbucket.org/${nameWithOwner}`,
      remoteName: input.remoteName ?? undefined,
      urlSafety: {
        allowedSchemes: ['https:'],
        allowedBaseUrls: ['https://bitbucket.org'],
        allowedOrigins: ['https://bitbucket.org'],
      },
    };
  },
  buildCompareUrl(input) {
    const { provider } = input;
    if (
      provider.id !== BITBUCKET_SCM_HOSTING_PROVIDER_ID
      || provider.kind !== 'bitbucket'
      || !provider.nameWithOwner
      || !isSafeNameWithOwner(provider.nameWithOwner)
    ) {
      return null;
    }
    const baseUrl = readTrustedBaseUrl(provider);
    if (!baseUrl) return null;
    return `${stripTrailingSlash(baseUrl)}/${provider.nameWithOwner}/branch/${encodeCompareRef(input.head)}?dest=${encodeCompareRef(input.base)}`;
  },
});
