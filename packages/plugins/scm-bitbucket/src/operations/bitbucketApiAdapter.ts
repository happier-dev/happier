import type {
  HostingProviderPullRequestCheckoutReferenceInput as ScmHostingProviderPullRequestCheckoutReferenceInput,
  HostingProviderPullRequestCheckoutReferenceMetadata as ScmHostingProviderPullRequestCheckoutReferenceMetadata,
  HostingProviderPullRequestCreateInput as ScmHostingProviderPullRequestCreateInput,
  HostingProviderPullRequestGetInput as ScmHostingProviderPullRequestGetInput,
  HostingProviderPullRequestListInput as ScmHostingProviderPullRequestListInput,
  HostingProviderRepositoryCreateInput as ScmHostingProviderRepositoryCreateInput,
  HostingProviderRepositoryDescribePublishTargetsInput as ScmHostingProviderRepositoryDescribePublishTargetsInput,
  HostingProviderRepositoryDescribePublishTargetsResult as ScmHostingProviderRepositoryDescribePublishTargetsResult,
  HostingProviderRepositoryGetInput as ScmHostingProviderRepositoryGetInput,
  HostingProviderRuntimeAdapter as ScmHostingProviderRuntimeAdapter,
  HostingProviderRuntimeServices as ScmHostingProviderRuntimeServices,
} from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ScmHostingRepositoryAuthSummary,
  ScmHostingRepositoryPublishTarget,
  ScmHostingRepositorySummary,
  ScmPullRequestState,
  ScmPullRequestSummary,
} from '@happier-dev/plugin-sdk/scm';
import { isRecord, readTrimmedString as readString } from '@happier-dev/plugin-sdk';

import { bitbucketHostingProviderAdapter } from '../adapter.js';
import {
  bitbucketRepositoryApiUrl,
  parseBitbucketPullRequestNumberFromUrl,
  readBitbucketOriginCoordinates,
  readBitbucketRepositoryCoordinates,
} from '../parsing/bitbucketCoordinates.js';
import { readBitbucketApiUrl } from '../triage/apiUrl.js';
import { BITBUCKET_MAX_PULL_REQUEST_PAGE_LENGTH } from '../triage/pagination.js';
import { listBitbucketWorkspaces } from '../triage/pullRequests.js';
import {
  type BitbucketBasicAuthMaterialization,
  type BitbucketRestFetcher,
  requestBitbucketJson,
  resolveBitbucketBasicAuth,
} from './apiRequest.js';
import {
  findMatchingBitbucketPullRequest,
  isPullRequestSummary,
  matchesBitbucketBranchHeadContext,
} from './branchHeadContext.js';
import {
  createBitbucketCommandFailedError,
  createBitbucketInvalidRequestError,
  createBitbucketNotFoundError,
  isBitbucketAlreadyExistsError,
  isBitbucketNotFoundError,
} from './errors.js';
import {
  decodeBitbucketPullRequestList,
  mapBitbucketPullRequest,
  mapBitbucketRepositorySummary,
  resolveBitbucketCheckoutReferenceFromPullRequest,
} from './mapping.js';
export { decodeBitbucketPullRequestList } from './mapping.js';

export type BitbucketApiAdapter = typeof bitbucketHostingProviderAdapter & ScmHostingProviderRuntimeAdapter & Readonly<{
  getPullRequestAuthProfileKey(input: Readonly<{ provider: ScmHostingProviderRef }>): string | null;
  listPullRequests(input: ScmHostingProviderPullRequestListInput): Promise<readonly ScmPullRequestSummary[]>;
  getPullRequest(input: ScmHostingProviderPullRequestGetInput): Promise<ScmPullRequestSummary | null>;
  createPullRequest(input: ScmHostingProviderPullRequestCreateInput): Promise<ScmPullRequestSummary>;
  openOrReusePullRequest(input: ScmHostingProviderPullRequestCreateInput): Promise<Readonly<{
    pullRequest: ScmPullRequestSummary;
    reused: boolean;
  }>>;
  resolvePullRequestCheckoutReference(
    input: ScmHostingProviderPullRequestCheckoutReferenceInput
  ): Promise<ScmHostingProviderPullRequestCheckoutReferenceMetadata>;
  describePublishTargets(
    input: ScmHostingProviderRepositoryDescribePublishTargetsInput
  ): Promise<ScmHostingProviderRepositoryDescribePublishTargetsResult>;
  createRepository(input: ScmHostingProviderRepositoryCreateInput): Promise<ScmHostingRepositorySummary>;
  getRepository(input: ScmHostingProviderRepositoryGetInput): Promise<ScmHostingRepositorySummary | null>;
}>;

