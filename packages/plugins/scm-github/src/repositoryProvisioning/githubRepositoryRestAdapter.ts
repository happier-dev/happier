import type {
  HostingProviderRepositoryCreateInput as ScmHostingProviderRepositoryCreateInput,
  HostingProviderRepositoryDescribePublishTargetsInput as ScmHostingProviderRepositoryDescribePublishTargetsInput,
  HostingProviderRepositoryDescribePublishTargetsResult as ScmHostingProviderRepositoryDescribePublishTargetsResult,
  HostingProviderRepositoryGetInput as ScmHostingProviderRepositoryGetInput,
  HostingProviderRuntimeServices as ScmHostingProviderRuntimeServices,
} from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ForgeHttpErrorContext as ScmForgeHttpErrorContext,
  ForgeHttpFetcher as ScmForgeHttpFetcher,
  ForgeHttpResponse as ScmForgeHttpResponse,
  ScmHostingProviderRef } from '@happier-dev/plugin-sdk/scm/hosting';
import type {
  ScmHostingRepositoryAuthSummary,
  ScmHostingRepositoryPublishTarget,
  ScmHostingRepositorySummary,
} from '@happier-dev/plugin-sdk/scm';
import { requestForgeJson as requestScmForgeJson } from '@happier-dev/plugin-sdk/scm/hosting';

import { GITHUB_API_VERSION } from '../observations/githubProviderContracts.js';
import { readGithubDecodedResponseFacts, readGithubRetryAfterMs } from '../observations/githubApiClient.js';
import {
  classifyGithubResponseFacts,
  isGithubInaccessibleResourceFailure,
} from '../observations/githubResponseFailure.js';

import {
  createGithubRepositoryAlreadyExistsError,
  createGithubRepositoryAuthRequiredError,
  createGithubRepositoryCommandFailedError,
  createGithubRepositoryNotFoundError,
  createGithubRepositoryRateLimitedError,
  createGithubRepositoryRemoteRejectedError,
  isGithubRepositoryNotFoundError,
} from './githubRepositoryErrors.js';
import {
  resolveGithubRepositoryApiBaseUrl,
  resolveGithubRepositoryHost,
} from './githubRepositoryApiBase.js';
import { mapGithubRepositorySummary } from './githubRepositoryMapping.js';

type GithubRestResponse = ScmForgeHttpResponse;

export type GithubRepositoryRestFetcher = ScmForgeHttpFetcher;

export type GithubRepositoryRestTokenResolution =
  | Readonly<{
    kind: 'available';
    token: string;
    profileKey?: string;
  }>
  | Readonly<{
    kind: 'missing';
    reason: string;
  }>;

export type GithubRepositoryRestTokenResolver = (input: Readonly<{
  providerId: string;
  host: string;
  provider: ScmHostingProviderRef;
  runtimeServices?: ScmHostingProviderRuntimeServices;
}>) => Promise<GithubRepositoryRestTokenResolution>;

export type GithubRepositoryRestAdapter = Readonly<{
  describePublishTargets(
    input: ScmHostingProviderRepositoryDescribePublishTargetsInput
  ): Promise<ScmHostingProviderRepositoryDescribePublishTargetsResult>;
  createRepository(input: ScmHostingProviderRepositoryCreateInput): Promise<ScmHostingRepositorySummary>;
  getRepository(input: ScmHostingProviderRepositoryGetInput): Promise<ScmHostingRepositorySummary | null>;
  getRepositoryForClone(input: ScmHostingProviderRepositoryGetInput): Promise<Readonly<{
    repository: ScmHostingRepositorySummary | null; auth: ScmHostingRepositoryAuthSummary;
  }>>;
}>;


async function defaultRuntimeTokenResolver(input: Readonly<{
  providerId: string;
  host: string;
  provider: ScmHostingProviderRef;
  runtimeServices?: ScmHostingProviderRuntimeServices;
}>): Promise<GithubRepositoryRestTokenResolution> {
  const resolver = input.runtimeServices?.resolveScmHostingTokenMaterialization;
  if (!resolver) return { kind: 'missing', reason: 'credential_unavailable' };
  const result = await resolver({
    kind: 'scm_hosting_token',
    boundAccountOnly: true,
    providerId: input.providerId,
    host: input.host,
    provider: input.provider,
  });
  if (result.kind !== 'available') return { kind: 'missing', reason: result.reason };
  return {
    kind: 'available',
    token: result.token,
    ...(result.profileKey ? { profileKey: result.profileKey } : {}),
  };
}

function defaultFetcher(url: string, init?: RequestInit): Promise<GithubRestResponse> {
  return fetch(url, init);
}

function buildHeaders(token?: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
  };
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value.trim());
}

