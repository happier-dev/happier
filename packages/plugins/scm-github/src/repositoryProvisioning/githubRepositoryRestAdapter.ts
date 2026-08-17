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

import {
  createGithubRepositoryAlreadyExistsError,
  createGithubRepositoryAuthRequiredError,
  createGithubRepositoryCommandFailedError,
  createGithubRepositoryNotFoundError,
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
  };
}

function defaultFetcher(url: string, init?: RequestInit): Promise<GithubRestResponse> {
  return fetch(url, init);
}

function buildHeaders(token: string): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
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

function mapGithubRepositoryRestError(context: ScmForgeHttpErrorContext): Error {
  if (context.status === 401) {
    throw createGithubRepositoryAuthRequiredError('GitHub REST authentication failed');
  }
  if (context.status === 403) {
    throw createGithubRepositoryRemoteRejectedError('GitHub REST request was forbidden');
  }
  if (context.status === 404) {
    throw createGithubRepositoryNotFoundError();
  }
  if (context.status === 422) {
    if (isAlreadyExistsValidationError(context.body)) {
      throw createGithubRepositoryAlreadyExistsError();
    }
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
  ): Promise<Readonly<{ token: string; profileKey?: string }>> {
    const host = resolveGithubRepositoryHost(provider);
    const result = await tokenResolver({
      providerId: provider.id,
      host,
      provider,
      ...(runtimeServices ? { runtimeServices } : {}),
    });
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
  ): Promise<Readonly<{
    raw: unknown;
    profileKey?: string;
  }>> {
    const auth = await resolveToken(provider, runtimeServices);
    const raw = await requestScmForgeJson({
      url: `${resolveGithubRepositoryApiBaseUrl(provider)}${path}`,
      init: {
        ...init,
        ...(signal ? { signal } : {}),
        headers: buildHeaders(auth.token),
      },
      fetcher,
      mapError: mapGithubRepositoryRestError,
    });
    return {
      raw,
      ...(auth.profileKey ? { profileKey: auth.profileKey } : {}),
    };
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
      try {
        const { raw } = await requestJson(input.provider, `/repos/${repoPath(input)}`, { method: 'GET' }, input.runtimeServices, input.signal);
        const mapped = mapGithubRepositorySummary({
          provider: input.provider,
          raw,
          fallbackNameWithOwner: `${input.owner}/${input.repositoryName}`,
        });
        if (!mapped) throw createGithubRepositoryCommandFailedError('GitHub returned an invalid repository payload');
        return mapped;
      } catch (error) {
        if (isGithubRepositoryNotFoundError(error)) return null;
        throw error;
      }
    },
  });
}
