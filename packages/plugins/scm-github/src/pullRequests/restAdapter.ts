import type {
  ScmHostingProviderDefaultBranchInput,
  ScmHostingProviderDefaultBranchMetadata,
  ScmHostingProviderPullRequestCheckoutReferenceInput,
  ScmHostingProviderPullRequestCheckoutReferenceMetadata,
  ScmHostingProviderPullRequestCreateInput,
  ScmHostingProviderPullRequestGetInput,
  ScmHostingProviderPullRequestListInput,
  ScmHostingProviderRuntimeServices,
} from '@happier-dev/plugin-sdk/experimental/scm/hostingProvider';
import type {
  ScmHostingProviderRef,
  ScmForgeHttpErrorContext,
  ScmForgeHttpFetcher,
  ScmForgeHttpResponse,
  ScmPullRequestState,
  ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/experimental/scm';
import { requestScmForgeJson } from '@happier-dev/plugin-sdk/experimental/scm';

import { resolveGithubCheckoutReferenceFromPullRequest } from './checkoutReference.js';
import { mapGithubDefaultBranch } from './defaultBranch.js';
import {
  createGithubAuthRequiredError,
  createGithubCommandFailedError,
  createGithubNotFoundError,
} from './errors.js';
import { mapGithubPullRequest } from './mapping.js';

type GithubRestResponse = ScmForgeHttpResponse;

export type GithubRestFetcher = ScmForgeHttpFetcher;

export type GithubRestTokenResolution =
  | Readonly<{
    kind: 'available';
    token: string;
    profileKey?: string;
  }>
  | Readonly<{
    kind: 'missing';
    reason: string;
  }>;

export type GithubRestTokenResolver = (input: Readonly<{
  providerId: string;
  host: string;
  provider: ScmHostingProviderRef;
  runtimeServices?: ScmHostingProviderRuntimeServices;
}>) => Promise<GithubRestTokenResolution>;

export type GithubRestPullRequestAdapter = Readonly<{
  getPullRequestAuthProfileKey(input: Readonly<{ provider: ScmHostingProviderRef }>): string | null;
  listPullRequests(input: ScmHostingProviderPullRequestListInput): Promise<readonly ScmPullRequestSummary[]>;
  getPullRequest(input: ScmHostingProviderPullRequestGetInput): Promise<ScmPullRequestSummary | null>;
  createPullRequest(input: ScmHostingProviderPullRequestCreateInput): Promise<ScmPullRequestSummary>;
  getDefaultBranch(input: ScmHostingProviderDefaultBranchInput): Promise<ScmHostingProviderDefaultBranchMetadata>;
  resolvePullRequestCheckoutReference(
    input: ScmHostingProviderPullRequestCheckoutReferenceInput
  ): Promise<ScmHostingProviderPullRequestCheckoutReferenceMetadata>;
}>;

const GITHUB_DOT_COM_HOST = 'github.com';
const GITHUB_API_VERSION = '2022-11-28';

async function defaultRuntimeTokenResolver(input: Readonly<{
  providerId: string;
  host: string;
  provider: ScmHostingProviderRef;
  runtimeServices?: ScmHostingProviderRuntimeServices;
}>): Promise<GithubRestTokenResolution> {
  const resolver = input.runtimeServices?.resolveScmHostingTokenMaterialization;
  if (!resolver) {
    return { kind: 'missing', reason: 'credential_unavailable' };
  }
  const result = await resolver({
    kind: 'scm_hosting_token',
    providerId: input.providerId,
    host: input.host,
    provider: input.provider,
  });
  if (result.kind !== 'available') {
    return { kind: 'missing', reason: result.reason };
  }
  return {
    kind: 'available',
    token: result.token,
    ...(result.profileKey ? { profileKey: result.profileKey } : {}),
  };
}

function defaultFetcher(url: string, init?: RequestInit): Promise<GithubRestResponse> {
  return fetch(url, init);
}

function resolveProviderHost(provider: ScmHostingProviderRef): string {
  try {
    const parsed = new URL(provider.baseUrl);
    if (
      parsed.protocol !== 'https:'
      || parsed.port
      || parsed.pathname.replace(/\/+$/, '') !== ''
      || parsed.search
      || parsed.hash
    ) {
      return '';
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isGithubDotComProvider(provider: ScmHostingProviderRef): boolean {
  return resolveProviderHost(provider) === GITHUB_DOT_COM_HOST;
}

function requireNameWithOwner(provider: ScmHostingProviderRef): string {
  const value = provider.nameWithOwner?.trim();
  if (!value) {
    throw createGithubCommandFailedError('GitHub repository owner/name is unavailable');
  }
  return value.split('/').map((segment) => encodeURIComponent(segment)).join('/');
}

function readNameWithOwnerSegments(provider: ScmHostingProviderRef): readonly [string, string] | null {
  const value = provider.nameWithOwner?.trim();
  if (!value) return null;
  const segments = value.split('/');
  if (segments.length !== 2 || !segments[0]?.trim() || !segments[1]?.trim()) return null;
  return [segments[0].trim().toLowerCase(), segments[1].trim().toLowerCase()];
}

function apiBaseUrl(provider: ScmHostingProviderRef): string {
  if (!isGithubDotComProvider(provider)) {
    throw createGithubAuthRequiredError('GitHub connected-account REST tokens are scoped to github.com');
  }
  return 'https://api.github.com';
}

function pullsUrl(input: ScmHostingProviderPullRequestListInput): string {
  const params = new URLSearchParams({
    state: mapGithubRestState(input.state),
  });
  if (input.base) params.set('base', input.base);
  if (input.head) params.set('head', input.head);
  return `${apiBaseUrl(input.provider)}/repos/${requireNameWithOwner(input.provider)}/pulls?${params.toString()}`;
}

function pullUrl(input: Readonly<{ provider: ScmHostingProviderRef; number: number }>): string {
  return `${apiBaseUrl(input.provider)}/repos/${requireNameWithOwner(input.provider)}/pulls/${input.number}`;
}

function repositoryUrl(provider: ScmHostingProviderRef): string {
  return `${apiBaseUrl(provider)}/repos/${requireNameWithOwner(provider)}`;
}

function mapGithubRestState(state: ScmPullRequestState | undefined): string {
  if (state === 'closed' || state === 'merged') return 'closed';
  return 'open';
}

function buildHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
}

async function resolveToken(
  provider: ScmHostingProviderRef,
  resolver: GithubRestTokenResolver,
  runtimeServices?: ScmHostingProviderRuntimeServices,
): Promise<Readonly<{ token: string; profileKey?: string }>> {
  const host = resolveProviderHost(provider);
  if (host !== GITHUB_DOT_COM_HOST) {
    throw createGithubAuthRequiredError('GitHub connected-account REST tokens are scoped to github.com');
  }
  const result = await resolver({
    providerId: provider.id,
    host,
    provider,
    ...(runtimeServices ? { runtimeServices } : {}),
  });
  if (result.kind !== 'available' || !result.token.trim()) {
    throw createGithubAuthRequiredError();
  }
  return {
    token: result.token.trim(),
    ...(result.profileKey ? { profileKey: result.profileKey } : {}),
  };
}

function mapGithubRestError(context: ScmForgeHttpErrorContext): Error {
  if (context.status === 401 || context.status === 403) {
    throw createGithubAuthRequiredError('GitHub REST authentication failed');
  }
  if (context.status === 404) {
    throw createGithubNotFoundError();
  }
  throw createGithubCommandFailedError(`GitHub REST request failed with status ${context.status || context.statusText}`);
}

function readPullRequestNumberFromProviderUrl(provider: ScmHostingProviderRef, url: string): number | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== resolveProviderHost(provider)) return null;
    const nameWithOwner = readNameWithOwnerSegments(provider);
    if (!nameWithOwner) return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length < 4) return null;
    if (segments[0]?.toLowerCase() !== nameWithOwner[0] || segments[1]?.toLowerCase() !== nameWithOwner[1]) return null;
    if (segments[2] !== 'pull') return null;
    const number = Number(segments[3]);
    return Number.isInteger(number) && number > 0 ? number : null;
  } catch {
    return null;
  }
}