function defaultFetcher(url: string, init?: RequestInit) {
  return fetch(url, init);
}

function providerAuthProfileScopeKey(provider: ScmHostingProviderRef): string {
  return [
    provider.id,
    provider.kind,
    provider.baseUrl,
    provider.nameWithOwner ?? '',
  ].join('\0');
}

function mapListStatus(state: ScmPullRequestState | undefined): string {
  if (state === 'closed') return 'DECLINED';
  if (state === 'merged') return 'MERGED';
  return 'OPEN';
}

function pullRequestsUrl(input: ScmHostingProviderPullRequestListInput): string {
  const coordinates = readBitbucketRepositoryCoordinates(input.provider);
  const params = new URLSearchParams({
    state: mapListStatus(input.state),
  });
  const filters = [
    `source.branch.name = "${input.head}"`,
    ...(input.base ? [`destination.branch.name = "${input.base}"`] : []),
  ];
  params.set('q', filters.join(' AND '));
  params.set('pagelen', String(BITBUCKET_MAX_PULL_REQUEST_PAGE_LENGTH));
  return `${bitbucketRepositoryApiUrl({ coordinates })}/pullrequests?${params.toString()}`;
}

type BitbucketListNext =
  | Readonly<{ kind: 'end' }>
  | Readonly<{ kind: 'next'; url: string }>
  | Readonly<{ kind: 'invalid' }>;

function readPullRequestListNext(raw: unknown, seedUrl: string): BitbucketListNext {
  if (!isRecord(raw) || raw.next === undefined || raw.next === null) return { kind: 'end' };
  const candidate = readString(raw.next);
  const admitted = candidate === null ? null : readBitbucketApiUrl(candidate);
  if (admitted === null) return { kind: 'invalid' };
  const seed = new URL(seedUrl);
  const next = new URL(admitted);
  if (next.pathname !== seed.pathname) return { kind: 'invalid' };
  for (const key of ['state', 'q', 'pagelen'] as const) {
    const expected = seed.searchParams.getAll(key);
    const actual = next.searchParams.getAll(key);
    if (expected.length !== 1 || actual.length !== 1 || actual[0] !== expected[0]) {
      return { kind: 'invalid' };
    }
  }
  return { kind: 'next', url: admitted };
}

function pullRequestUrl(input: Readonly<{
  provider: ScmHostingProviderRef;
  number: number;
}>): string {
  const coordinates = readBitbucketRepositoryCoordinates(input.provider);
  return `${bitbucketRepositoryApiUrl({ coordinates })}/pullrequests/${input.number}`;
}

function readReferenceNumber(input: ScmHostingProviderPullRequestGetInput): number | null {
  const reference = input.reference as Readonly<{
    number?: unknown;
    url?: unknown;
  }>;
  if (typeof reference.number === 'number' && Number.isInteger(reference.number) && reference.number > 0) {
    return reference.number;
  }
  if (typeof reference.url === 'string') {
    return parseBitbucketPullRequestNumberFromUrl(input.provider, reference.url);
  }
  return null;
}

function authSummary(auth: BitbucketBasicAuthMaterialization): ScmHostingRepositoryAuthSummary {
  return {
    state: 'authenticated',
    profileKind: 'connected_account',
    ...(auth.profileKey ? { profileKey: auth.profileKey } : {}),
  };
}

function publishTarget(input: Readonly<{
  provider: ScmHostingProviderRef;
  auth: BitbucketBasicAuthMaterialization;
  owner: string;
  label?: string;
}>): ScmHostingRepositoryPublishTarget {
  return {
    provider: input.provider,
    owner: input.owner,
    ownerKind: 'org',
    label: input.label ?? input.owner,
    isDefault: true,
    supportedVisibilities: ['private', 'public'],
    supportedRemoteUrlKinds: ['https', 'ssh'],
    auth: authSummary(input.auth),
  };
}

function normalizeOwner(value: string): string {
  const owner = value.trim();
  if (!owner || owner.includes('/')) {
    throw createBitbucketInvalidRequestError('Bitbucket repository owner must be a workspace');
  }
  return owner;
}

function normalizeRepositoryName(value: string): string {
  const repositoryName = value.trim();
  if (!repositoryName || repositoryName.includes('/')) {
    throw createBitbucketInvalidRequestError('Bitbucket repository name must be a single path segment');
  }
  return repositoryName;
}