function repoPath(input: Readonly<{ owner: string; repositoryName: string }>): string {
  return `${encodePathSegment(input.owner)}/${encodePathSegment(input.repositoryName)}`;
}

/**
 * Names the shared GitHub classifier's answer in the SCM operation vocabulary.
 * The ladder itself lives with the other GitHub consumers: restating it here is
 * how a throttled `403` came to be reported as a permanent remote rejection with
 * no retry instruction, even though GitHub had said exactly when to come back.
 */
function mapGithubRepositoryRestError(context: ScmForgeHttpErrorContext, anonymous = false): Error {
  const now = Date.now();
  const failure = classifyGithubResponseFacts(
    readGithubDecodedResponseFacts({
      status: context.status,
      headers: context.response.headers,
      body: context.body,
    }),
    now,
  );
  switch (failure.class) {
    case 'rateLimit': {
      // The classifier's fallback is a retry policy, not a forge-provided instant.
      const retryAfterMs = readGithubRetryAfterMs(context.response.headers, now);
      throw createGithubRepositoryRateLimitedError(retryAfterMs === null ? undefined : now + retryAfterMs, anonymous);
    }
    case 'authentication':
      throw createGithubRepositoryAuthRequiredError('GitHub REST authentication failed');
    case 'permission':
      throw createGithubRepositoryRemoteRejectedError('GitHub REST request was forbidden');
    case 'unsupportedContract':
      if (isAlreadyExistsValidationError(context.body)) {
        throw createGithubRepositoryAlreadyExistsError();
      }
      break;
    default:
      // GitHub answered about this exact repository: deleted, renamed, or masked
      // by a credential that cannot see it. Retrying cannot change the answer.
      if (isGithubInaccessibleResourceFailure(failure)) {
        throw createGithubRepositoryNotFoundError();
      }
      break;
  }
  throw createGithubRepositoryCommandFailedError(`GitHub REST request failed with status ${context.status || context.statusText}`);
}

function isAlreadyExistsValidationError(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const message = (body as { message?: unknown }).message;
  if (typeof message === 'string' && /already exists/i.test(message)) return true;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors)) return false;
  return errors.some((error) => {
    if (!error || typeof error !== 'object' || Array.isArray(error)) return false;
    const errorMessage = (error as { message?: unknown }).message;
    return typeof errorMessage === 'string' && /already exists/i.test(errorMessage);
  });
}

function readLogin(raw: unknown): string | null {
  return Boolean(raw)
    && typeof raw === 'object'
    && !Array.isArray(raw)
    && typeof (raw as { login?: unknown }).login === 'string'
    && (raw as { login: string }).login.trim()
    ? (raw as { login: string }).login.trim()
    : null;
}

