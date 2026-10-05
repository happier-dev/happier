import type { FeaturesResponse as ServerFeatures } from '@happier-dev/protocol';

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
  | Readonly<{ status: 'error'; reason: 'network' | 'timeout' | 'response_status'; httpStatus?: number }>;

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

export const SERVER_FEATURES_REQUEST_ATTEMPT_TIMEOUT_MS = 60_000;
const READY_TTL_MS = 10 * 60_000;
const TRANSIENT_TTL_MS = 5_000;
const RESPONSE_ERROR_TTL_MS = 30_000;
const UNSUPPORTED_TTL_MS = 60 * 60_000;

type CacheEntry = Readonly<{
  snapshot: CliServerFeaturesSnapshot;
  expiresAt: number;
}>;

const publicCache = new Map<string, CacheEntry>();
const publicInFlight = new Map<string, Promise<CliServerFeaturesSnapshot>>();

function isEndpointMissing(status: number): boolean {
  return status === 404 || status === 405 || status === 501;
}

function isRetryableError(snapshot: CliServerFeaturesSnapshot): boolean {
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
  if (isRetryableError(snapshot)) {
    const previous = publicCache.get(key)?.snapshot;
    if (previous?.status === 'ready') {
      publicCache.set(key, { snapshot: previous, expiresAt: Date.now() + ttlForSnapshot(snapshot) });
      return previous;
    }
  }
  publicCache.set(key, { snapshot, expiresAt: Date.now() + ttlForSnapshot(snapshot) });
  return snapshot;
}

async function requestServerFeaturesSnapshot(
  params: FetchServerFeaturesSnapshotParams,
): Promise<CliServerFeaturesSnapshot> {
  const timeoutMs = params.timeoutMs ?? SERVER_FEATURES_REQUEST_ATTEMPT_TIMEOUT_MS;
  const token = params.token?.trim();
  const projection = params.projection ?? (token ? 'authenticated' : 'public');
  const authenticatedPath = '/v1/features/authenticated';
  const publicPath = '/v1/features';
  const fetchImpl = params.fetchImpl ?? fetch;

  try {
    let provenance: 'authenticated' | 'public' = projection;
    const requestPath = projection === 'authenticated' ? authenticatedPath : publicPath;
    const authorizationHeaders = params.resolveAuthorizationHeaders?.({ method: 'GET', path: requestPath });
    if (params.resolveAuthorizationHeaders && !authorizationHeaders) {
      return { status: 'error', reason: 'response_status' };
    }
    let response = await withAbortTimeout(
      timeoutMs,
      async (signal) => await fetchImpl(`${normalizeBaseUrl(params.serverUrl)}${requestPath}`, {
        method: 'GET',
        redirect: 'manual',
        ...(authorizationHeaders
          ? { headers: authorizationHeaders }
          : token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        signal,
      }),
      params.signal,
    );

    if (projection === 'authenticated' && token && !params.resolveAuthorizationHeaders && isEndpointMissing(response.status)) {
      provenance = 'public';
      response = await withAbortTimeout(
        timeoutMs,
        async (signal) => await fetchImpl(`${normalizeBaseUrl(params.serverUrl)}${publicPath}`, {
          method: 'GET',
          redirect: 'manual',
          signal,
        }),
        params.signal,
      );
    }

    if (!response.ok) {
      return isEndpointMissing(response.status)
        ? { status: 'unsupported', reason: 'endpoint_missing' }
        : { status: 'error', reason: 'response_status', httpStatus: response.status };
    }

    const parsed = await decodeServerFeaturesResponseBody(
      response.body,
      response.headers.get('content-length'),
    );
    if (!parsed) return { status: 'unsupported', reason: 'invalid_payload' };

    return { status: 'ready', features: parsed, provenance };
  } catch (error) {
    if (params.signal?.aborted) params.signal.throwIfAborted();
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    return { status: 'error', reason: isTimeout ? 'timeout' : 'network' };
  }
}

function waitForSharedPublicSnapshot(
  request: Promise<CliServerFeaturesSnapshot>,
  params: Pick<FetchServerFeaturesSnapshotParams, 'timeoutMs' | 'signal'>,
): Promise<CliServerFeaturesSnapshot> {
  const waitBudgetMs = params.timeoutMs;
  const signal = params.signal;
  if (!signal && (typeof waitBudgetMs !== 'number' || !Number.isFinite(waitBudgetMs) || waitBudgetMs <= 0)) {
    return request;
  }

  return new Promise<CliServerFeaturesSnapshot>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (snapshot: CliServerFeaturesSnapshot) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(snapshot);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(signal?.reason ?? new DOMException('Feature discovery cancelled', 'AbortError'));
    };

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (typeof waitBudgetMs === 'number' && Number.isFinite(waitBudgetMs) && waitBudgetMs > 0) {
      timer = setTimeout(() => finish({ status: 'error', reason: 'timeout' }), waitBudgetMs);
    }
    void request.then(finish, reject);
  });
}

function getOrStartPublicRequest(key: string): Promise<CliServerFeaturesSnapshot> {
  let request = publicInFlight.get(key);
  if (!request) {
    request = requestServerFeaturesSnapshot({ serverUrl: key, timeoutMs: SERVER_FEATURES_REQUEST_ATTEMPT_TIMEOUT_MS })
      .then((snapshot) => writePublicSnapshot(key, snapshot))
      .finally(() => publicInFlight.delete(key));
    publicInFlight.set(key, request);
  }
  return request;
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
  if (cached && Date.now() < cached.expiresAt) return cached.snapshot;
  return await waitForSharedPublicSnapshot(getOrStartPublicRequest(key), params);
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
  return await waitForSharedPublicSnapshot(getOrStartPublicRequest(key), params);
}

/** Explicit fresh transactional observation for enrollment, authentication, and diagnostics. */
export async function observeServerFeaturesSnapshot(
  params: FetchServerFeaturesSnapshotParams,
): Promise<CliServerFeaturesSnapshot> {
  return await requestServerFeaturesSnapshot(params);
}

export function resetServerFeaturesClientForTests(): void {
  publicCache.clear();
  publicInFlight.clear();
}