function readReferenceNumber(input: ScmHostingProviderPullRequestGetInput): number | null {
  const reference = input.reference as Readonly<{
    number?: unknown;
    url?: unknown;
  }>;
  if (typeof reference.number === 'number') return reference.number;
  if (typeof reference.url === 'string') return readPullRequestNumberFromProviderUrl(input.provider, reference.url);
  return null;
}

function providerAuthProfileScopeKey(provider: ScmHostingProviderRef): string {
  return [
    provider.id,
    provider.kind,
    provider.baseUrl,
    provider.nameWithOwner ?? '',
  ].join('\0');
}

export function createGithubRestAdapter(params?: Readonly<{
  fetcher?: GithubRestFetcher;
  resolveToken?: GithubRestTokenResolver;
}>): GithubRestPullRequestAdapter {
  const fetcher = params?.fetcher ?? defaultFetcher;
  const tokenResolver = params?.resolveToken ?? defaultRuntimeTokenResolver;
  const profileKeyByProvider = new Map<string, string | null>();

  async function requestJson(
    provider: ScmHostingProviderRef,
    url: string,
    init?: Omit<RequestInit, 'headers'>,
    runtimeServices?: ScmHostingProviderRuntimeServices,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const auth = await resolveToken(provider, tokenResolver, runtimeServices);
    profileKeyByProvider.set(providerAuthProfileScopeKey(provider), auth.profileKey ?? null);
    return requestScmForgeJson({
      url,
      init: {
        ...init,
        ...(signal ? { signal } : {}),
        headers: buildHeaders(auth.token),
      },
      fetcher,
      mapError: mapGithubRestError,
    });
  }

  async function getPullRequest(input: ScmHostingProviderPullRequestGetInput): Promise<ScmPullRequestSummary | null> {
    const number = readReferenceNumber(input);
    if (number) {
      const raw = await requestJson(input.provider, pullUrl({ provider: input.provider, number }), { method: 'GET' }, input.runtimeServices, input.signal);
      return mapGithubPullRequest(input.provider, raw);
    }
    const reference = input.reference as Readonly<{ headBranch?: unknown }>;
    if (typeof reference.headBranch === 'string') {
      const matches = await listPullRequests({
        provider: input.provider,
        head: reference.headBranch,
        state: 'open',
        ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return matches[0] ?? null;
    }
    return null;
  }

  async function listPullRequests(input: ScmHostingProviderPullRequestListInput): Promise<readonly ScmPullRequestSummary[]> {
    const raw = await requestJson(input.provider, pullsUrl(input), { method: 'GET' }, input.runtimeServices, input.signal);
    return (Array.isArray(raw) ? raw : [])
      .map((item) => mapGithubPullRequest(input.provider, item))
      .filter((item): item is ScmPullRequestSummary => item !== null);
  }

  return Object.freeze({
    getPullRequestAuthProfileKey(input) {
      return profileKeyByProvider.get(providerAuthProfileScopeKey(input.provider)) ?? null;
    },
    listPullRequests,
    getPullRequest,
    async createPullRequest(input) {
      const raw = await requestJson(
        input.provider,
        `${apiBaseUrl(input.provider)}/repos/${requireNameWithOwner(input.provider)}/pulls`,
        {
          method: 'POST',
          body: JSON.stringify({
            base: input.base,
            head: input.head,
            title: input.title,
            body: input.body ?? '',
            ...(input.draft ? { draft: true } : {}),
          }),
        },
        input.runtimeServices,
        input.signal,
      );
      const pullRequest = mapGithubPullRequest(input.provider, raw);
      if (!pullRequest) throw createGithubCommandFailedError('GitHub returned an invalid pull request payload');
      return pullRequest;
    },
    async getDefaultBranch(input) {
      const raw = await requestJson(input.provider, repositoryUrl(input.provider), { method: 'GET' }, input.runtimeServices, input.signal);
      const mapped = mapGithubDefaultBranch(raw);
      if (!mapped) throw createGithubCommandFailedError('GitHub returned an invalid repository payload');
      return mapped;
    },
    async resolvePullRequestCheckoutReference(input) {
      const pullRequest = await getPullRequest(input);
      if (!pullRequest) throw createGithubNotFoundError();
      return resolveGithubCheckoutReferenceFromPullRequest(pullRequest);
    },
  });
}
