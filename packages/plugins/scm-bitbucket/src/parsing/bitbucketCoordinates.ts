import type { ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import { readTrimmedString as readString } from '@happier-dev/plugin-sdk';

import { createBitbucketInvalidRequestError } from '../operations/errors.js';
import { BITBUCKET_CLOUD_API_BASE_URL } from '../triage/apiUrl.js';
import { BITBUCKET_FORGE_HOST_ID, BITBUCKET_TRIAGE_DEPLOYMENT_BASE_URL_V1, readBitbucketRepositoryKey } from '../triage/identity.js';

export type BitbucketOriginCoordinates = Readonly<{
  host: string;
  apiBaseUrl: string;
}>;

export type BitbucketRepositoryCoordinates = BitbucketOriginCoordinates & Readonly<{
  workspace: string;
  repository: string;
  nameWithOwner: string;
}>;

const BITBUCKET_CLOUD_HOST = BITBUCKET_FORGE_HOST_ID;

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

function readApiBaseUrl(provider: ScmHostingProviderRef): string {
  const providerApiBaseUrl = (provider as { apiBaseUrl?: unknown }).apiBaseUrl;
  if (providerApiBaseUrl === undefined) return BITBUCKET_CLOUD_API_BASE_URL;
  if (providerApiBaseUrl !== BITBUCKET_CLOUD_API_BASE_URL) {
    throw createBitbucketInvalidRequestError('Bitbucket API base URL must be the Bitbucket Cloud 2.0 API root');
  }
  return BITBUCKET_CLOUD_API_BASE_URL;
}

export function readBitbucketOriginCoordinates(
  provider: ScmHostingProviderRef,
): BitbucketOriginCoordinates {
  if (provider.kind !== 'bitbucket') {
    throw createBitbucketInvalidRequestError('Provider is not Bitbucket');
  }
  const parsedBase = normalizeRootHttpsUrl(provider.baseUrl, 'base URL');
  if (parsedBase.pathname.replace(/\/+$/, '') !== '') {
    throw createBitbucketInvalidRequestError('Bitbucket base URL must not include a path');
  }
  const host = parsedBase.hostname.toLowerCase();
  if (host !== BITBUCKET_CLOUD_HOST || parsedBase.origin !== `https://${BITBUCKET_CLOUD_HOST}`) {
    throw createBitbucketInvalidRequestError('Bitbucket base URL must be the Bitbucket Cloud origin');
  }
  return { host, apiBaseUrl: readApiBaseUrl(provider) };
}

export function readBitbucketRepositoryCoordinates(
  provider: ScmHostingProviderRef,
): BitbucketRepositoryCoordinates {
  const origin = readBitbucketOriginCoordinates(provider);
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
    ...origin,
    workspace,
    repository,
    nameWithOwner: `${workspace}/${repository}`,
  };
}

export function encodeBitbucketPathSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

export function bitbucketRepositoryApiUrl(input: Readonly<{
  coordinates: Pick<BitbucketRepositoryCoordinates, 'apiBaseUrl' | 'workspace' | 'repository'>;
}>): string {
  return [
    input.coordinates.apiBaseUrl,
    'repositories',
    encodeBitbucketPathSegment(input.coordinates.workspace),
    encodeBitbucketPathSegment(input.coordinates.repository),
  ].join('/');
}

export function readBitbucketPullRequestUrl(url: string) {
  let parsed: URL;
  try { parsed = normalizeRootHttpsUrl(url, 'pull request URL'); } catch { return null; }
  if (parsed.origin !== BITBUCKET_TRIAGE_DEPLOYMENT_BASE_URL_V1) return null;
  const [workspace, repository, kind, entryId] = parsed.pathname.split('/').filter(Boolean);
  if (kind !== 'pull-requests' || entryId === undefined || !/^[1-9][0-9]*$/u.test(entryId)) return null;
  const route = readBitbucketRepositoryKey(`${workspace}/${repository}`);
  return route === null ? null : { ...route, entryId };
}

export function parseBitbucketPullRequestNumberFromUrl(
  provider: ScmHostingProviderRef,
  url: string,
): number | null {
  let coordinates: BitbucketRepositoryCoordinates;
  try { coordinates = readBitbucketRepositoryCoordinates(provider); } catch { return null; }
  const route = readBitbucketPullRequestUrl(url);
  if (route === null || route.repositoryKey !== coordinates.nameWithOwner.toLowerCase()) return null;
  const number = Number(route.entryId);
  return Number.isSafeInteger(number) ? number : null;
}

export function buildBitbucketRepositoryWebUrl(input: Readonly<{
  provider: ScmHostingProviderRef;
  nameWithOwner: string;
}>): string {
  const parsedBase = normalizeRootHttpsUrl(input.provider.baseUrl, 'base URL');
  return `${parsedBase.origin}/${input.nameWithOwner}`;
}
