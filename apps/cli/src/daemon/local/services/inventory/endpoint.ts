import http from 'node:http';
import https from 'node:https';

import type {
    NormalizedLocalServiceInventoryEntry,
    NormalizedLocalServiceInventorySnapshot,
} from './scanner';

export type LocalServiceEndpointScheme = 'http' | 'https' | 'unknown';
export type LocalServiceEndpointProbeState = 'ready' | 'unknown';

export type LocalServiceEndpointFact = Readonly<{
    scheme: LocalServiceEndpointScheme;
    host: string;
    port: number;
    probeState: LocalServiceEndpointProbeState;
    probedAt: number;
    reasonCode?: string;
}>;

export type LocalServiceEndpointProbeInput = Readonly<{
    scheme: Exclude<LocalServiceEndpointScheme, 'unknown'>;
    host: string;
    port: number;
    timeoutMs: number;
}>;

export type LocalServiceEndpointProbe = (input: LocalServiceEndpointProbeInput) => Promise<boolean>;

export type LocalServiceEndpointEnricher = Readonly<{
    enrich(snapshot: NormalizedLocalServiceInventorySnapshot): Promise<NormalizedLocalServiceInventorySnapshot>;
}>;

export type LocalServiceEndpointEnricherParams = Readonly<{
    now: () => number;
    timeoutMs: number;
    concurrency: number;
    successTtlMs: number;
    failureTtlMs: number;
    maxCacheEntries?: number;
    probe?: LocalServiceEndpointProbe;
}>;

const DEFAULT_ENDPOINT_MAX_CACHE_ENTRIES = 512;

function formatHostForUrl(host: string): string {
    const rawHost = host.replace(/^\[|\]$/gu, '');
    return rawHost.includes(':') ? `[${rawHost}]` : rawHost;
}

export function buildLocalServiceEndpointUrl(endpoint: LocalServiceEndpointFact): string | null {
    if (endpoint.scheme !== 'http' && endpoint.scheme !== 'https') return null;
    const parsed = new URL(`${endpoint.scheme}://${formatHostForUrl(endpoint.host)}:${endpoint.port}/`);
    return parsed.toString();
}

function endpointHostForEntry(entry: NormalizedLocalServiceInventoryEntry): string | null {
    const rawHost = entry.address.host.replace(/^\[|\]$/gu, '');
    if (entry.address.kind === 'wildcard') {
        return entry.address.family === 'ipv6' || rawHost.includes(':') ? '::1' : '127.0.0.1';
    }
    // Intentional boundary: endpoint enrichment probes loopback and wildcard rebound to loopback only.
    // LAN addresses can represent reachable network peers, so probing them would exceed local-dev scope.
    if (entry.address.kind !== 'loopback') return null;
    return rawHost;
}

function readCached(
    cache: ReadonlyMap<string, Readonly<{ expiresAt: number; value: LocalServiceEndpointFact }>>,
    key: string,
    now: number,
): LocalServiceEndpointFact | null {
    const cached = cache.get(key);
    return cached && cached.expiresAt > now ? cached.value : null;
}

function writeCached(
    cache: Map<string, Readonly<{ expiresAt: number; value: LocalServiceEndpointFact }>>,
    key: string,
    entry: Readonly<{ expiresAt: number; value: LocalServiceEndpointFact }>,
    maxCacheEntries: number,
): void {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > maxCacheEntries) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}

function defaultProbe(input: LocalServiceEndpointProbeInput): Promise<boolean> {
    return new Promise((resolve) => {
        const client = input.scheme === 'https' ? https : http;
        const request = client.request({
            protocol: `${input.scheme}:`,
            host: input.host,
            port: input.port,
            method: 'HEAD',
            path: '/',
            timeout: input.timeoutMs,
            headers: {
                accept: 'text/html,application/xhtml+xml,*/*;q=0.1',
                connection: 'close',
            },
            rejectUnauthorized: false,
        }, (response) => {
            response.resume();
            resolve(true);
        });
        request.once('timeout', () => {
            request.destroy();
            resolve(false);
        });
        request.once('error', () => resolve(false));
        request.end();
    });
}

export function createLocalServiceEndpointEnricher(
    params: LocalServiceEndpointEnricherParams,
): LocalServiceEndpointEnricher {
    const probe = params.probe ?? defaultProbe;
    const timeoutMs = Math.max(1, Math.trunc(params.timeoutMs));
    const maxCacheEntries = Math.max(1, Math.trunc(params.maxCacheEntries ?? DEFAULT_ENDPOINT_MAX_CACHE_ENTRIES));
    const cache = new Map<string, Readonly<{ expiresAt: number; value: LocalServiceEndpointFact }>>();
    const active = { count: 0 };
    const waiters: Array<() => void> = [];

    const acquire = async () => {
        const limit = Math.max(1, Math.trunc(params.concurrency));
        if (active.count < limit) {
            active.count += 1;
            return;
        }
        await new Promise<void>((resolve) => waiters.push(resolve));
        active.count += 1;
    };
    const release = () => {
        active.count = Math.max(0, active.count - 1);
        waiters.shift()?.();
    };

    const classify = async (entry: NormalizedLocalServiceInventoryEntry): Promise<LocalServiceEndpointFact | null> => {
        if (entry.state !== 'listening') return entry.endpoint ?? null;
        const host = endpointHostForEntry(entry);
        if (!host) return null;
        const cacheKey = `${host}:${entry.port}`;
        const now = params.now();
        const cached = readCached(cache, cacheKey, now);
        if (cached) return cached;
        await acquire();
        try {
            const httpsReady = await probe({ scheme: 'https', host, port: entry.port, timeoutMs });
            const scheme: LocalServiceEndpointScheme = httpsReady
                ? 'https'
                : await probe({ scheme: 'http', host, port: entry.port, timeoutMs })
                    ? 'http'
                    : 'unknown';
            const value: LocalServiceEndpointFact = scheme === 'unknown'
                ? {
                    scheme,
                    host,
                    port: entry.port,
                    probeState: 'unknown',
                    probedAt: now,
                    reasonCode: 'endpoint_probe_failed',
                }
                : {
                    scheme,
                    host,
                    port: entry.port,
                    probeState: 'ready',
                    probedAt: now,
                };
            writeCached(cache, cacheKey, {
                value,
                expiresAt: now + (scheme === 'unknown' ? params.failureTtlMs : params.successTtlMs),
            }, maxCacheEntries);
            return value;
        } finally {
            release();
        }
    };

    return {
        async enrich(snapshot) {
            const entries = await Promise.all(snapshot.entries.map(async (entry) => {
                const endpoint = await classify(entry);
                return endpoint ? { ...entry, endpoint } : entry;
            }));
            return { ...snapshot, entries };
        },
    };
}
