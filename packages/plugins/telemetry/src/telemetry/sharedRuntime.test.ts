import { describe, expect, it } from 'vitest';
import { createCaptureBackgroundOwner } from '../background.js';
import { createCaptureSqliteFixture } from '../testing/sqlite.js';
import type { DaemonDatabaseService } from '@happier-dev/plugin-sdk/storage';

describe('local and production shared capture custody', () => {
    it('keeps one writer usable after the role that first opened storage aborts', async () => {
        const fixture = createCaptureSqliteFixture();
        let initialized = false;
        const storage: DaemonDatabaseService = { async database(_name, options) {
            // The host binds each returned handle to its invocation signal. This
            // boundary fixture preserves that cancellation around real SQLite.
            if (!initialized) {
                initialized = true;
                for (const migration of options.migrations ?? []) await migration.up(fixture.db);
            }
            const check = () => options.signal?.throwIfAborted();
            return {
                async query(sql, values, operation) { check(); return fixture.db.query(sql, values, operation); },
                async execute(sql, values, operation) { check(); return fixture.db.execute(sql, values, operation); },
                async transaction(callback, operation) { check(); return fixture.db.transaction(callback, operation); },
            };
        } };
        const owner = createCaptureBackgroundOwner();
        const localLifetime = new AbortController(), telemetryLifetime = new AbortController();
        const context = (signal: AbortSignal) => ({ signal, services: { storage: { daemon: storage } } });
        try {
            const [local, telemetry] = await Promise.all([owner.acquireRuntime(context(localLifetime.signal)), owner.acquireRuntime(context(telemetryLifetime.signal))]);
            expect(local.runtime).toBe(telemetry.runtime);
            localLifetime.abort();
            await local.release();
            await telemetry.runtime.store.write([{ id: 'retained', worktree: 'environment:A', kind: 'span', source: 'otlp', at: 1 }]);
            expect(await telemetry.runtime.store.listPartitions()).toEqual(['environment:A']);
            expect(owner.readRuntime()).toBe(telemetry.runtime);
            telemetryLifetime.abort();
            await telemetry.release();
            await telemetry.release();
            expect(owner.readRuntime()).toBeNull();
        } finally { localLifetime.abort(); telemetryLifetime.abort(); fixture.close(); }
    });
});
