import type {
  ForgeHttpErrorContext as ScmForgeHttpErrorContext,
  ForgeHttpFetcher as ScmForgeHttpFetcher,
  ForgeHttpResponse as ScmForgeHttpResponse,
  ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/scm';
import { requestForgeJson as requestScmForgeJson } from '@happier-dev/plugin-sdk/scm/hosting';
import type { HostingProviderRuntimeServices as ScmHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting';
import { isRecord, readTrimmedString as readString } from '@happier-dev/plugin-sdk';

import { readBitbucketRepositoryCoordinates } from '../parsing/bitbucketCoordinates.js';
import { encodeBitbucketBasicAuthorization } from '../auth/basicCredentials.js';
import {
  createBitbucketAlreadyExistsError,
  createBitbucketAuthRequiredError,
  createBitbucketCommandFailedError,
  createBitbucketNotFoundError,
} from './errors.js';
import { mapBitbucketPullRequest } from './mapping.js';

export type BitbucketRestResponse = ScmForgeHttpResponse;

export type BitbucketRestFetcher = ScmForgeHttpFetcher;

export type BitbucketBasicAuthMaterialization = Readonly<{
  username: string;
  password: string;
  profileKey?: string;
}>;

function readNestedRecord(source: unknown, key: string): Record<string, unknown> | null {
  return isRecord(source) && isRecord(source[key]) ? source[key] as Record<string, unknown> : null;
}

function readNestedString(source: unknown, ...keys: readonly string[]): string | null {
  let current: unknown = source;
  for (const key of keys) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return readString(current);
}

function headersFor(auth: BitbucketBasicAuthMaterialization): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: encodeBitbucketBasicAuthorization({
      username: auth.username,
      password: auth.password,
    }),
    'Content-Type': 'application/json',
  };
}

export async function resolveBitbucketBasicAuth(input: Readonly<{
  provider: ScmHostingProviderRef;
  runtimeServices?: ScmHostingProviderRuntimeServices;
}>): Promise<BitbucketBasicAuthMaterialization> {
  const coordinates = readBitbucketRepositoryCoordinates(input.provider);
  const materialize = input.runtimeServices?.resolveScmHostingBasicAuthMaterialization;
  if (!materialize) throw createBitbucketAuthRequiredError();
  const result = await materialize({
    kind: 'scm_hosting_basic_auth',
    providerId: input.provider.id,
    host: coordinates.host,
    provider: input.provider,
  });
  if (result.kind !== 'available' || !result.username.trim() || !result.password.trim()) {
    throw createBitbucketAuthRequiredError();
  }
  return {
    username: result.username.trim(),
    password: result.password,
    ...(result.profileKey ? { profileKey: result.profileKey } : {}),
  };
}

function bodyLooksLikeDuplicatePullRequest(body: unknown): boolean {
  const message = readNestedString(body, 'error', 'message')
    ?? (isRecord(body) && typeof body.error === 'string' ? body.error : null)
    ?? (isRecord(body) && typeof body.message === 'string' ? body.message : null);
  return Boolean(message && /\b(already|existing|duplicate)\b/i.test(message) && /\bpull request\b/i.test(message));
}

function bodyLooksLikeAlreadyExists(body: unknown): boolean {
  const message = readNestedString(body, 'error', 'message')
    ?? (isRecord(body) && typeof body.error === 'string' ? body.error : null)
    ?? (isRecord(body) && typeof body.message === 'string' ? body.message : null);
  return Boolean(message && /\b(already exists|already in use|duplicate)\b/i.test(message));
}

function readDuplicatePullRequest(
  provider: ScmHostingProviderRef,
  body: unknown,
): ScmPullRequestSummary | null {
  return mapBitbucketPullRequest(
    provider,
    readNestedRecord(body, 'pullrequest') ?? readNestedRecord(body, 'pullRequest'),
  );
}

function mapBitbucketApiError(
  provider: ScmHostingProviderRef,
  context: ScmForgeHttpErrorContext,
): Error {
  if (context.status === 401 || context.status === 403) {
    throw createBitbucketAuthRequiredError('Bitbucket API authentication failed');
  }
  if (context.status === 404) {
    throw createBitbucketNotFoundError();
  }
  if (context.status === 409 || context.status === 400) {
    if (bodyLooksLikeDuplicatePullRequest(context.body)) {
      const pullRequest = readDuplicatePullRequest(provider, context.body);
      throw createBitbucketAlreadyExistsError({
        ...(pullRequest ? { pullRequest } : {}),
      });
    }
    if (bodyLooksLikeAlreadyExists(context.body)) {
      throw createBitbucketAlreadyExistsError();
    }
  }
  throw createBitbucketCommandFailedError(`Bitbucket API request failed with status ${context.status || context.statusText}`);
}

export async function requestBitbucketJson(input: Readonly<{
  provider: ScmHostingProviderRef;
  fetcher: BitbucketRestFetcher;
  auth: BitbucketBasicAuthMaterialization;
  url: string;
  init?: Omit<RequestInit, 'headers'>;
  signal?: AbortSignal;
}>): Promise<unknown> {
  return requestScmForgeJson({
    url: input.url,
    init: {
      ...input.init,
      ...(input.signal ? { signal: input.signal } : {}),
      headers: headersFor(input.auth),
    },
    fetcher: input.fetcher,
    mapError: (context) => mapBitbucketApiError(input.provider, context),
  });
}
