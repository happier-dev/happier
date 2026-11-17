import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { startTelemetryCollector } from './collector.js';
import type { TelemetryAssignment } from './assignments.js';
import { createCaptureRuntime } from '../runtime.js';
import { captureMigrations } from '../store/capture.js';
import { createCaptureSqliteFixture } from '../testing/sqlite.js';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
async function fixture() {
    const database = createCaptureSqliteFixture();
    for (const migration of captureMigrations) await migration.up(database.db);
    const runtime = createCaptureRuntime({ database: database.db, publish: () => {},
        normalizeStatement: () => { throw new Error('No SQL in fixture'); } });
    return { ...database, runtime };
}

describe('production collector assignment lifecycle', () => {
    it('reports an unavailable inventory instead of silently retaining offline-removed data', async () => {
        const database = await fixture();
        let reads = 0;
        const unavailable = createCaptureRuntime({ database: { ...database.db, async query() { throw new Error('storage_unavailable'); } },
            publish: () => {}, normalizeStatement: () => { throw new Error('No SQL in fixture'); } });
        try {
            await expect(startTelemetryCollector({ port: 0, runtime: unavailable,
                readAssignments: async () => { reads++; return []; }, subscribeAssignmentsChanged: () => () => {},
            })).rejects.toThrow('storage_unavailable');
            expect(reads).toBe(0);
        } finally { database.close(); }
    });

    it('uses the shared runtime, rotates on push and removes only withdrawn environment partitions', async () => {
        const database = await fixture();
        const { runtime } = database;
        for (const partition of ['environment:offline-removed', 'environment:A', 'environment:B', 'local-worktree']) {
            await runtime.store.write([{ id: partition, worktree: partition, kind: 'span', source: 'otlp', at: 1 }]);
        }
        let assignments: readonly TelemetryAssignment[] = [{ environmentId: 'A', tokenHash: hash('token-A') }, { environmentId: 'B', tokenHash: hash('token-B') }];
        let reads = 0;
        let notify: (() => Promise<void>) | undefined;
        let subscribed = 0;
        const collector = await startTelemetryCollector({ port: 0, runtime,
            readAssignments: async () => { reads++; return assignments; },
            subscribeAssignmentsChanged: refresh => { notify = refresh; subscribed++; return () => { subscribed--; }; },
        });
        const send = (token: string) => fetch(`${collector.endpoint()}/v1/traces`, {
            method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: '{}',
        });
        try {
            expect(collector.endpoint()).toMatch(/^http:\/\/127\.0\.0\.1:/);
            expect(reads).toBe(1);
            expect(subscribed).toBe(1);
            expect(await runtime.store.listPartitions()).toEqual(['environment:A', 'environment:B', 'local-worktree']);
            expect((await send('token-A')).status).toBe(200);
            const originalEndpoint = collector.endpoint();
            assignments = [{ environmentId: 'A', tokenHash: hash('rotated-A') }, { environmentId: 'B', tokenHash: null }];
            await notify?.();
            expect(reads).toBe(2);
            expect(collector.endpoint()).toBe(originalEndpoint);
            expect((await send('token-A')).status).toBe(401);
            expect((await send('rotated-A')).status).toBe(200);
            expect(await runtime.store.listPartitions()).toContain('environment:B');
            assignments = [{ environmentId: 'B', tokenHash: null }];
            await notify?.();
            expect(await runtime.store.listPartitions()).toEqual(['environment:B', 'local-worktree']);
            expect((await send('rotated-A')).status).toBe(401);
            assignments = [];
            await notify?.();
            expect(collector.endpoint()).toBeNull();
            expect(await runtime.store.listPartitions()).toEqual(['local-worktree']);
            expect(reads).toBe(4);
        } finally { await collector.stop(); expect(subscribed).toBe(0); await runtime.ingest.settled(); database.close(); }
    });

    it('keeps no receiver with zero assignments and opens on the next pushed assignment', async () => {
        const database = await fixture();
        let notify: (() => Promise<void>) | undefined;
        let assignments: readonly TelemetryAssignment[] = [];
        let reads = 0;
        const collector = await startTelemetryCollector({ port: 0, runtime: database.runtime,
            readAssignments: async () => { reads++; return assignments; },
            subscribeAssignmentsChanged: refresh => { notify = refresh; return () => {}; },
        });
        try {
            expect(collector.endpoint()).toBeNull();
            expect(reads).toBe(1);
            assignments = [{ environmentId: 'new', tokenHash: null }];
            await notify?.();
            expect(collector.endpoint()).toMatch(/^http:\/\/127\.0\.0\.1:/);
            expect(reads).toBe(2);
        } finally { await collector.stop(); database.close(); }
    });
});
