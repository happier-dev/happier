import type {
  ScmHostingProviderRef,
  ScmPullRequestSummary,
} from '@happier-dev/protocol';
import type { ScmHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk';

import { readBitbucketRepositoryCoordinates } from '../parsing/bitbucketCoordinates.js';
import {
  createBitbucketAlreadyExistsError,
  createBitbucketAuthRequiredError,
  createBitbucketCommandFailedError,
  createBitbucketNotFoundError,
} from './errors.js';
import { mapBitbucketPullRequest } from './mapping.js';

export type BitbucketRestResponse = Readonly<{
  ok: boolean;
  status: number;
  statusText: string;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export type BitbucketRestFetcher = (url: string, init?: RequestInit) => Promise<BitbucketRestResponse>;

export type BitbucketBasicAuthMaterialization = Readonly<{
  username: string;
  password: string;
  profileKey?: string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readNestedRecord(source: unknown, key: string): Record<string, unknown> | null {
  return isRecord(source) && isRecord(source[key]) ? source[key] as Record<string, unknown> : null;
}

function readNestedString(source: unknown, ...keys: readonly string[]): string | null {
  let current: unknown = source;
  for (const key of keys) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return typeof current === 'string' && current.trim().length > 0 ? current.trim() : null;
}

function encodeBasicCredential(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function headersFor(auth: BitbucketBasicAuthMaterialization): Record<string, string> {
  return {
    Accept: 'application/json',
    Authorization: encodeBasicCredential(auth.username, auth.password),
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

async function readResponseBody(response: BitbucketRestResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    try {
      return JSON.parse(await response.text());
    } catch {
      return null;
    }
  }
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

async function readBitbucketJson(
  provider: ScmHostingProviderRef,
  response: BitbucketRestResponse,
): Promise<unknown> {
  if (response.ok) return response.json();
  const body = await readResponseBody(response);
  if (response.status === 401 || response.status === 403) {
    throw createBitbucketAuthRequiredError('Bitbucket API authentication failed');
  }
  if (response.status === 404) {
    throw createBitbucketNotFoundError();
  }
  if (response.status === 409 || response.status === 400) {
    if (bodyLooksLikeDuplicatePullRequest(body)) {
      const pullRequest = readDuplicatePullRequest(provider, body);
      throw createBitbucketAlreadyExistsError({
        ...(pullRequest ? { pullRequest } : {}),
      });
    }
    if (bodyLooksLikeAlreadyExists(body)) {
      throw createBitbucketAlreadyExistsError();
    }
  }
  throw createBitbucketCommandFailedError(`Bitbucket API request failed with status ${response.status || response.statusText}`);
}

export async function requestBitbucketJson(input: Readonly<{
  provider: ScmHostingProviderRef;
  fetcher: BitbucketRestFetcher;
  auth: BitbucketBasicAuthMaterialization;
  url: string;
  init?: Omit<RequestInit, 'headers'>;
}>): Promise<unknown> {
  return readBitbucketJson(input.provider, await input.fetcher(input.url, {
    ...input.init,
    headers: headersFor(input.auth),
  }));
}
