import { describe, expect, it } from 'vitest';
import { createCaptureStore, captureMigrations } from '../store/capture.js';
import { createCaptureSqliteFixture } from '../testing/sqlite.js';
import { PLUGIN_DAEMON_DATABASE_DEFAULT_LIMITS_V1 as limits } from '@happier-dev/plugin-sdk/storage';

describe('retained collector partition inventory', () => {
    it('enumerates each retained partition through host-bounded pages, including offline-removed environments', async () => {
        const fixture = createCaptureSqliteFixture();
        try {
            for (const migration of captureMigrations) await migration.up(fixture.db);
            const store = createCaptureStore(fixture.db, () => {});
            const count = limits.maximumResultRows + 1;
            for (let i = 0; i < count; i++) await fixture.db.execute('INSERT INTO captureSummaries(id,worktree,kind,source,at) VALUES(?,?,?,?,?)',
                [`query-${i}`, `environment:${String(i).padStart(8, '0')}`, 'span', 'otlp', i]);
            await fixture.db.execute('INSERT INTO captureSummaries(id,worktree,kind,source,at) VALUES(?,?,?,?,?)', ['local', 'worktree-local', 'query', 'wire', 1]);
            await fixture.db.execute('INSERT INTO captureDetails(id,worktree,at,body) VALUES(?,?,?,?)', ['detail', 'environment:orphaned-detail', 1, '{}']);
            const partitions = await store.listPartitions();
            expect(partitions).toHaveLength(count + 2);
            expect(new Set(partitions).size).toBe(count + 2);
            expect(partitions).toContain('environment:orphaned-detail');
            expect(partitions.at(0)).toBe('environment:00000000');
            expect(partitions.at(-1)).toBe('worktree-local');
        } finally { fixture.close(); }
    });
});
