import {
  requestForgeJson,
  type ForgeHttpErrorMapper,
  type ForgeHttpFetcher,
  type ForgeHttpResponse,
} from '@happier-dev/plugin-sdk/scm/hosting';
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';

import { getGithubAccountRequestOwnerV1, type GithubApiMethodV1, type GithubApiResponseV1 } from './githubApiClient.js';

// The Forge boundary intentionally exposes only headers.get, including in HTTP
// test adapters. Carry the evidence its existing error mapper can consume.
const FORGE_RESPONSE_EVIDENCE_HEADERS = [
  'retry-after',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-resource',
  'x-accepted-github-permissions',
] as const;

async function readResponseText(response: ForgeHttpResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    try {
      return JSON.stringify(await response.json()) ?? '';
    } catch (error) {
      if (response.ok) throw error;
      return '';
    }
  }
}

type GithubAccountForgeRequestV1 = Readonly<{
  url: string;
  method?: GithubApiMethodV1;
  headers: Readonly<Record<string, string>>;
  body?: string;
  signal?: AbortSignal;
  auth: Readonly<{ token?: string; profileKey?: string; account?: ConnectedAccountRef }>;
  executionOrigin: string;
  lifetime: object;
  fetcher: ForgeHttpFetcher;
  readOnlyGraphql?: boolean;
}>;

/** Both Forge JSON and GraphQL consume the same admitted account HTTP transport. */
export function requestGithubAccountForgeResponseV1(input: GithubAccountForgeRequestV1): Promise<GithubApiResponseV1> {
  const account = input.auth.account;
  const identified = account !== undefined;
  const owner = getGithubAccountRequestOwnerV1({
    accountScope: account
      ? JSON.stringify([account.service.pluginId, account.service.localId, account.accountId])
      : input.auth.token ? 'unidentified' : 'anonymous',
    credentialScope: input.auth.token ? `Bearer ${input.auth.token}` : '',
    executionOrigin: input.executionOrigin,
    ...(identified ? { fallbackLifetime: input.lifetime } : { lifetime: input.lifetime }),
  });
  return owner.request({
    url: input.url,
    method: input.method,
    headers: input.headers,
    ...(input.body !== undefined ? { body: new TextEncoder().encode(input.body) } : {}),
    ...(input.readOnlyGraphql === true ? { readOnlyGraphql: true } : {}),
    redirect: 'follow',
  }, {
    ...(input.signal ? { signal: input.signal } : {}),
    transport: async (request, signal) => {
      const fetched = await input.fetcher(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body !== undefined ? { body: new TextDecoder().decode(request.body) } : {}),
        redirect: request.redirect,
        signal,
      });
      const headers: Record<string, string> = {};
      for (const name of FORGE_RESPONSE_EVIDENCE_HEADERS) {
        const value = fetched.headers?.get(name);
        if (typeof value === 'string') headers[name] = value;
      }
      return {
        status: fetched.status,
        statusText: fetched.statusText,
        headers,
        body: new TextEncoder().encode(await readResponseText(fetched)),
      };
    },
  });
}

/** Keeps the existing Forge result/error contract over the one GitHub request owner. */
export function requestGithubAccountForgeJsonV1(input: GithubAccountForgeRequestV1 & Readonly<{
  mapError: ForgeHttpErrorMapper;
}>): Promise<unknown> {
  return requestForgeJson({
    url: input.url,
    init: {
      method: input.method,
      headers: input.headers,
      ...(input.body !== undefined ? { body: input.body } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    },
    fetcher: async () => {
      const response = await requestGithubAccountForgeResponseV1(input);
      const text = new TextDecoder().decode(response.body);
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        statusText: response.statusText ?? '',
        headers: new Headers(response.headers),
        json: async () => {
          const decoded: unknown = JSON.parse(text);
          return decoded;
        },
        text: async () => text,
      };
    },
    mapError: input.mapError,
  });
}
