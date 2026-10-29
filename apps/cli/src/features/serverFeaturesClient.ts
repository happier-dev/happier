import { readRetryLaterHints, type RetryLaterHints } from '@happier-dev/connection-supervisor';
import { CredentialRequestRedirectError, fetchWithCredentialRedirectRefusal } from '@happier-dev/cli-common/homeTarget';
import type { FeaturesResponse as ServerFeatures } from '@happier-dev/protocol';
import { AsyncTtlCache } from '@happier-dev/protocol/common/asyncTtlCache';
import { armDeadlineTimer } from '@happier-dev/protocol/common/deadlineTimer';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';

import { normalizeBaseUrl, withAbortTimeout } from '../diagnostics/httpClient';
import { decodeServerFeaturesResponseBody } from './serverFeaturesParse';

export type CliServerFeaturesSnapshot =
  | Readonly<{
      status: 'ready';
      features: ServerFeatures;
      /** Whether the descriptor-bearing projection was authenticated or public/advisory. */
      provenance?: 'authenticated' | 'public';
    }>
  | Readonly<{ status: 'unsupported'; reason: 'endpoint_missing' | 'invalid_payload' }>
  | Readonly<{
      status: 'error';
      reason: 'network' | 'timeout' | 'response_status';
      httpStatus?: number;
      /** When the server said how long it will be unavailable (Retry-After on a non-OK response). */
      retryLater?: RetryLaterHints;
    }>;

/** Portable Home identity from an existing observation of the exact bound origin.
 * Undefined preserves retryable context custody; null is a ready older Home
 * without this capability, not permission to substitute a local profile id.
 */
export function readServerIdentityIdFromFeaturesSnapshot(snapshot: CliServerFeaturesSnapshot | null | undefined): string | null | undefined {
  return snapshot?.status === 'ready'
    ? normalizeServerIdentityIdCapability(snapshot.features.capabilities.serverIdentity?.serverIdentityId) ?? null
    : undefined;
}

export type FetchServerFeaturesSnapshotParams = Readonly<{
  serverUrl: string;
  /** Home credential requests the exact authenticated descriptor projection. */
  token?: string;
  /** Defaults to authenticated when a token is present, otherwise public. */
  projection?: 'authenticated' | 'public';
  /** Caller wait budget for shared public reads; request deadline for fresh authenticated observations. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Injectable system boundary for probes/tests. Custom transports are always observed fresh. */
  fetchImpl?: typeof fetch;
  resolveAuthorizationHeaders?: (request: Readonly<{
    method: 'GET';
    path: string;
  }>) => Readonly<Record<string, string>> | null;
}>;

const READY_TTL_MS = 10 * 60_000;
const TRANSIENT_TTL_MS = 5_000;
const RESPONSE_ERROR_TTL_MS = 30_000;
const UNSUPPORTED_TTL_MS = 60 * 60_000;

const publicCache = new AsyncTtlCache<CliServerFeaturesSnapshot>({
  successTtlMs: READY_TTL_MS,
  errorTtlMs: TRANSIENT_TTL_MS,
});

function withRetryLater(hints: RetryLaterHints): Readonly<{ retryLater?: RetryLaterHints }> {
  return hints.retryAfterMs === undefined && hints.reason === undefined ? {} : { retryLater: hints };
}

