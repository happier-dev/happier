import { describe, expect, it } from 'vitest';

import {
    buildLocalServiceEndpointUrl,
    createLocalServiceEndpointEnricher,
} from './endpoint';
import type { NormalizedLocalServiceInventoryEntry } from './scanner';

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

    it('classifies HTTPS before HTTP using bounded loopback probes', async () => {
        const calls: string[] = [];
        const enricher = createLocalServiceEndpointEnricher({
            now: () => 2_000,
            timeoutMs: 50,
            concurrency: 1,
            successTtlMs: 1_000,
            failureTtlMs: 1_000,
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
            timeoutMs: 50,
            concurrency: 1,
            successTtlMs: 1_000,
            failureTtlMs: 1_000,
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
            timeoutMs: 50,
            concurrency: 1,
            successTtlMs: 1_000,
            failureTtlMs: 1_000,
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
