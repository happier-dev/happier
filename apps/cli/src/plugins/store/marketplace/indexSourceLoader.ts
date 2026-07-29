import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { readFile } from 'node:fs/promises';
import { isIP, type LookupFunction } from 'node:net';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { Agent, fetch as undiciFetch } from 'undici';

import {
  MarketplaceIndexEntryV1Schema,
  MarketplaceIndexSourceSnapshotV1Schema,
  type MarketplaceIndexSourceKindV1,
  type MarketplaceIndexSourceSnapshotV1,
} from '@happier-dev/protocol';

import { resolveUrlConnectionIdentity } from '@/network/urlConnectionIdentity';
import { resolvePluginRemoteCatalogMaxBytes, resolvePluginRemoteFetchTimeoutMs } from '@/plugins/discovery/remote/fetch';
import { assertPublicNpmNetworkAddresses } from '@/plugins/distribution/npm/networkPolicy';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { writeJsonAtomic } from '@/utils/fs/writeJsonAtomic';

const CACHE_MAX_STALE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const inFlight = new Map<string, Promise<MarketplaceIndexSourceSnapshotV1>>();

type CacheRecord = Readonly<{
  t: 'happier_marketplace_index_source_cache_v1';
  sourceUrl: string;
  fetchedAtMs: number;
  etag: string | null;
  lastModified: string | null;
  snapshot: MarketplaceIndexSourceSnapshotV1;
}>;

export function parseCommunityNpmDiscovery(
  raw: unknown,
  source: { id: string; title: string; sourceUrl: string; kind: 'community-npm' },
): MarketplaceIndexSourceSnapshotV1 {
  const objects = raw && typeof raw === 'object' && Array.isArray((raw as { objects?: unknown }).objects)
    ? (raw as { objects: unknown[] }).objects.slice(0, 100)
    : [];
  const entries = objects.flatMap((candidate) => {
    if (!candidate || typeof candidate !== 'object') return [];
    const pkg = (candidate as { package?: unknown }).package;
    if (!pkg || typeof pkg !== 'object') return [];
    const extension = (pkg as { happierPlugin?: unknown }).happierPlugin;
    if (!extension || typeof extension !== 'object') return [];
    const parsed = MarketplaceIndexEntryV1Schema.safeParse({
      ...(extension as Record<string, unknown>),
      review: { status: 'unreviewed', reviewedAt: null },
      updatePolicy: (extension as { updatePolicy?: unknown }).updatePolicy === 'pinned' ? 'pinned' : 'manual',
    });
    if (!parsed.success) return [];
    if ((pkg as { name?: unknown }).name !== parsed.data.distribution.packageName
      || (pkg as { version?: unknown }).version !== parsed.data.distribution.version) return [];
    return [parsed.data];
  });
  return MarketplaceIndexSourceSnapshotV1Schema.parse({ source, freshness: { state: 'fresh', fetchedAtMs: null }, entries, diagnostics: [] });
}

function sourceCachePath(happyHomeDir: string | undefined, sourceUrl: string): string {
  const paths = resolvePluginStorePaths({ happyHomeDir });
  const digest = createHash('sha256').update(sourceUrl).digest('hex');
  return resolve(paths.cacheDir, 'marketplace-index', `${digest}.json`);
}

function validateSourceUrl(sourceUrl: string): string {
  const parsed = new URL(sourceUrl);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || !parsed.hostname) {
    throw new Error('Marketplace index sources require a credential-free HTTPS URL');
  }
  const { hostname } = resolveUrlConnectionIdentity(parsed.hostname);
  if (hostname.toLowerCase() === 'localhost') {
    throw new Error('Marketplace index source host must be public');
  }
  if (isIP(hostname) !== 0) assertPublicNpmNetworkAddresses([hostname]);
  return parsed.toString();
}

function remainingMs(deadlineAtMs: number): number {
  const remaining = Math.ceil(deadlineAtMs - performance.now());
  if (remaining <= 0) throw new Error('Marketplace index source fetch timed out');
  return remaining;
}

