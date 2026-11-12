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
import type { ConnectedAccountRef } from '@happier-dev/plugin-sdk/connected-accounts';

import { createGithubRequestHeaders } from '../observations/githubRequestHeaders.js';
import { readGithubDecodedResponseFacts, type GithubApiMethodV1 } from '../observations/githubApiClient.js';
import { requestGithubAccountForgeJsonV1 } from '../observations/githubForgeHttpFetcher.js';
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
import { mapGithubLatestStableReleaseV1 } from '../releases/mapping.js';
import { decodeGithubRepositoryMetadata } from '../triage/repositories.js';

type GithubRestResponse = ScmForgeHttpResponse;

export type GithubRepositoryRestFetcher = ScmForgeHttpFetcher;

export type GithubRepositoryRestTokenResolution =
  | Readonly<{
    kind: 'available';
    token: string;
    profileKey?: string;
    account?: ConnectedAccountRef;
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
  getRepositoryForClone(input: ScmHostingProviderRepositoryGetInput & Readonly<{ revision?: 'latest-stable' }>): Promise<Readonly<{
    repository: ScmHostingRepositorySummary | null; auth: ScmHostingRepositoryAuthSummary; initialCheckoutRef?: string;
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
    providerId: input.providerId,
    host: input.host,
    provider: input.provider,
  });
  if (result.kind !== 'available') return { kind: 'missing', reason: result.reason };
  return {
    kind: 'available',
    token: result.token,
    ...(result.profileKey ? { profileKey: result.profileKey } : {}),
    ...(result.account ? { account: result.account } : {}),
  };
}

function defaultFetcher(url: string, init?: RequestInit): Promise<GithubRestResponse> {
  return fetch(url, init);
}

function buildHeaders(token?: string): Record<string, string> {
  return createGithubRequestHeaders({
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    headers: { 'Content-Type': 'application/json' },
  });
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
      throw createGithubRepositoryRateLimitedError(failure.retryNotBeforeMs, anonymous);
    }
    case 'authentication':
      throw createGithubRepositoryAuthRequiredError(
        'GitHub rejected the credential. Reconnect the selected GitHub account or sign in with GitHub CLI on this machine.',
        'scm.repository_auth.http_authentication', context.status);
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
        throw createGithubRepositoryNotFoundError(undefined, context.status);
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