function isEndpointMissing(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

export function isServerFeaturesProbeRetryable(snapshot: CliServerFeaturesSnapshot): boolean {
  if (snapshot.status !== 'error') return false;
  if (snapshot.reason === 'network' || snapshot.reason === 'timeout') return true;
  return snapshot.reason === 'response_status' && snapshot.httpStatus !== undefined
    && (snapshot.httpStatus === 408 || snapshot.httpStatus === 429 || snapshot.httpStatus >= 500);
}

function ttlForSnapshot(snapshot: CliServerFeaturesSnapshot): number {
  if (snapshot.status === 'ready') return READY_TTL_MS;
  if (snapshot.status === 'unsupported') return UNSUPPORTED_TTL_MS;
  return snapshot.reason === 'response_status' ? RESPONSE_ERROR_TTL_MS : TRANSIENT_TTL_MS;
}

function writePublicSnapshot(key: string, snapshot: CliServerFeaturesSnapshot): CliServerFeaturesSnapshot {
  if (isServerFeaturesProbeRetryable(snapshot)) {
    const previousEntry = publicCache.get(key);
    const previous = previousEntry?.kind === 'success' ? previousEntry.value : undefined;
    if (previous?.status === 'ready') {
      publicCache.setSuccess(key, previous, { ttlMs: ttlForSnapshot(snapshot) });
      return previous;
    }
  }
  publicCache.setSuccess(key, snapshot, { ttlMs: ttlForSnapshot(snapshot) });
  return snapshot;
}

async function requestServerFeaturesSnapshot(
  params: FetchServerFeaturesSnapshotParams,
): Promise<CliServerFeaturesSnapshot> {
  const token = params.token?.trim();
  const projection = params.projection ?? (token ? 'authenticated' : 'public');
  const authenticatedPath = '/v1/features/authenticated';
  const publicPath = '/v1/features';
  const fetchImpl = params.fetchImpl ?? fetch;

  try {
    return await withAbortTimeout<CliServerFeaturesSnapshot>(params.timeoutMs, async (signal) => {
      let provenance: 'authenticated' | 'public' = projection;
      const requestPath = projection === 'authenticated' ? authenticatedPath : publicPath;
      const authorizationHeaders = params.resolveAuthorizationHeaders?.({ method: 'GET', path: requestPath });
      if (params.resolveAuthorizationHeaders && !authorizationHeaders) {
        return { status: 'error', reason: 'response_status' };
      }
      let response = await fetchWithCredentialRedirectRefusal(`${normalizeBaseUrl(params.serverUrl)}${requestPath}`, {
        method: 'GET',
        redirect: 'manual',
        ...(authorizationHeaders
          ? { headers: authorizationHeaders }
          : token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        signal,
      }, fetchImpl);

      if (projection === 'authenticated' && token && !params.resolveAuthorizationHeaders && isEndpointMissing(response.status)) {
        provenance = 'public';
        response = await fetchWithCredentialRedirectRefusal(`${normalizeBaseUrl(params.serverUrl)}${publicPath}`, {
          method: 'GET',
          redirect: 'manual',
          signal,
        }, fetchImpl);
      }

      if (!response.ok) {
        return isEndpointMissing(response.status)
          ? { status: 'unsupported', reason: 'endpoint_missing' }
          : {
            status: 'error',
            reason: 'response_status',
            httpStatus: response.status,
            ...withRetryLater(readRetryLaterHints(response.headers)),
          };
      }

      const parsed = await decodeServerFeaturesResponseBody(
        response.body,
        response.headers.get('content-length'),
      );
      signal.throwIfAborted();
      if (!parsed) return { status: 'unsupported', reason: 'invalid_payload' };

      return { status: 'ready', features: parsed, provenance };
    }, params.signal);
  } catch (error) {
    if (params.signal?.aborted) params.signal.throwIfAborted();
    if (error instanceof CredentialRequestRedirectError) throw error;
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    return { status: 'error', reason: isTimeout ? 'timeout' : 'network' };
  }
}

async function readSharedPublicSnapshot(
  key: string,
  params: Pick<FetchServerFeaturesSnapshotParams, 'timeoutMs' | 'signal'>,
): Promise<CliServerFeaturesSnapshot> {
  const waitBudgetMs = params.timeoutMs;
  const waitController = typeof waitBudgetMs === 'number' && Number.isFinite(waitBudgetMs) && waitBudgetMs > 0
    ? new AbortController()
    : undefined;
  const signal = waitController
    ? params.signal ? AbortSignal.any([params.signal, waitController.signal]) : waitController.signal
    : params.signal;
  const cancelDeadline = waitController && typeof waitBudgetMs === 'number'
    ? armDeadlineTimer(Date.now() + waitBudgetMs, () => waitController.abort(), { unref: true })
    : undefined;
  try {
    return await publicCache.runDedupe(key, async (context) => {
      const snapshot = await requestServerFeaturesSnapshot({ serverUrl: key, signal: context.signal });
      return context.isCurrent() ? writePublicSnapshot(key, snapshot) : snapshot;
    }, { signal });
  } catch (error) {
    if (params.signal?.aborted) params.signal.throwIfAborted();
    if (waitController?.signal.aborted) return { status: 'error', reason: 'timeout' };
    throw error;
  } finally {
    cancelDeadline?.();
  }
}

/**
 * Reusable feature-snapshot read. Public observations share a process-local TTL cache and in-flight
 * request. Authenticated or request-signed observations remain fresh because their result depends
 * on credential authority that must never be retained as a cache key.
 */
export async function fetchServerFeaturesSnapshot(
  params: FetchServerFeaturesSnapshotParams,
): Promise<CliServerFeaturesSnapshot> {
  if (
    params.token?.trim()
    || params.resolveAuthorizationHeaders
    || params.fetchImpl
    || params.projection === 'authenticated'
  ) {
    return await requestServerFeaturesSnapshot(params);
  }

  const key = normalizeBaseUrl(params.serverUrl);
  const cached = publicCache.get(key);
  if (cached?.kind === 'success' && publicCache.isFresh(cached)) return cached.value;
  return await readSharedPublicSnapshot(key, params);
}

/** Force a fresh observation while updating the reusable public snapshot when applicable. */
export async function refreshServerFeaturesSnapshot(
  params: FetchServerFeaturesSnapshotParams,
): Promise<CliServerFeaturesSnapshot> {
  if (
    params.token?.trim()
    || params.resolveAuthorizationHeaders
    || params.fetchImpl
    || params.projection === 'authenticated'
  ) {
    return await requestServerFeaturesSnapshot(params);
  }

  const key = normalizeBaseUrl(params.serverUrl);
  return await readSharedPublicSnapshot(key, params);
}

/** Explicit fresh transactional observation for enrollment, authentication, and diagnostics. */
export async function observeServerFeaturesSnapshot(
  params: FetchServerFeaturesSnapshotParams,
): Promise<CliServerFeaturesSnapshot> {
  return await requestServerFeaturesSnapshot(params);
}

export function resetServerFeaturesClientForTests(): void {
  publicCache.clear();
}