async function withinDeadline<T>(promise: Promise<T>, deadlineAtMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Marketplace index source fetch timed out')), remainingMs(deadlineAtMs));
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createPinnedLookup(hostname: string, addresses: readonly Readonly<{ address: string; family: 4 | 6 }>[]): LookupFunction {
  const expectedHostname = hostname.toLowerCase().replace(/\.$/u, '');
  return (requestedHostname, options, callback) => {
    if (requestedHostname.toLowerCase().replace(/\.$/u, '') !== expectedHostname) {
      callback(Object.assign(new Error('Marketplace index source host changed after DNS assessment'), { code: 'EHOSTUNREACH' }), '', 0);
      return;
    }
    const family = typeof options === 'number' ? options : options.family ?? 0;
    const candidates = family === 4 || family === 6 ? addresses.filter((entry) => entry.family === family) : addresses;
    if (candidates.length === 0) {
      callback(Object.assign(new Error('Marketplace index source has no assessed address for the requested family'), { code: 'EHOSTUNREACH' }), '', 0);
      return;
    }
    if (typeof options !== 'number' && options.all) {
      callback(null, [...candidates]);
      return;
    }
    callback(null, candidates[0]!.address, candidates[0]!.family);
  };
}

async function openSourceResponse(params: Readonly<{
  sourceUrl: string;
  headers: Readonly<Record<string, string>>;
  fetchImpl?: typeof fetch;
}>): Promise<Readonly<{ response: Response; dispose: () => Promise<void> }>> {
  const requiredOrigin = new URL(params.sourceUrl).origin;
  const deadlineAtMs = performance.now() + resolvePluginRemoteFetchTimeoutMs();
  let current = params.sourceUrl;
  for (let redirects = 0; ; redirects += 1) {
    const signal = AbortSignal.timeout(remainingMs(deadlineAtMs));
    let response: Response;
    let dispose = async (): Promise<void> => undefined;
    if (params.fetchImpl) {
      response = await params.fetchImpl(current, { headers: params.headers, signal, redirect: 'manual' });
    } else {
      const { hostname } = resolveUrlConnectionIdentity(new URL(current).hostname);
      const answers = await withinDeadline(dnsLookup(hostname, { all: true, verbatim: true }), deadlineAtMs);
      const addresses = answers.filter((answer): answer is { address: string; family: 4 | 6 } => answer.family === 4 || answer.family === 6);
      assertPublicNpmNetworkAddresses(addresses.map((answer) => answer.address));
      const dispatcher = new Agent({ connect: { lookup: createPinnedLookup(hostname, addresses) } });
      dispose = async () => await dispatcher.close();
      try {
        response = await undiciFetch(current, { headers: params.headers, signal, redirect: 'manual', dispatcher }) as unknown as Response;
      } catch (error) {
        await dispose().catch(() => undefined);
        throw error;
      }
    }

    if (!REDIRECT_STATUSES.has(response.status)) {
      if (response.url) {
        const observed = validateSourceUrl(response.url);
        if (new URL(observed).origin !== requiredOrigin) {
          await response.body?.cancel().catch(() => undefined);
          await dispose().catch(() => undefined);
          throw new Error('Marketplace index source redirect changed origin');
        }
      }
      return { response, dispose };
    }

    await response.body?.cancel().catch(() => undefined);
    await dispose().catch(() => undefined);
    if (redirects >= MAX_REDIRECTS) throw new Error(`Marketplace index source exceeded ${MAX_REDIRECTS} redirects`);
    const location = response.headers.get('location');
    if (!location) throw new Error('Marketplace index source redirect omitted location');
    const next = validateSourceUrl(new URL(location, current).toString());
    if (new URL(next).origin !== requiredOrigin) throw new Error('Marketplace index source redirect changed origin');
    current = next;
  }
}

async function readCache(
  path: string,
  source: { id: string; title: string; kind: MarketplaceIndexSourceKindV1; sourceUrl: string },
  nowMs: number,
): Promise<Readonly<{ record: CacheRecord | null; corrupt: boolean }>> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return { record: null, corrupt: true };
    const record = raw as Partial<CacheRecord>;
    if (record.t !== 'happier_marketplace_index_source_cache_v1' || record.sourceUrl !== source.sourceUrl || typeof record.fetchedAtMs !== 'number' || record.fetchedAtMs > nowMs) return { record: null, corrupt: true };
    const snapshot = MarketplaceIndexSourceSnapshotV1Schema.safeParse(record.snapshot);
    if (!snapshot.success) return { record: null, corrupt: true };
    if (snapshot.data.source.id !== source.id || snapshot.data.source.title !== source.title || snapshot.data.source.kind !== source.kind || snapshot.data.source.sourceUrl !== source.sourceUrl) return { record: null, corrupt: true };
    return { record: { t: record.t, sourceUrl: source.sourceUrl, fetchedAtMs: record.fetchedAtMs, etag: typeof record.etag === 'string' ? record.etag : null, lastModified: typeof record.lastModified === 'string' ? record.lastModified : null, snapshot: snapshot.data }, corrupt: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { record: null, corrupt: false };
    return { record: null, corrupt: true };
  }
}

async function readResponseBody(response: Response): Promise<unknown> {
  const limit = resolvePluginRemoteCatalogMaxBytes();
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > limit) throw new Error('Marketplace index source exceeds the configured size limit');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Marketplace index source response body is empty');
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes > limit) { await reader.cancel().catch(() => undefined); throw new Error('Marketplace index source exceeds the configured size limit'); }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')) as unknown;
}

