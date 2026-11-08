import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { inReadSnapshot } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { TEAM_CREDENTIAL_ONLY_USAGE_SOURCES } from '../usageSourceClassifier';
import { readUsageActivitySourceChanges, readUsageActivitySummaryChunks, readUsageActivitySummaryHead,
    saveUsageActivitySummary, USAGE_ACTIVITY_SUMMARY_VERSION } from './usageActivitySummaryStore';

describe('Usage activity summary storage', () => {
    let harness: LightSqliteHarness;
    beforeAll(async () => {
        harness = await createLightSqliteHarness({ tempDirPrefix: 'usage-activity-summary-store-',
            initAuth: false, initEncrypt: false, initFiles: false });
    }, 120_000);
    afterAll(async () => { await harness?.close(); });

    it('compares complete daily source content inside storage and detects same-timestamp edits and Session deletion', async () => {
        const account = await db.account.create({ data: {} });
        const unrelated = await db.account.create({ data: {} });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'summary-store', metadata: '{}' } });
        const firstDay = Date.UTC(2025, 0, 1);
        const nextDay = firstDay + 86_400_000;
        const originalUpdatedAt = new Date(nextDay);
        const event = await db.usageEvent.create({ data: { accountId: account.id, sessionId: session.id,
            observedAt: new Date(firstDay + 100), agentId: 'codex', source: 'runtime', scope: 'turn_delta',
            totalTokens: 7, metadata: { diagnostic: 'x'.repeat(128 * 1024), exact: 'original' }, updatedAt: originalUpdatedAt } });
        await db.usageEvent.create({ data: { accountId: account.id, observedAt: new Date(nextDay + 100),
            agentId: 'codex', source: 'runtime', scope: 'turn_delta', contextWindowTokens: 100 } });
        await db.usageEvent.createMany({ data: TEAM_CREDENTIAL_ONLY_USAGE_SOURCES.map(source => ({
            accountId: account.id, observedAt: new Date(nextDay + 86_400_000 + 100), agentId: 'codex', source, scope: 'turn_delta' })) });
        await db.usageEvent.create({ data: { accountId: unrelated.id, observedAt: new Date(nextDay + 2 * 86_400_000 + 100),
            agentId: 'codex', source: 'runtime', scope: 'turn_delta' } });
        const report = await db.usageReport.create({ data: { accountId: account.id, key: 'retained',
            data: { tokens: { total: 7 }, cost: { total: 0 } }, updatedAt: new Date(firstDay + 10) } });

        const changes = await inReadSnapshot(tx => readUsageActivitySourceChanges(tx, account.id));
        expect(changes.map(({ kind, dayStartMs }) => ({ kind, dayStartMs }))).toEqual([
            { kind: 'event', dayStartMs: firstDay }, { kind: 'event', dayStartMs: nextDay },
            { kind: 'report', dayStartMs: firstDay },
        ]);
        expect(changes.every(change => typeof change.fingerprint === 'string')).toBe(true);
        expect(await saveUsageActivitySummary(account.id, null, 'first', new Map([['facts', 'retained body']]), changes)).toBe(true);
        // A warm head lookup must not load or parse the retained body payload.
        expect((await db.usageAccountingProjection.findFirst({ where: { accountId: account.id,
            kind: `actSummary${USAGE_ACTIVITY_SUMMARY_VERSION}` }, select: { payload: true } }))?.payload).toBe('first');
        expect(await inReadSnapshot(tx => readUsageActivitySummaryHead(tx, account.id))).toBe('first');
        expect((await inReadSnapshot(tx => readUsageActivitySummaryChunks(tx, account.id, ['facts']))).get('facts')).toBe('retained body');
        expect(await inReadSnapshot(tx => readUsageActivitySourceChanges(tx, account.id))).toEqual([]);
        expect(await inReadSnapshot(tx => readUsageActivitySummaryHead(tx, unrelated.id))).toBeNull();

        await db.usageEvent.update({ where: { id: event.id }, data: {
            metadata: { diagnostic: 'x'.repeat(128 * 1024), exact: 'changed' }, updatedAt: originalUpdatedAt,
        } });
        const edited = await inReadSnapshot(tx => readUsageActivitySourceChanges(tx, account.id));
        expect(edited.map(({ kind, dayStartMs }) => ({ kind, dayStartMs }))).toEqual([{ kind: 'event', dayStartMs: firstDay }]);
        expect(edited[0]!.fingerprint).not.toBe(changes[0]!.fingerprint);
        expect(await saveUsageActivitySummary(account.id, 'first', 'second', new Map([['facts', 'edited body']]), edited)).toBe(true);
        await db.session.delete({ where: { id: session.id } });
        const unlinked = await inReadSnapshot(tx => readUsageActivitySourceChanges(tx, account.id));
        expect(unlinked.map(({ kind, dayStartMs }) => ({ kind, dayStartMs }))).toEqual([{ kind: 'event', dayStartMs: firstDay }]);
        expect(unlinked[0]!.fingerprint).not.toBe(edited[0]!.fingerprint);
        expect(await saveUsageActivitySummary(account.id, 'second', 'unlinked', new Map([['facts', 'unlinked body']]), unlinked)).toBe(true);
        await db.usageReport.update({ where: { id: report.id }, data: {
            data: { tokens: { total: 8 }, cost: { total: 0 } }, updatedAt: report.updatedAt } });
        const reportChanges = await inReadSnapshot(tx => readUsageActivitySourceChanges(tx, account.id));
        expect(reportChanges.map(({ kind, dayStartMs }) => ({ kind, dayStartMs }))).toEqual([{ kind: 'report', dayStartMs: firstDay }]);
        expect(await saveUsageActivitySummary(account.id, 'unlinked', 'report changed', new Map([['facts', 'report body']]), reportChanges)).toBe(true);
        await db.usageReport.delete({ where: { id: report.id } });
        expect(await inReadSnapshot(tx => readUsageActivitySourceChanges(tx, account.id)))
            .toEqual([{ kind: 'report', dayStartMs: firstDay, fingerprint: null }]);
    });

    it('atomically rejects stale publication and clears removed or excluded days before a later expansion', async () => {
        const account = await db.account.create({ data: {} });
        const firstDay = Date.UTC(2025, 1, 1);
        const nextDay = firstDay + 86_400_000;
        await db.usageEvent.createMany({ data: [firstDay, nextDay].map(observedAt => ({ accountId: account.id,
            observedAt: new Date(observedAt + 100), agentId: 'codex', source: 'runtime', scope: 'turn_delta' })) });
        const changes = await inReadSnapshot(tx => readUsageActivitySourceChanges(tx, account.id));
        expect(await saveUsageActivitySummary(account.id, null, 'first', new Map([['facts', 'both days']]), changes)).toBe(true);
        expect(await saveUsageActivitySummary(account.id, null, 'stale initial', new Map([['facts', 'stale']]), changes)).toBe(false);
        const bounded = await inReadSnapshot(tx => readUsageActivitySourceChanges(tx, account.id, nextDay));
        expect(bounded).toEqual([{ kind: 'event', dayStartMs: nextDay, fingerprint: null }]);
        expect(await saveUsageActivitySummary(account.id, 'incorrect head', 'stale update', new Map([['facts', 'stale']]), bounded)).toBe(false);
        expect(await inReadSnapshot(tx => readUsageActivitySourceChanges(tx, account.id))).toEqual([]);
        expect(await inReadSnapshot(tx => readUsageActivitySummaryHead(tx, account.id))).toBe('first');
        expect((await inReadSnapshot(tx => readUsageActivitySummaryChunks(tx, account.id, ['facts']))).get('facts')).toBe('both days');
        expect(await saveUsageActivitySummary(account.id, 'first', 'bounded', new Map([['facts', 'first day']]), bounded)).toBe(true);
        expect((await inReadSnapshot(tx => readUsageActivitySourceChanges(tx, account.id))).map(({ kind, dayStartMs }) =>
            ({ kind, dayStartMs }))).toEqual([{ kind: 'event', dayStartMs: nextDay }]);
        expect((await inReadSnapshot(tx => readUsageActivitySummaryChunks(tx, account.id, ['facts']))).get('facts')).toBe('first day');
        await db.account.delete({ where: { id: account.id } });
        expect(await db.usageAccountingProjection.count({ where: { accountId: account.id } })).toBe(0);
    });

    it('stores keyed chunks independently across portable batches and atomically replaces only changed chunks', async () => {
        const account = await db.account.create({ data: {} });
        const unrelated = await db.account.create({ data: {} });
        const retained = JSON.stringify({ metadata: { arbitrary: '你好🧪'.repeat(16_384) } });
        const initial = new Map(Array.from({ length: 1_001 }, (_, index) => [`index:${index}`, JSON.stringify({ index })]));
        initial.set('subjects:retained', retained);
        initial.set('subjects:removed', 'removed');
        expect(await saveUsageActivitySummary(account.id, null, 'initial', initial, [])).toBe(true);
        expect(await inReadSnapshot(tx => readUsageActivitySummaryChunks(tx, account.id,
            ['subjects:retained', 'subjects:removed', 'missing']))).toEqual(new Map([
            ['subjects:retained', retained], ['subjects:removed', 'removed'],
        ]));
        expect(await inReadSnapshot(tx => readUsageActivitySummaryChunks(tx, unrelated.id, ['subjects:retained']))).toEqual(new Map());
        const physicalBefore = await db.usageAccountingProjection.findMany({ where: { accountId: account.id,
            kind: `actChunk${USAGE_ACTIVITY_SUMMARY_VERSION}` }, select: { recordKey: true, payload: true } });
        expect(physicalBefore).toHaveLength(initial.size);
        const compressed = physicalBefore.find(row => row.payload.length > 100);
        expect(compressed).toBeDefined();
        expect(Buffer.byteLength(compressed!.payload)).toBeLessThan(Buffer.byteLength(retained) / 4);

        const partial = new Map<string, string | null>([['index:0', 'changed'], ['subjects:removed', null]]);
        expect(await saveUsageActivitySummary(account.id, 'stale', 'rejected', partial, [])).toBe(false);
        expect(await inReadSnapshot(tx => readUsageActivitySummaryHead(tx, account.id))).toBe('initial');
        expect(await inReadSnapshot(tx => readUsageActivitySummaryChunks(tx, account.id, [...initial.keys()]))).toEqual(initial);
        expect(await saveUsageActivitySummary(account.id, 'initial', 'advanced', partial, [])).toBe(true);
        const expected = new Map(initial);
        expected.set('index:0', 'changed');
        expected.delete('subjects:removed');
        expect(await inReadSnapshot(tx => readUsageActivitySummaryChunks(tx, account.id, [...initial.keys()]))).toEqual(expected);
        const physicalAfter = new Map((await db.usageAccountingProjection.findMany({ where: { accountId: account.id,
            kind: `actChunk${USAGE_ACTIVITY_SUMMARY_VERSION}` }, select: { recordKey: true, payload: true } }))
            .map(row => [row.recordKey, row.payload]));
        expect(physicalBefore.filter(row => physicalAfter.get(row.recordKey) === row.payload)).toHaveLength(initial.size - partial.size);
    });
});
