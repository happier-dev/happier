import { describe, expect, it } from 'vitest';

import {
    buildLocalServiceEndpointUrl,
    createLocalServiceEndpointEnricher,
} from './endpoint';
import { normalizeLocalServiceScan, type NormalizedLocalServiceInventoryEntry } from './scanner';

function listenerEntry(pid: number, processStartTimeMs: number, now = 2_000): NormalizedLocalServiceInventoryEntry {
    const snapshot = normalizeLocalServiceScan({
        machineId: 'machine-a', now, previous: null, workspaces: [], ownership: [],
        listeners: [{ address: '127.0.0.1', port: 8443, protocol: 'tcp', pid }],
        processes: new Map([[pid, { pid, processStartTimeMs, command: 'server' }]]),
    });
    const listener = snapshot.entries[0];
    if (!listener) throw new Error('Expected a normalized listener');
    return listener;
}

function entry(overrides: Partial<NormalizedLocalServiceInventoryEntry> = {}): NormalizedLocalServiceInventoryEntry {
    return {
        id: 'entry-a',
        machineId: 'machine-a',
        address: { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' },
        port: 8443,
        protocol: 'tcp',
        detectedAt: 1_000,
        lastSeenAt: 2_000,
        state: 'listening',
        source: 'detected',
        labels: [],
        confidence: 'high',
        processOwnershipConfidence: 'medium',
        workspaceAssociationConfidence: 'high',
        diagnostics: [],
        presentation: { addressLabel: 'localhost:8443' },
        ...overrides,
    } as NormalizedLocalServiceInventoryEntry;
}

describe('local service endpoint facts', () => {
    it('shares endpoint observations across duplicate rows within each explicit presentation demand', async () => {
        let probes = 0;
        const enricher = createLocalServiceEndpointEnricher({
            now: () => 2_000,
            probe: async ({ scheme }) => { probes += 1; return scheme === 'http'; },
        });
        const entries = Array.from({ length: 120 }, (_, index) => entry({
            id: `listener-${index}`, port: 5_000 + index % 3,
            address: index % 2 === 0
                ? { kind: 'loopback', host: '127.0.0.1', family: 'ipv4' }
                : { kind: 'wildcard', host: '0.0.0.0', family: 'ipv4' },
        }));
        const snapshot = { v: 1 as const, machineId: 'machine-a', generatedAt: 2_000,
            refreshState: 'idle' as const, entries, diagnostics: [] };
        const cold = await enricher.enrich(snapshot);
        expect(cold.entries.every(row => row.endpoint?.scheme === 'http')).toBe(true);
        // HTTPS then HTTP once per unique endpoint, independent of row count and queued slots.
        expect(probes).toBe(6);
        const warm = await enricher.enrich({ ...snapshot, entries: [...entries].reverse() });
        expect(warm.entries.every(row => row.endpoint?.scheme === 'http')).toBe(true);
        expect(probes).toBe(12);
    });

    it.each([
        { replacement: 'another process', pid: 202, start: 1_000 },
        { replacement: 'the same PID with a new start time', pid: 101, start: 1_500 },
    ])('observes a port taken over by $replacement on the next Open', async ({ pid, start }) => {
        let scheme = 'http';
        const enricher = createLocalServiceEndpointEnricher({
            now: () => 2_000,
            probe: async (input) => input.scheme === scheme,
        });
        const original = listenerEntry(101, 1_000);
        expect(await enricher.resolve(original)).toMatchObject({ scheme: 'http', probeState: 'ready' });

        scheme = 'https';
        const replacement = listenerEntry(pid, start);
        expect(await enricher.resolve(replacement)).toMatchObject({ scheme: 'https', probeState: 'ready' });
    });

    it('does not reuse a failed observation for a replacement listener during inventory enrichment', async () => {
        let ready = false;
        const enricher = createLocalServiceEndpointEnricher({
            now: () => 2_000,
            probe: async () => ready,
        });
        const snapshot = {
            v: 1 as const, machineId: 'machine-a', generatedAt: 2_000, refreshState: 'idle' as const,
            entries: [listenerEntry(101, 1_000)], diagnostics: [],
        };
        expect((await enricher.enrich(snapshot)).entries[0]?.endpoint).toMatchObject({
            scheme: 'unknown', probeState: 'unknown', reasonCode: 'endpoint_probe_failed',
        });

        ready = true;
        const replacement = await enricher.enrich({ ...snapshot, entries: [listenerEntry(202, 1_500)] });
        expect(replacement.entries[0]?.endpoint).toMatchObject({ scheme: 'https', probeState: 'ready' });
    });

    it.each(['http', 'unknown'])('observes current demand after an earlier %s observation for an unchanged listener', async (scheme) => {
        let now = 2_000;
        let observedScheme = scheme;
        const enricher = createLocalServiceEndpointEnricher({
            now: () => now, probe: async (input) => input.scheme === observedScheme,
        });
        const snapshot = {
            v: 1 as const, machineId: 'machine-a', generatedAt: now, refreshState: 'idle' as const,
            entries: [listenerEntry(101, 1_000, now)], diagnostics: [],
        };
        const first = await enricher.enrich(snapshot);
        expect(first.entries[0]?.endpoint?.scheme).toBe(scheme);

        now += 1;
        observedScheme = 'https';
        const refreshed = await enricher.enrich({
            ...snapshot, generatedAt: now, entries: [listenerEntry(101, 1_000, now)],
        });
        expect(refreshed.entries[0]?.endpoint).toMatchObject({ scheme: 'https', probeState: 'ready', probedAt: now });
        expect(await enricher.resolve(snapshot.entries[0]!)).toMatchObject({ scheme: 'https', probeState: 'ready', probedAt: now });
    });

    it('preserves internal listener inventory without probing a Happier control endpoint', async () => {
        const probes: number[] = [];
        const enricher = createLocalServiceEndpointEnricher({
            now: () => 2_000,
            probe: async ({ port }) => { probes.push(port); return true; },
        });
        const internal = entry({ classification: { kind: 'happier', confidence: 'high', signals: ['owner:happier'] } });
        const application = entry({ id: 'app', port: 5173 });
        const snapshot = await enricher.enrich({
            v: 1, machineId: 'machine-a', generatedAt: 2_000, refreshState: 'idle',
            entries: [internal, application], diagnostics: [],
        });
        expect(snapshot.entries[0]).toEqual(internal);
        expect(snapshot.entries[1]?.endpoint?.probeState).toBe('ready');
        expect(probes).toEqual([5173]);
    });

    it('builds URLs from the canonical endpoint fact', () => {
        expect(buildLocalServiceEndpointUrl({
            scheme: 'https',
            host: '127.0.0.1',
            port: 8443,
            probeState: 'ready',
            probedAt: 2_000,
        })).toBe('https://127.0.0.1:8443/');
        expect(buildLocalServiceEndpointUrl({
            scheme: 'http',
            host: '::1',
            port: 5173,
            probeState: 'ready',
            probedAt: 2_000,
        })).toBe('http://[::1]:5173/');
        expect(buildLocalServiceEndpointUrl({
            scheme: 'unknown',
            host: '127.0.0.1',
            port: 5173,
            probeState: 'unknown',
            probedAt: 2_000,
        })).toBeNull();
    });

    it('classifies HTTPS before HTTP using demanded loopback probes', async () => {
        const calls: string[] = [];
        const enricher = createLocalServiceEndpointEnricher({
            now: () => 2_000,
            probe: async ({ scheme, host, port }) => {
                calls.push(`${scheme}://${host}:${port}`);
                return scheme === 'https';
            },
        });

        const snapshot = await enricher.enrich({
            v: 1,
            machineId: 'machine-a',
            generatedAt: 2_000,
            refreshState: 'idle',
            entries: [entry()],
            diagnostics: [],
        });

        expect(snapshot.entries[0]?.endpoint).toEqual({
            scheme: 'https',
            host: '127.0.0.1',
            port: 8443,
            probeState: 'ready',
            probedAt: 2_000,
        });
        expect(calls).toEqual(['https://127.0.0.1:8443']);
    });

    it('records unknown endpoint state when neither HTTP nor HTTPS responds', async () => {
        const enricher = createLocalServiceEndpointEnricher({
            now: () => 2_000,
            probe: async () => false,
        });

        const snapshot = await enricher.enrich({
            v: 1,
            machineId: 'machine-a',
            generatedAt: 2_000,
            refreshState: 'idle',
            entries: [entry()],
            diagnostics: [],
        });

        expect(snapshot.entries[0]?.endpoint).toEqual({
            scheme: 'unknown',
            host: '127.0.0.1',
            port: 8443,
            probeState: 'unknown',
            probedAt: 2_000,
            reasonCode: 'endpoint_probe_failed',
        });
    });

    it('maps wildcard binds to a loopback probe host by address family', async () => {
        const probedHosts: string[] = [];
        const enricher = createLocalServiceEndpointEnricher({
            now: () => 2_000,
            probe: async ({ host }) => {
                probedHosts.push(host);
                return true;
            },
        });

        const snapshot = await enricher.enrich({
            v: 1,
            machineId: 'machine-a',
            generatedAt: 2_000,
            refreshState: 'idle',
            entries: [
                entry({ id: 'wild4', address: { kind: 'wildcard', host: '0.0.0.0', family: 'ipv4' } }),
                entry({ id: 'wild6', address: { kind: 'wildcard', host: '::', family: 'ipv6' } }),
            ],
            diagnostics: [],
        });

        expect(snapshot.entries.map((candidate) => candidate.endpoint?.host)).toEqual(['127.0.0.1', '::1']);
        expect(probedHosts).toEqual(['127.0.0.1', '::1']);
    });
});