function isOfflineRefreshError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (typeof code === 'string' && /^(?:EAI_AGAIN|ECONN|ENET|ENOTFOUND|EHOSTUNREACH|ETIMEDOUT)/u.test(code)) return true;
  return error instanceof Error && /\boffline\b|timed out|network connection/u.test(error.message);
}

export async function loadMarketplaceIndexSource(params: Readonly<{
  source: { id: string; title: string; sourceUrl: string; kind: MarketplaceIndexSourceKindV1 };
  happyHomeDir?: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
}>): Promise<MarketplaceIndexSourceSnapshotV1> {
  const sourceUrl = validateSourceUrl(params.source.sourceUrl);
  const cachePath = sourceCachePath(params.happyHomeDir, sourceUrl);
  const key = `${cachePath}\u0000${params.source.id}`;
  const existing = inFlight.get(key);
  if (existing) return await existing;
  const operation: Promise<MarketplaceIndexSourceSnapshotV1> = (async (): Promise<MarketplaceIndexSourceSnapshotV1> => {
    const now = params.now ?? Date.now;
    const cacheRead = await readCache(cachePath, { ...params.source, sourceUrl }, now());
    const cached = cacheRead.record;
    try {
      const opened = await openSourceResponse({
        sourceUrl,
        headers: { accept: 'application/json', ...(cached?.etag ? { 'if-none-match': cached.etag } : {}), ...(cached?.lastModified ? { 'if-modified-since': cached.lastModified } : {}) },
        ...(params.fetchImpl ? { fetchImpl: params.fetchImpl } : {}),
      });
      try {
        const response = opened.response;
        if (response.status === 304 && cached) {
          const snapshot: MarketplaceIndexSourceSnapshotV1 = { ...cached.snapshot, freshness: { state: 'fresh', fetchedAtMs: now() } };
          await writeJsonAtomic(cachePath, { ...cached, fetchedAtMs: now(), snapshot });
          return snapshot;
        }
        if (!response.ok) throw new Error(`Marketplace index source fetch failed with ${response.status}`);
        const body = await readResponseBody(response);
        const parsed = params.source.kind === 'community-npm'
          ? parseCommunityNpmDiscovery(body, { ...params.source, kind: 'community-npm' })
          : MarketplaceIndexSourceSnapshotV1Schema.parse(body);
        if (parsed.source.id !== params.source.id || parsed.source.title !== params.source.title || parsed.source.kind !== params.source.kind || parsed.source.sourceUrl !== sourceUrl) throw new Error('Marketplace index source identity does not match its configured binding');
        const invalidReview = parsed.entries.find((entry) => (
          params.source.kind === 'curated'
            ? entry.review.status === 'unreviewed'
            : entry.review.status !== 'unreviewed' || entry.updatePolicy === 'curated-auto'
        ));
        if (invalidReview) throw new Error(`Marketplace source '${params.source.id}' claims review/update authority outside its source kind`);
        const snapshot: MarketplaceIndexSourceSnapshotV1 = { ...parsed, freshness: { state: 'fresh', fetchedAtMs: now() } };
        await writeJsonAtomic(cachePath, { t: 'happier_marketplace_index_source_cache_v1', sourceUrl, fetchedAtMs: now(), etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'), snapshot } satisfies CacheRecord);
        return snapshot;
      } finally {
        await opened.dispose().catch(() => undefined);
      }
    } catch (error) {
      if (cached && now() - cached.fetchedAtMs >= 0 && now() - cached.fetchedAtMs <= CACHE_MAX_STALE_MS) {
        return { ...cached.snapshot, freshness: { state: isOfflineRefreshError(error) ? 'stale-offline' : 'stale', fetchedAtMs: cached.fetchedAtMs, staleSinceMs: now() }, diagnostics: [...cached.snapshot.diagnostics.slice(0, 127), { code: 'marketplace_source_refresh_failed', message: error instanceof Error ? error.message : 'Marketplace index source refresh failed' }] };
      }
      return {
        source: params.source,
        freshness: { state: cacheRead.corrupt ? 'corrupt' : 'unavailable', fetchedAtMs: null },
        entries: [],
        diagnostics: [{ code: cacheRead.corrupt ? 'marketplace_cache_corrupt' : 'marketplace_source_unavailable', message: error instanceof Error ? error.message : 'Marketplace index source unavailable' }],
      };
    }
  })();
  inFlight.set(key, operation);
  try { return await operation; } finally { if (inFlight.get(key) === operation) inFlight.delete(key); }
}
