import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import type { DaemonDatabaseService } from '@happier-dev/plugin-sdk/storage';
import { createCaptureBackgroundOwner } from '../background.js';
import { createCaptureSqliteFixture } from '../testing/sqlite.js';
import { runTelemetryCollector } from './runner.js';

describe('registered production collector runner', () => {
    it.each(['machine', 'deployed-app'] as const)('publishes the %s collector, joins shutdown and resumes assigned telemetry after role restart', async placement => {
        let deployedAppPort: number | undefined;
        if (placement === 'deployed-app') {
            const reservation = createServer();
            await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve));
            const address = reservation.address();
            if (!address || typeof address === 'string') throw new Error('missing test port');
            deployedAppPort = address.port;
            await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
        }
        const fixture = createCaptureSqliteFixture();
        const owner = createCaptureBackgroundOwner();
        const lifetime = new AbortController();
        const restartedLifetime = new AbortController();
        let readEndpoint: (() => string | null) | null = null;
        const endpointNow = () => readEndpoint?.();
        let subscriptions = 0;
        let reads = 0;
        let assigned = true;
        let refresh: (() => Promise<void>) | undefined;
        let published = 0;
        const token = 'production-token';
        let initialized = false;
        const storage: DaemonDatabaseService = { async database(_name, options) {
            if (!initialized) {
                for (const migration of options.migrations ?? []) await migration.up(fixture.db);
                initialized = true;
            }
            return fixture.db;
        } };
        const start = (signal: AbortSignal) => runTelemetryCollector({ signal, services: { storage: { daemon: storage },
            deploymentTelemetry: {
                ...(deployedAppPort === undefined ? {} : { deployedAppPort }),
                async readAssignments() { reads++; return assigned ? [{ environmentId: 'A', tokenHash: createHash('sha256').update(token).digest('hex') }] : []; },
                subscribeAssignmentsChanged(notify) { refresh = notify; subscriptions++; return () => { subscriptions--; }; },
                exposeEndpoint(read) { published++; readEndpoint = read; return () => { published--; readEndpoint = null; }; },
            },
        } }, owner);
        const settled = start(lifetime.signal);
        let restarted: Promise<void> | undefined;
        try {
            const endpointPattern = placement === 'deployed-app' ? /^http:\/\/0\.0\.0\.0:/ : /^http:\/\/127\.0\.0\.1:/;
            await vi.waitFor(() => expect(endpointNow()).toMatch(endpointPattern));
            if (deployedAppPort !== undefined) expect(new URL(endpointNow()!).port).toBe(String(deployedAppPort));
            const endpoint = endpointNow();
            const response = await fetch(`${endpoint}/v1/logs`, { method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: '1700000000000000000', body: { stringValue: 'observed' } }] }] }] }),
            });
            expect(response.status).toBe(200);
            await owner.readRuntime()?.ingest.settled();
            expect(await owner.readRuntime()?.store.listPartitions()).toEqual(['environment:A']);
            expect(reads).toBe(1);
            expect(subscriptions).toBe(1);
            assigned = false;
            await refresh?.();
            expect(published).toBe(0);
            expect(readEndpoint).toBeNull();
            await expect(fetch(`${endpoint}/v1/logs`, { method: 'POST', body: '{}' })).rejects.toThrow();
            assigned = true;
            await refresh?.();
            expect(published).toBe(1);
            expect(endpointNow()).toMatch(endpointPattern);
            expect(await owner.readRuntime()?.store.listPartitions()).toEqual([]);
            expect((await fetch(`${endpointNow()}/v1/logs`, { method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: '1700000001000000000', body: { stringValue: 'reassigned' } }] }] }] }),
            })).status).toBe(200);
            await owner.readRuntime()?.ingest.settled();
            lifetime.abort();
            await settled;
            expect(readEndpoint).toBeNull();
            expect(subscriptions).toBe(0);
            expect(owner.readRuntime()).toBeNull();
            await expect(fetch(`${endpoint}/v1/logs`, { method: 'POST', body: '{}' })).rejects.toThrow();

            restarted = start(restartedLifetime.signal);
            await vi.waitFor(() => expect(endpointNow()).toMatch(endpointPattern));
            if (deployedAppPort !== undefined) expect(new URL(endpointNow()!).port).toBe(String(deployedAppPort));
            const restartedEndpoint = endpointNow();
            expect((await fetch(`${restartedEndpoint}/v1/logs`, { method: 'POST', headers: {
                Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
            }, body: '{}' })).status).toBe(200);
            expect(await owner.readRuntime()?.store.listPartitions()).toContain('environment:A');
            expect(reads).toBe(4);
            expect(subscriptions).toBe(1);
        } finally {
            lifetime.abort(); restartedLifetime.abort();
            try { await Promise.all([settled, restarted]); }
            finally { fixture.close(); }
        }
    });
});