function readLabel(raw: unknown, fallback: string): string {
  if (Boolean(raw) && typeof raw === 'object' && !Array.isArray(raw)) {
    const candidate = (raw as { name?: unknown }).name;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return fallback;
}

function createAuthSummary(profileKey: string | undefined): ScmHostingRepositoryAuthSummary {
  return {
    state: 'authenticated',
    profileKind: 'connected_account',
    ...(profileKey ? { profileKey } : {}),
  };
}

function createTarget(input: Readonly<{
  provider: ScmHostingProviderRef;
  owner: string;
  ownerKind: 'user' | 'org';
  label: string;
  isDefault?: boolean;
  auth: ScmHostingRepositoryAuthSummary;
}>): ScmHostingRepositoryPublishTarget {
  return {
    provider: input.provider,
    owner: input.owner,
    ownerKind: input.ownerKind,
    label: input.label,
    ...(input.isDefault ? { isDefault: true } : {}),
    supportedVisibilities: input.ownerKind === 'org'
      ? ['private', 'public', 'internal']
      : ['private', 'public'],
    supportedRemoteUrlKinds: ['https', 'ssh'],
    auth: input.auth,
  };
}

export function createGithubRepositoryRestAdapter(params?: Readonly<{
  fetcher?: GithubRepositoryRestFetcher;
  resolveToken?: GithubRepositoryRestTokenResolver;
}>): GithubRepositoryRestAdapter {
  const fetcher = params?.fetcher ?? defaultFetcher;
  const tokenResolver = params?.resolveToken ?? defaultRuntimeTokenResolver;

  async function resolveToken(
    provider: ScmHostingProviderRef,
    runtimeServices?: ScmHostingProviderRuntimeServices,
    allowAnonymous = false,
  ): Promise<Readonly<{ token?: string; profileKey?: string }>> {
    const host = resolveGithubRepositoryHost(provider);
    const result = await tokenResolver({
      providerId: provider.id,
      host,
      provider,
      ...(runtimeServices ? { runtimeServices } : {}),
    });
    if (allowAnonymous && result.kind === 'missing' && result.reason === 'account_unbound') return {};
    if (result.kind !== 'available' || !result.token.trim()) {
      throw createGithubRepositoryAuthRequiredError();
    }
    return {
      token: result.token.trim(),
      ...(result.profileKey ? { profileKey: result.profileKey } : {}),
    };
  }

  async function requestJson(
    provider: ScmHostingProviderRef,
    path: string,
    init?: Omit<RequestInit, 'headers'>,
    runtimeServices?: ScmHostingProviderRuntimeServices,
    signal?: AbortSignal,
    resolvedAuth?: Readonly<{ token?: string; profileKey?: string }>,
  ): Promise<Readonly<{
    raw: unknown;
    profileKey?: string;
  }>> {
    const auth = resolvedAuth ?? await resolveToken(provider, runtimeServices);
    const raw = await requestScmForgeJson({
      url: `${resolveGithubRepositoryApiBaseUrl(provider)}${path}`,
      init: {
        ...init,
        ...(signal ? { signal } : {}),
        headers: buildHeaders(auth.token),
      },
      fetcher,
      mapError: context => mapGithubRepositoryRestError(context, !auth.token),
    });
    return {
      raw,
      ...(auth.profileKey ? { profileKey: auth.profileKey } : {}),
    };
  }

  async function readRepository(input: ScmHostingProviderRepositoryGetInput,
    auth?: Readonly<{ token?: string; profileKey?: string }>): Promise<ScmHostingRepositorySummary | null> {
    try {
      const { raw } = await requestJson(input.provider, `/repos/${repoPath(input)}`, { method: 'GET' }, input.runtimeServices, input.signal, auth);
      const mapped = mapGithubRepositorySummary({ provider: input.provider, raw,
        fallbackNameWithOwner: `${input.owner}/${input.repositoryName}` });
      if (!mapped) throw createGithubRepositoryCommandFailedError('GitHub returned an invalid repository payload');
      return mapped;
    } catch (error) {
      if (isGithubRepositoryNotFoundError(error)) return null;
      throw error;
    }
  }

  return Object.freeze({
    async describePublishTargets(input) {
      const user = await requestJson(input.provider, '/user', { method: 'GET' }, input.runtimeServices, input.signal);
      const orgs = await requestJson(input.provider, '/user/orgs', { method: 'GET' }, input.runtimeServices, input.signal);
      const auth = createAuthSummary(user.profileKey);
      const targets: ScmHostingRepositoryPublishTarget[] = [];
      const userLogin = readLogin(user.raw);
      if (userLogin) {
        targets.push(createTarget({
          provider: input.provider,
          owner: userLogin,
          ownerKind: 'user',
          label: readLabel(user.raw, userLogin),
          isDefault: true,
          auth,
        }));
      }
      if (Array.isArray(orgs.raw)) {
        for (const org of orgs.raw) {
          const owner = readLogin(org);
          if (!owner) continue;
          targets.push(createTarget({
            provider: input.provider,
            owner,
            ownerKind: 'org',
            label: readLabel(org, owner),
            auth,
          }));
        }
      }
      return {
        auth,
        targets,
      };
    },
    async createRepository(input) {
      const description = input.description?.trim();
      const body = input.ownerKind === 'org'
        ? {
          name: input.repositoryName,
          visibility: input.visibility,
          ...(description ? { description } : {}),
        }
        : {
          name: input.repositoryName,
          private: input.visibility !== 'public',
          ...(description ? { description } : {}),
        };
      const path = input.ownerKind === 'org'
        ? `/orgs/${encodePathSegment(input.owner)}/repos`
        : '/user/repos';
      const { raw } = await requestJson(
        input.provider,
        path,
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
        input.runtimeServices,
        input.signal,
      );
      const mapped = mapGithubRepositorySummary({
        provider: input.provider,
        raw,
        fallbackNameWithOwner: `${input.owner}/${input.repositoryName}`,
        fallbackVisibility: input.visibility,
      });
      if (!mapped) throw createGithubRepositoryCommandFailedError('GitHub returned an invalid repository payload');
      return mapped;
    },
    async getRepository(input) {
      return readRepository(input);
    },
    async getRepositoryForClone(input) {
      const auth = await resolveToken(input.provider, input.runtimeServices, true);
      const repository = await readRepository(input, auth);
      // Only observed public visibility admits no-auth cloning, not a saved locator.
      if (!auth.token && repository?.visibility !== 'public') throw createGithubRepositoryAuthRequiredError();
      const summary: ScmHostingRepositoryAuthSummary = auth.token ? createAuthSummary(auth.profileKey)
        : { state: 'authenticated', profileKind: 'no_auth' };
      return { repository, auth: summary };
    },
  });
}
