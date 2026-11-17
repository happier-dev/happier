import { expect, it } from 'vitest';
import type { DatabaseCaptureCostMetadataV1 } from '@happier-dev/database-protocol';
import { captureMigrations, createCaptureStore } from './capture.js';
import { createCaptureSqliteFixture } from '../testing/sqlite.js';

const tokens = { input: 10, output: 5, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: null };
const usage: DatabaseCaptureCostMetadataV1 = { provider: 'openai', modelId: 'actual', requestedModel: 'requested',
    operation: 'chat', tokens, tokenCategories: tokens, reportedCost: { amount: 0.01, currency: 'USD' } };

it('keeps retained usage when an exporter repeats a span after app cost capture is disabled', async () => {
    const sqlite = createCaptureSqliteFixture();
    try {
        for (const migration of captureMigrations) await migration.up(sqlite.db);
        const store = createCaptureStore(sqlite.db, () => {});
        const span = { id: 'call', worktree: 'environment:0', kind: 'span' as const, source: 'otlp' as const,
            at: 1000, serviceName: 'api', serviceVersion: 'build-1' };
        await store.write([{ ...span, genAi: usage }]);
        await store.write([span]);
        expect(await store.costOperands({ worktree: span.worktree, since: 1000, until: 2000 }))
            .toMatchObject([{ callCount: 1, reportedCost: usage.reportedCost, tokens }]);
    } finally { sqlite.close(); }
});

it('aggregates only the selected source/service/version/window, preserving unknown masks and currencies without a second ledger', async () => {
    const sqlite = createCaptureSqliteFixture();
    try {
        for (const migration of captureMigrations) await migration.up(sqlite.db);
        const publications: string[][] = [];
        const store = createCaptureStore(sqlite.db, keys => publications.push([...keys]));
        const events = Array.from({ length: 1000 }, (_, index) => ({
            id: String(index), worktree: `environment:${Math.floor(index / 10)}`, kind: 'span' as const, source: 'otlp' as const,
            at: 1000 + index % 10, serviceName: 'api', serviceVersion: 'build-1', genAi: usage,
        }));
        await store.write(events);
        await store.write(events); // Real exporter retry: the same span never becomes another call or publication.
        expect(publications).toHaveLength(1);
        const partial = { ...usage, tokens: { ...tokens, cacheRead: null }, tokenCategories: null, reportedCost: null };
        await store.write([
            { ...events[0]!, id: 'partial', genAi: partial },
            { ...events[0]!, id: 'eur', genAi: { ...usage, reportedCost: { amount: 0.02, currency: 'EUR' } } },
            { ...events[0]!, id: 'other-service', serviceName: 'worker' },
            { ...events[0]!, id: 'other-version', serviceVersion: 'build-2' },
            { ...events[0]!, id: 'outside-window', at: 2000 },
        ]);
        const before = sqlite.queryRows.length;
        const items = await store.costOperands({ worktree: 'environment:0', since: 1000, until: 2000,
            serviceName: 'api', serviceVersion: 'build-1' });
        expect(sqlite.queryRows.slice(before)).toEqual([3]); // K groups returned; no per-span reads across 100 Environments.
        expect(items).toHaveLength(3);
        expect(items.find(item => item.reportedCost?.currency === 'USD')).toMatchObject({
            callCount: 10, bucketStartMs: 1000, firstSeenMs: 1000, lastSeenMs: 1009,
            tokens: { ...tokens, input: 100, output: 50 }, tokenCategories: { ...tokens, input: 100, output: 50 },
            reportedCost: { amount: expect.closeTo(0.1), currency: 'USD' },
        });
        expect(items.find(item => item.reportedCost === null)).toMatchObject({ callCount: 1, tokenCategories: null,
            tokens: { ...tokens, cacheRead: null } });
        expect(items.find(item => item.reportedCost?.currency === 'EUR')?.callCount).toBe(1);
        expect(await store.costOperands({ worktree: 'absent', since: 1000, until: 2000 })).toEqual([]);
        await store.clear('environment:0');
        expect(await store.costOperands({ worktree: 'environment:0', since: 1000, until: 2000 })).toEqual([]);
        expect(await store.costOperands({ worktree: 'environment:1', since: 1000, until: 2000 })).toHaveLength(1);
    } finally { sqlite.close(); }
});