export function createBitbucketApiAdapter(params?: Readonly<{
  fetcher?: BitbucketRestFetcher;
}>): BitbucketApiAdapter {
  const fetcher = params?.fetcher ?? defaultFetcher;
  const profileKeyByProvider = new Map<string, string | null>();

  async function withAuth(input: Readonly<{
    provider: ScmHostingProviderRef;
    runtimeServices?: ScmHostingProviderRuntimeServices;
  }>): Promise<BitbucketBasicAuthMaterialization> {
    const auth = await resolveBitbucketBasicAuth(input);
    profileKeyByProvider.set(providerAuthProfileScopeKey(input.provider), auth.profileKey ?? null);
    return auth;
  }

  async function listPullRequests(
    input: ScmHostingProviderPullRequestListInput,
  ): Promise<readonly ScmPullRequestSummary[]> {
    const auth = await withAuth(input);
    const seedUrl = pullRequestsUrl(input);
    const seen = new Set<string>();
    const pullRequests: ScmPullRequestSummary[] = [];
    let nextUrl: string | null = seedUrl;
    while (nextUrl !== null) {
      if (seen.has(nextUrl)) {
        throw createBitbucketInvalidRequestError('Bitbucket pull-request pagination did not progress');
      }
      seen.add(nextUrl);
      const raw = await requestBitbucketJson({
        provider: input.provider,
        fetcher,
        auth,
        url: nextUrl,
        init: { method: 'GET' },
        signal: input.signal,
      });
      pullRequests.push(...decodeBitbucketPullRequestList(input.provider, raw).pullRequests);
      const continuation = readPullRequestListNext(raw, seedUrl);
      if (continuation.kind === 'invalid') {
        throw createBitbucketInvalidRequestError('Bitbucket returned an invalid pull-request next link');
      }
      nextUrl = continuation.kind === 'next' ? continuation.url : null;
    }
    return pullRequests;
  }

  async function getPullRequest(input: ScmHostingProviderPullRequestGetInput): Promise<ScmPullRequestSummary | null> {
    const number = readReferenceNumber(input);
    if (number) {
      const auth = await withAuth(input);
      const raw = await requestBitbucketJson({
        provider: input.provider,
        fetcher,
        auth,
        url: pullRequestUrl({ provider: input.provider, number }),
        init: { method: 'GET' },
        signal: input.signal,
      });
      return mapBitbucketPullRequest(input.provider, raw);
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

  async function createPullRequest(input: ScmHostingProviderPullRequestCreateInput): Promise<ScmPullRequestSummary> {
    const coordinates = readBitbucketRepositoryCoordinates(input.provider);
    const auth = await withAuth(input);
    const raw = await requestBitbucketJson({
      provider: input.provider,
      fetcher,
      auth,
      url: `${bitbucketRepositoryApiUrl({ coordinates })}/pullrequests`,
      init: {
        method: 'POST',
        body: JSON.stringify({
          title: input.title,
          description: input.body ?? '',
          source: {
            branch: { name: input.head },
          },
          destination: {
            branch: { name: input.base },
          },
          close_source_branch: false,
        }),
      },
      signal: input.signal,
    });
    const pullRequest = mapBitbucketPullRequest(input.provider, raw);
    if (!pullRequest) throw createBitbucketCommandFailedError('Bitbucket returned an invalid pull request payload');
    return pullRequest;
  }

  return Object.freeze({
    ...bitbucketHostingProviderAdapter,
    getPullRequestAuthProfileKey(input: Readonly<{ provider: ScmHostingProviderRef }>) {
      return profileKeyByProvider.get(providerAuthProfileScopeKey(input.provider)) ?? null;
    },
    listPullRequests,
    getPullRequest,
    createPullRequest,
    async openOrReusePullRequest(input: ScmHostingProviderPullRequestCreateInput) {
      const existing = findMatchingBitbucketPullRequest({
        pullRequests: await listPullRequests({
          provider: input.provider,
          base: input.base,
          head: input.head,
          state: 'open',
          ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        }),
        provider: input.provider,
        baseBranch: input.base,
        headBranch: input.head,
      });
      if (existing) return { pullRequest: existing, reused: true };
      try {
        return { pullRequest: await createPullRequest(input), reused: false };
      } catch (error) {
        if (!isBitbucketAlreadyExistsError(error)) throw error;
        const hinted = (error as { pullRequest?: unknown }).pullRequest;
        if (isPullRequestSummary(hinted)) {
          const pullRequest = hinted;
          if (matchesBitbucketBranchHeadContext({
            pullRequest,
            provider: input.provider,
            baseBranch: input.base,
            headBranch: input.head,
          })) {
            return { pullRequest, reused: true };
          }
        }
        const listedAfterDuplicate = findMatchingBitbucketPullRequest({
          pullRequests: await listPullRequests({
            provider: input.provider,
            base: input.base,
            head: input.head,
            state: 'open',
            ...(input.runtimeServices ? { runtimeServices: input.runtimeServices } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          }),
          provider: input.provider,
          baseBranch: input.base,
          headBranch: input.head,
        });
        if (listedAfterDuplicate) return { pullRequest: listedAfterDuplicate, reused: true };
        throw error;
      }
    },
    async resolvePullRequestCheckoutReference(input: ScmHostingProviderPullRequestCheckoutReferenceInput) {
      const pullRequest = await getPullRequest(input);
      if (!pullRequest) throw createBitbucketNotFoundError();
      return resolveBitbucketCheckoutReferenceFromPullRequest(pullRequest);
    },
    async describePublishTargets(input: ScmHostingProviderRepositoryDescribePublishTargetsInput) {
      const auth = await withAuth(input);
      if (input.provider.nameWithOwner) {
        const { workspace } = readBitbucketRepositoryCoordinates(input.provider);
        return { auth: authSummary(auth), targets: [publishTarget({ provider: input.provider, auth, owner: workspace })] };
      }
      const outcome = await listBitbucketWorkspaces({
        client: { requestJson: async (request) => ({
          ok: true,
          body: await requestBitbucketJson({ provider: input.provider, fetcher, auth, url: request.url, signal: request.signal }),
        }) },
        signal: input.signal,
      });
      if (!outcome.ok || !outcome.complete) {
        throw createBitbucketCommandFailedError('Bitbucket workspace discovery was incomplete');
      }
      return {
        auth: authSummary(auth),
        targets: outcome.workspaces.flatMap((workspace) => workspace.slug ? [publishTarget({
          provider: input.provider, auth, owner: workspace.slug, label: workspace.name ?? workspace.slug,
        })] : []),
      };
    },
    async createRepository(input: ScmHostingProviderRepositoryCreateInput) {
      const coordinates = readBitbucketOriginCoordinates(input.provider);
      const auth = await withAuth(input);
      const owner = normalizeOwner(input.owner);
      const repositoryName = normalizeRepositoryName(input.repositoryName);
      const raw = await requestBitbucketJson({
        provider: input.provider,
        fetcher,
        auth,
        url: bitbucketRepositoryApiUrl({
          coordinates: { ...coordinates, workspace: owner, repository: repositoryName },
        }),
        init: {
          method: 'POST',
          body: JSON.stringify({
            scm: 'git',
            is_private: input.visibility !== 'public',
            ...(input.description !== undefined ? { description: input.description } : {}),
          }),
        },
        signal: input.signal,
      });
      const mapped = mapBitbucketRepositorySummary({
        provider: input.provider,
        raw,
        owner,
        repositoryName,
        visibility: input.visibility,
      });
      if (!mapped) throw createBitbucketCommandFailedError('Bitbucket returned an invalid repository payload');
      return mapped;
    },
    async getRepository(input: ScmHostingProviderRepositoryGetInput) {
      const coordinates = readBitbucketOriginCoordinates(input.provider);
      const auth = await withAuth(input);
      const owner = normalizeOwner(input.owner);
      const repositoryName = normalizeRepositoryName(input.repositoryName);
      const raw = await requestBitbucketJson({
        provider: input.provider,
        fetcher,
        auth,
        url: bitbucketRepositoryApiUrl({
          coordinates: { ...coordinates, workspace: owner, repository: repositoryName },
        }),
        init: { method: 'GET' },
        signal: input.signal,
      }).catch((error) => {
        if (isBitbucketNotFoundError(error)) return null;
        throw error;
      });
      if (!raw) return null;
      const mapped = mapBitbucketRepositorySummary({
        provider: input.provider,
        raw,
        owner,
        repositoryName,
      });
      if (!mapped) throw createBitbucketCommandFailedError('Bitbucket returned an invalid repository payload');
      return mapped;
    },
  });
}

export const bitbucketApiAdapter = createBitbucketApiAdapter();
