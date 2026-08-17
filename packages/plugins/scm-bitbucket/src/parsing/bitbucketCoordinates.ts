import type { ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import { readTrimmedString as readString } from '@happier-dev/plugin-sdk';

import { createBitbucketInvalidRequestError } from '../operations/errors.js';

export type BitbucketRepositoryCoordinates = Readonly<{
  host: string;
  apiBaseUrl: string;
  workspace: string;
  repository: string;
  nameWithOwner: string;
}>;

const BITBUCKET_CLOUD_HOST = 'bitbucket.org';
const BITBUCKET_CLOUD_API_BASE_URL = 'https://api.bitbucket.org/2.0';

function normalizeRootHttpsUrl(value: string, fieldName: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw createBitbucketInvalidRequestError(`Invalid Bitbucket ${fieldName}`);
  }
  if (
    parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.search
    || parsed.hash
  ) {
    throw createBitbucketInvalidRequestError(`Invalid Bitbucket ${fieldName}`);
  }
  return parsed;
}

function readApiBaseUrl(provider: ScmHostingProviderRef, host: string): string {
  const providerApiBaseUrl = readString((provider as { apiBaseUrl?: unknown }).apiBaseUrl);
  if (!providerApiBaseUrl) {
    if (host !== BITBUCKET_CLOUD_HOST) {
      throw createBitbucketInvalidRequestError('Bitbucket API base URL is unavailable for this host');
    }
    return BITBUCKET_CLOUD_API_BASE_URL;
  }
  const parsed = normalizeRootHttpsUrl(providerApiBaseUrl, 'API base URL');
  if (parsed.pathname.replace(/\/+$/, '') !== '/2.0') {
    throw createBitbucketInvalidRequestError('Bitbucket API base URL must point at the 2.0 API root');
  }
  return parsed.href.replace(/\/+$/, '');
}

export function readBitbucketRepositoryCoordinates(
  provider: ScmHostingProviderRef,
): BitbucketRepositoryCoordinates {
  if (provider.kind !== 'bitbucket') {
    throw createBitbucketInvalidRequestError('Provider is not Bitbucket');
  }
  const parsedBase = normalizeRootHttpsUrl(provider.baseUrl, 'base URL');
  if (parsedBase.pathname.replace(/\/+$/, '') !== '') {
    throw createBitbucketInvalidRequestError('Bitbucket base URL must not include a path');
  }
  const host = parsedBase.hostname.toLowerCase();
  const nameWithOwner = readString(provider.nameWithOwner);
  if (!nameWithOwner) {
    throw createBitbucketInvalidRequestError('Bitbucket repository owner/name is unavailable');
  }
  const segments = nameWithOwner.split('/').map((segment) => segment.trim());
  if (segments.length !== 2 || !segments[0] || !segments[1]) {
    throw createBitbucketInvalidRequestError('Bitbucket repository owner/name must be workspace/repository');
  }
  const [workspace, repository] = segments as [string, string];
  return {
    host,
    apiBaseUrl: readApiBaseUrl(provider, host),
    workspace,
    repository,
    nameWithOwner: `${workspace}/${repository}`,
  };
}

export function encodeBitbucketPathSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

export function bitbucketRepositoryApiUrl(input: Readonly<{
  coordinates: BitbucketRepositoryCoordinates;
  workspace?: string;
  repository?: string;
}>): string {
  const workspace = input.workspace ?? input.coordinates.workspace;
  const repository = input.repository ?? input.coordinates.repository;
  return [
    input.coordinates.apiBaseUrl,
    'repositories',
    encodeBitbucketPathSegment(workspace),
    encodeBitbucketPathSegment(repository),
  ].join('/');
}

export function parseBitbucketPullRequestNumberFromUrl(
  provider: ScmHostingProviderRef,
  url: string,
): number | null {
  let coordinates: BitbucketRepositoryCoordinates;
  try {
    coordinates = readBitbucketRepositoryCoordinates(provider);
  } catch {
    return null;
  }
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:'
      || parsed.username
      || parsed.password
      || parsed.port
      || parsed.search
      || parsed.hash
      || parsed.hostname.toLowerCase() !== coordinates.host
    ) {
      return null;
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 4) return null;
    if (
      segments[0]?.toLowerCase() !== coordinates.workspace.toLowerCase()
      || segments[1]?.toLowerCase() !== coordinates.repository.toLowerCase()
      || segments[2] !== 'pull-requests'
    ) {
      return null;
    }
    const number = Number(segments[3]);
    return Number.isInteger(number) && number > 0 ? number : null;
  } catch {
    return null;
  }
}

export function buildBitbucketRepositoryWebUrl(input: Readonly<{
  provider: ScmHostingProviderRef;
  nameWithOwner: string;
}>): string {
  const parsedBase = normalizeRootHttpsUrl(input.provider.baseUrl, 'base URL');
  return `${parsedBase.origin}/${input.nameWithOwner}`;
}
