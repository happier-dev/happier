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
    signal?: AbortSignal;
}>;

export type LocalServiceEndpointProbe = (input: LocalServiceEndpointProbeInput) => Promise<boolean | 'inconclusive'>;

export type LocalServiceEndpointEnricher = Readonly<{
    enrich(snapshot: NormalizedLocalServiceInventorySnapshot): Promise<NormalizedLocalServiceInventorySnapshot>;
    resolve(entry: NormalizedLocalServiceInventoryEntry, signal?: AbortSignal): Promise<LocalServiceEndpointFact | null>;
}>;

export type LocalServiceEndpointEnricherParams = Readonly<{
    now: () => number;
    probe?: LocalServiceEndpointProbe;
    signal?: AbortSignal;
}>;

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

function defaultProbe(input: LocalServiceEndpointProbeInput): Promise<boolean | 'inconclusive'> {
    input.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const client = input.scheme === 'https' ? https : http;
        const request = client.request({
            protocol: `${input.scheme}:`,
            host: input.host,
            port: input.port,
            method: 'HEAD',
            path: '/',
            signal: input.signal,
            headers: {
                accept: 'text/html,application/xhtml+xml,*/*;q=0.1',
                connection: 'close',
            },
            rejectUnauthorized: false,
        }, (response) => {
            response.resume();
            request.setTimeout(0);
            resolve(true);
        });
        request.once('error', (error) => {
            if (input.signal?.aborted) reject(input.signal.reason ?? error);
            else resolve(false);
        });
        request.end();
    });
}

export function createLocalServiceEndpointEnricher(
    params: LocalServiceEndpointEnricherParams,
): LocalServiceEndpointEnricher {
    const probe = params.probe ?? defaultProbe;
    const classify = async (
        entry: NormalizedLocalServiceInventoryEntry,
        requestSignal?: AbortSignal,
        observations?: Map<string, Promise<LocalServiceEndpointFact>>,
    ): Promise<LocalServiceEndpointFact | null> => {
        const signals = [params.signal, requestSignal].filter((signal): signal is AbortSignal => Boolean(signal));
        const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
        signal?.throwIfAborted();
        if (entry.state !== 'listening') return entry.endpoint ?? null;
        // Known host endpoints are control planes, not candidate application pages.
        if (entry.classification?.kind === 'happier') return null;
        const host = endpointHostForEntry(entry);
        if (!host) return null;
        const now = params.now();
        const observe = async (): Promise<LocalServiceEndpointFact> => {
            signal?.throwIfAborted();
            const probeInput = { host, port: entry.port, signal };
            const httpsReady = await probe({ ...probeInput, scheme: 'https' });
            const httpReady = httpsReady === true ? false : await probe({ ...probeInput, scheme: 'http' });
            signal?.throwIfAborted();
            const scheme: LocalServiceEndpointScheme = httpsReady === true
                ? 'https'
                : httpReady === true
                    ? 'http'
                    : 'unknown';
            return scheme === 'unknown'
                ? {
                    scheme,
                    host,
                    port: entry.port,
                    probeState: 'unknown',
                    probedAt: now,
                    reasonCode: httpsReady === 'inconclusive' || httpReady === 'inconclusive'
                        ? 'endpoint_probe_inconclusive' : 'endpoint_probe_failed',
                }
                : {
                    scheme,
                    host,
                    port: entry.port,
                    probeState: 'ready',
                    probedAt: now,
                };
        };
        // Share only this explicit operation's observation, never a later Open.
        const endpointKey = JSON.stringify([host, entry.port]);
        let observation = observations?.get(endpointKey);
        if (!observation) {
            observation = observe();
            observations?.set(endpointKey, observation);
        }
        return await observation;
    };

    return {
        resolve: (entry, signal) => classify(entry, signal),
        async enrich(snapshot) {
            const observations = new Map<string, Promise<LocalServiceEndpointFact>>();
            const entries = await Promise.all(snapshot.entries.map(async (entry) => {
                const endpoint = await classify(entry, undefined, observations);
                return endpoint ? { ...entry, endpoint } : entry;
            }));
            return { ...snapshot, entries };
        },
    };
}
