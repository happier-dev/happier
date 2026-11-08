import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, initDbMysql } from '@/storage/db';
import { inReadSnapshot } from '@/storage/inTx';
import { readUsageActivitySourceChanges, readUsageActivitySummaryChunks, readUsageActivitySummaryHead,
    saveUsageActivitySummary } from './usageActivitySummaryStore';

const provider = String(process.env.HAPPIER_DB_PROVIDER ?? process.env.HAPPY_DB_PROVIDER ?? '').trim().toLowerCase();

describe.skipIf(provider !== 'mysql')('MySQL usage activity summary storage contract', () => {
    let connected = false;
    beforeAll(async () => {
        if (!process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID) {
            throw new Error('Use the disposable Docker DB-contract harness for usage summary storage.');
        }
        await initDbMysql();
        await db.$connect();
        connected = true;
    });
    afterAll(async () => { if (connected) await db.$disconnect(); });

    it('compares native daily witnesses and publishes head, chunks and window changes with a binary CAS', async () => {
        const account = await db.account.create({ data: { publicKey: `mysql-usage-activity-${randomUUID()}` } });
        const session = await db.session.create({ data: { accountId: account.id, tag: 'summary-store', metadata: '{}' } });
        const firstDay = Date.UTC(2025, 0, 1);
        const nextDay = firstDay + 86_400_000;
        const updatedAt = new Date(firstDay + 100);
        const event = await db.usageEvent.create({ data: { accountId: account.id, sessionId: session.id,
            observedAt: new Date(firstDay + 100), agentId: 'codex', source: 'runtime', scope: 'turn_delta',
            totalTokens: 7, metadata: { exact: 'original' }, updatedAt } });
        await db.usageEvent.create({ data: { accountId: account.id, observedAt: new Date(nextDay + 100),
            agentId: 'codex', source: 'runtime', scope: 'turn_delta', contextWindowTokens: 100 } });
        const report = await db.usageReport.create({ data: { accountId: account.id, key: 'retained',
            data: { tokens: { total: 7 }, cost: { total: 0 } }, updatedAt } });
        const changes = await inReadSnapshot(tx => readUsageActivitySourceChanges(tx, account.id));
        expect(changes.map(({ kind, dayStartMs }) => ({ kind, dayStartMs }))).toEqual([
            { kind: 'event', dayStartMs: firstDay }, { kind: 'event', dayStartMs: nextDay },
            { kind: 'report', dayStartMs: firstDay },
        ]);
        expect(changes.every(change => typeof change.fingerprint === 'string')).toBe(true);
        expect(await saveUsageActivitySummary(account.id, null, 'first', new Map([['facts', 'initial body'], ['removed', 'old']]), changes)).toBe(true);
        expect(await inReadSnapshot(tx => readUsageActivitySourceChanges(tx, account.id))).toEqual([]);
        expect(await saveUsageActivitySummary(account.id, 'FIRST', 'stale', new Map([['facts', 'stale body']]), [])).toBe(false);
        expect(await inReadSnapshot(tx => readUsageActivitySummaryHead(tx, account.id))).toBe('first');
        expect(await inReadSnapshot(tx => readUsageActivitySummaryChunks(tx, account.id, ['facts', 'removed', 'missing'])))
            .toEqual(new Map([['facts', 'initial body'], ['removed', 'old']]));

        await db.usageEvent.update({ where: { id: event.id }, data: { metadata: { exact: 'changed' }, updatedAt } });
        const edited = await inReadSnapshot(tx => readUsageActivitySourceChanges(tx, account.id));
        expect(edited.map(({ kind, dayStartMs }) => ({ kind, dayStartMs })))
            .toEqual([{ kind: 'event', dayStartMs: firstDay }]);
        expect(edited[0]!.fingerprint).not.toBe(changes[0]!.fingerprint);
        expect(await saveUsageActivitySummary(account.id, 'first', 'second', new Map<string, string | null>([
            ['facts', 'edited body'], ['removed', null],
        ]), edited)).toBe(true);
        expect(await inReadSnapshot(tx => readUsageActivitySummaryChunks(tx, account.id, ['facts', 'removed'])))
            .toEqual(new Map([['facts', 'edited body']]));
        await db.session.delete({ where: { id: session.id } });
        const unlinked = await inReadSnapshot(tx => readUsageActivitySourceChanges(tx, account.id));
        expect(unlinked.map(({ kind, dayStartMs }) => ({ kind, dayStartMs })))
            .toEqual([{ kind: 'event', dayStartMs: firstDay }]);
        expect(unlinked[0]!.fingerprint).not.toBe(edited[0]!.fingerprint);
        expect(await saveUsageActivitySummary(account.id, 'second', 'unlinked', new Map([['facts', 'unlinked body']]), unlinked)).toBe(true);
        await db.usageReport.update({ where: { id: report.id }, data: {
            data: { tokens: { total: 8 }, cost: { total: 0 } }, updatedAt } });
        const reportChanges = await inReadSnapshot(tx => readUsageActivitySourceChanges(tx, account.id));
        expect(reportChanges.map(({ kind, dayStartMs }) => ({ kind, dayStartMs })))
            .toEqual([{ kind: 'report', dayStartMs: firstDay }]);
        expect(await saveUsageActivitySummary(account.id, 'unlinked', 'report changed', new Map([['facts', 'report body']]), reportChanges)).toBe(true);

        const bounded = await inReadSnapshot(tx => readUsageActivitySourceChanges(tx, account.id, nextDay));
        expect(bounded).toEqual([{ kind: 'event', dayStartMs: nextDay, fingerprint: null }]);
        expect(await saveUsageActivitySummary(account.id, 'report changed', 'bounded', new Map([['facts', 'first day']]), bounded)).toBe(true);
        expect((await inReadSnapshot(tx => readUsageActivitySourceChanges(tx, account.id))).map(({ kind, dayStartMs }) =>
            ({ kind, dayStartMs }))).toEqual([{ kind: 'event', dayStartMs: nextDay }]);
        expect((await inReadSnapshot(tx => readUsageActivitySummaryChunks(tx, account.id, ['facts']))).get('facts')).toBe('first day');
    });
});
