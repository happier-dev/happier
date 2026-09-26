import type { FeaturesResponse as ServerFeatures } from '@happier-dev/protocol';

import { normalizeBaseUrl, withAbortTimeout } from '@/diagnostics/httpClient';
import { parseServerFeatures } from './serverFeaturesParse';

export type CliServerFeaturesSnapshot =
  | Readonly<{ status: 'ready'; features: ServerFeatures }>
  | Readonly<{ status: 'unsupported'; reason: 'endpoint_missing' | 'invalid_payload' }>
  | Readonly<{ status: 'error'; reason: 'network' | 'timeout' | 'response_status'; httpStatus?: number }>;

const REQUEST_ATTEMPT_TIMEOUT_MS = 60_000;
const READY_TTL_MS = 10 * 60_000;
const TRANSIENT_TTL_MS = 5_000;
const RESPONSE_ERROR_TTL_MS = 30_000;
const UNSUPPORTED_TTL_MS = 60 * 60_000;

type CacheEntry = Readonly<{
  snapshot: CliServerFeaturesSnapshot;
  expiresAt: number;
}>;

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<CliServerFeaturesSnapshot>>();

export type ObserveServerFeaturesSnapshotParams = Readonly<{
  serverUrl: string;
  token?: string;
  timeoutMs?: number;
  /** Caller cancellation; aborts the in-flight request in addition to the attempt timeout. */
  signal?: AbortSignal;
  /** Injectable system boundary for probes/tests. */
  fetchImpl?: typeof fetch;
}>;

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

function writeSnapshot(key: string, snapshot: CliServerFeaturesSnapshot): CliServerFeaturesSnapshot {
  if (isRetryableError(snapshot)) {
    const previous = cache.get(key)?.snapshot;
    if (previous?.status === 'ready') {
      cache.set(key, { snapshot: previous, expiresAt: Date.now() + ttlForSnapshot(snapshot) });
      return previous;
    }
  }
  cache.set(key, { snapshot, expiresAt: Date.now() + ttlForSnapshot(snapshot) });
  return snapshot;
}

async function requestServerFeaturesSnapshot(
  params: ObserveServerFeaturesSnapshotParams,
): Promise<CliServerFeaturesSnapshot> {
  const key = normalizeBaseUrl(params.serverUrl);
  const token = params.token?.trim();
  const fetchImpl = params.fetchImpl ?? fetch;
  try {
    const response = await withAbortTimeout(params.timeoutMs ?? REQUEST_ATTEMPT_TIMEOUT_MS, async (timeoutSignal) =>
      await fetchImpl(`${key}/v1/features`, {
        method: 'GET',
        redirect: 'manual',
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        signal: params.signal ? AbortSignal.any([timeoutSignal, params.signal]) : timeoutSignal,
      }),
    );

    if (!response.ok) {
      return isEndpointMissing(response.status)
        ? { status: 'unsupported', reason: 'endpoint_missing' }
        : { status: 'error', reason: 'response_status', httpStatus: response.status };
    }

    const payload: unknown = await response.json();
    const parsed = parseServerFeatures(payload);
    if (!parsed) {
      return { status: 'unsupported', reason: 'invalid_payload' };
    }

    return {
      status: 'ready',
      features: parsed,
    };
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'AbortError';
    return {
      status: 'error',
      reason: isTimeout ? 'timeout' : 'network',
    };
  }
}

async function fetchAndCacheServerFeaturesSnapshot(serverUrl: string): Promise<CliServerFeaturesSnapshot> {
  const key = normalizeBaseUrl(serverUrl);
  return writeSnapshot(key, await requestServerFeaturesSnapshot({ serverUrl: key }));
}

export async function fetchServerFeaturesSnapshot(params: {
  serverUrl: string;
  timeoutMs?: number;
}): Promise<CliServerFeaturesSnapshot> {
  const key = normalizeBaseUrl(params.serverUrl);
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiresAt) return cached.snapshot;

  let request = inFlight.get(key);
  if (!request) {
    request = fetchAndCacheServerFeaturesSnapshot(key).finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, request);
  }

  const waitBudgetMs = params.timeoutMs;
  if (typeof waitBudgetMs !== 'number' || !Number.isFinite(waitBudgetMs) || waitBudgetMs <= 0) {
    return await request;
  }
  return await new Promise<CliServerFeaturesSnapshot>((resolve) => {
    let settled = false;
    const finish = (snapshot: CliServerFeaturesSnapshot) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(snapshot);
    };
    const timer = setTimeout(() => finish({ status: 'error', reason: 'timeout' }), waitBudgetMs);
    void request.then(finish);
  });
}

/** Fresh transactional observation for readiness, compatibility, and diagnostics. */
export async function observeServerFeaturesSnapshot(
  params: ObserveServerFeaturesSnapshotParams,
): Promise<CliServerFeaturesSnapshot> {
  return await requestServerFeaturesSnapshot(params);
}

export function resetServerFeaturesClientForTests(): void {
  cache.clear();
  inFlight.clear();
}
