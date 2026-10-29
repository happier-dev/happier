import { AsyncTtlCache } from '@happier-dev/protocol/common/asyncTtlCache';
import { fetchWithCredentialRedirectRefusal } from '@happier-dev/cli-common/homeTarget';
import {
  fetchGitHubLatestRelease as requestLatestRelease,
  fetchGitHubReleaseByTag as requestReleaseByTag,
  GitHubReleaseRateLimitError,
} from '@happier-dev/release-runtime/github';

import { configuration } from '@/configuration';

type LookupOptions = Readonly<{ cacheTtlMs?: number; bypassCache?: boolean }>;
type LookupState = Readonly<{
  releases: AsyncTtlCache<unknown>;
  exhausted: Map<string, GitHubReleaseRateLimitError>;
}>;

// One owner per daemon. Transport-scoped state also keeps independently supplied HTTP
// boundaries isolated. Repository/tag, not capability or install-source, identifies a read.
const states = new WeakMap<object, LookupState>();
const nativeTransport = {};

async function lookup(
  params: Parameters<typeof requestReleaseByTag>[0] & LookupOptions,
  latest: boolean,
): Promise<unknown> {
  params.signal?.throwIfAborted();
  const transport = params.fetchImpl ?? globalThis.fetch ?? nativeTransport;
  let state = states.get(transport);
  if (!state) {
    state = { releases: new AsyncTtlCache({ successTtlMs: 0, errorTtlMs: 0 }), exhausted: new Map() };
    states.set(transport, state);
  }
  const ttlMs = params.cacheTtlMs ?? configuration.installablesRuntimeAutoUpdateCheckIntervalMs;
  const origin = params.assetsOnly ? 'assets' : new URL(params.apiBaseUrl ?? 'https://api.github.com').origin;
  const key = JSON.stringify([origin, params.apiBaseUrl?.replace(/\/$/, '') ?? null,
    params.githubRepo.trim().toLowerCase(), latest ? null : params.tag]);
  const cached = state.releases.get(key);
  if (!params.bypassCache && cached?.kind === 'success' && state.releases.isFresh(cached)
    && Date.now() < cached.updatedAt + ttlMs) return cached.value;
  const exhausted = state.exhausted.get(origin);
  if (exhausted && exhausted.resetAtMs !== null && Date.now() < exhausted.resetAtMs) throw exhausted;
  state.exhausted.delete(origin);

  const owner = state;
  return owner.releases.runDedupe(key, async ({ signal, isCurrent }) => {
    try {
      const fetchImpl = params.fetchImpl ?? globalThis.fetch;
      const request = { ...params, fetchImpl: params.githubToken?.trim() && fetchImpl
        ? ((input, init) => fetchWithCredentialRedirectRefusal(input, init, fetchImpl)) satisfies typeof fetch
        : fetchImpl, signal };
      const release = await (latest ? requestLatestRelease(request) : requestReleaseByTag(request));
      if (isCurrent()) owner.releases.setSuccess(key, release, { ttlMs });
      return release;
    } catch (error) {
      if (isCurrent() && error instanceof GitHubReleaseRateLimitError && error.resetAtMs !== null) {
        owner.exhausted.set(origin, error);
      }
      throw error;
    }
  }, { signal: params.signal });
}

/** Demand-only release facts; freshness follows the existing installables interval. */
export function fetchGitHubLatestRelease(
  params: Parameters<typeof requestLatestRelease>[0] & LookupOptions,
): Promise<unknown> {
  return lookup({ ...params, tag: '' }, true);
}

/** Tag selection remains caller-owned; REST quota and in-flight reads are shared. */
export function fetchGitHubReleaseByTag(
  params: Parameters<typeof requestReleaseByTag>[0] & LookupOptions,
): Promise<unknown> {
  return lookup(params, false);
}