function createAuthSummary(profileKey: string | undefined, account?: ConnectedAccountRef): ScmHostingRepositoryAuthSummary {
  return {
    state: 'authenticated',
    profileKind: account || profileKey ? 'connected_account' : 'provider_cli',
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
  const adapterLifetime = {};

  async function resolveToken(
    provider: ScmHostingProviderRef,
    runtimeServices?: ScmHostingProviderRuntimeServices,
    allowAnonymous = false,
  ): Promise<Readonly<{ token?: string; profileKey?: string; account?: ConnectedAccountRef }>> {
    const host = resolveGithubRepositoryHost(provider);
    const result = await tokenResolver({
      providerId: provider.id,
      host,
      provider,
      ...(runtimeServices ? { runtimeServices } : {}),
    });
    if (allowAnonymous && result.kind === 'missing' && result.reason === 'account_unbound') return {};
    if (result.kind !== 'available' || !result.token.trim()) {
      throw createGithubRepositoryAuthRequiredError(
        'GitHub credentials could not be acquired. Reconnect the selected GitHub account or sign in with GitHub CLI on this machine.',
        'scm.repository_auth.materialization');
    }
    return {
      token: result.token.trim(),
      ...(result.profileKey ? { profileKey: result.profileKey } : {}),
      ...(result.account ? { account: result.account } : {}),
    };
  }

  async function requestJson(
    provider: ScmHostingProviderRef,
    path: string,
    init?: Readonly<{ method?: GithubApiMethodV1; body?: string }>,
    runtimeServices?: ScmHostingProviderRuntimeServices,
    signal?: AbortSignal,
    resolvedAuth?: Readonly<{ token?: string; profileKey?: string; account?: ConnectedAccountRef }>,
  ): Promise<Readonly<{
    raw: unknown;
    profileKey?: string;
    account?: ConnectedAccountRef;
  }>> {
    const auth = resolvedAuth ?? await resolveToken(provider, runtimeServices);
    const raw = await requestGithubAccountForgeJsonV1({
      url: `${resolveGithubRepositoryApiBaseUrl(provider)}${path}`,
      ...init,
      ...(signal ? { signal } : {}),
      headers: buildHeaders(auth.token),
      auth,
      executionOrigin: new URL(resolveGithubRepositoryApiBaseUrl(provider)).origin,
      lifetime: adapterLifetime,
      fetcher,
      mapError: context => mapGithubRepositoryRestError(context, !auth.token),
    });
    return {
      raw,
      ...(auth.profileKey ? { profileKey: auth.profileKey } : {}),
      ...(auth.account ? { account: auth.account } : {}),
    };
  }

  async function readRepository(input: ScmHostingProviderRepositoryGetInput,
    auth?: Readonly<{ token?: string; profileKey?: string; account?: ConnectedAccountRef }>): Promise<Readonly<{ repository: ScmHostingRepositorySummary; raw: unknown }> | null> {
    try {
      const { raw } = await requestJson(input.provider, `/repos/${repoPath(input)}`, { method: 'GET' }, input.runtimeServices, input.signal, auth);
      const mapped = mapGithubRepositorySummary({ provider: input.provider, raw,
        fallbackNameWithOwner: `${input.owner}/${input.repositoryName}` });
      if (!mapped) throw createGithubRepositoryCommandFailedError('GitHub returned an invalid repository payload');
      return { repository: mapped, raw };
    } catch (error) {
      if (isGithubRepositoryNotFoundError(error)) return null;
      throw error;
    }
  }

  return Object.freeze({
    async describePublishTargets(input) {
      const user = await requestJson(input.provider, '/user', { method: 'GET' }, input.runtimeServices, input.signal);
      const orgs = await requestJson(input.provider, '/user/orgs', { method: 'GET' }, input.runtimeServices, input.signal);
      const auth = createAuthSummary(user.profileKey, user.account);
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
      return (await readRepository(input))?.repository ?? null;
    },
    async getRepositoryForClone(input) {
      const auth = await resolveToken(input.provider, input.runtimeServices, true);
      const observed = await readRepository(input, auth);
      const repository = observed?.repository ?? null;
      // Only observed public visibility admits no-auth cloning, not a saved locator.
      if (!auth.token && repository?.visibility !== 'public') throw createGithubRepositoryAuthRequiredError(
        'This repository is not publicly readable. Connect a GitHub account with repository access or sign in with GitHub CLI on this machine.',
        'scm.repository_auth.account_required');
      const summary: ScmHostingRepositoryAuthSummary = auth.token ? createAuthSummary(auth.profileKey, auth.account)
        : { state: 'authenticated', profileKind: 'no_auth' };
      if (input.revision === undefined || !repository || !observed) return { repository, auth: summary };
      const metadata = decodeGithubRepositoryMetadata(observed.raw);
      if (!metadata) throw createGithubRepositoryCommandFailedError('GitHub returned invalid repository identity');
      let initialCheckoutRef: string;
      try {
        const { raw } = await requestJson(input.provider, `/repos/${repoPath(input)}/releases/latest`,
          { method: 'GET' }, input.runtimeServices, input.signal, auth);
        const release = mapGithubLatestStableReleaseV1(raw, {
          repository: { kind: 'github', deployment: input.provider.baseUrl, repository: repository.nameWithOwner },
          repositoryId: metadata.repositoryId,
          repositoryVisibility: repository.visibility === 'public' ? 'public' : 'private',
        });
        if (!release) throw createGithubRepositoryCommandFailedError('GitHub returned an invalid latest release');
        initialCheckoutRef = `refs/tags/${release.tagName}`;
      } catch (error) {
        // The same credential just established repository readability. Only no release falls back.
        if (!isGithubRepositoryNotFoundError(error) || error.httpStatus !== 404) throw error;
        initialCheckoutRef = 'HEAD';
      }
      return { repository, auth: summary, initialCheckoutRef };
    },
  });
}
