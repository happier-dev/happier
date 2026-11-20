import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransactionClient } from '@/storage/prisma';

const database = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock('@/storage/db', async importOriginal => ({
    ...await importOriginal<typeof import('@/storage/db')>(),
    db: { $transaction: database.transaction },
}));

import { createUsageSnapshot } from '../providerAccountUsageTestkit';
import { writeProviderAccountUsageRecordWithPolicy } from './routeWritePolicy';
import { ProviderAccountUsagePayloadInvariantError } from './types';

function databaseBoundary(meterCount: number) {
    const first = createUsageSnapshot({ fetchedAt: Date.now() - 10_000 });
    const snapshot = { ...first, meters: Array.from({ length: meterCount }, (_, index) => ({
        ...first.meters[0]!, meterId: `meter-${index}`,
    })) };
    const operations: string[] = [];
    let mode = 'plain';
    const stored = { accountId: 'owner', recordId: snapshot.recordId, recordKeyJson: snapshot.recordKey,
        payloadMode: 'plain_json_v1', status: 'ok', snapshot,
        sealedPayload: null, fetchedAt: new Date(snapshot.fetchedAtMs),
        staleAfterMs: snapshot.staleAfterMs, refreshRequestedAt: null, metadata: { materialFingerprint: 'fixture', daySummaryPendingDays: [] },
        history: [{ id: 'retained' }] };
    const retained: unknown[] = [];
    const parentUpdate = vi.fn(async () => { operations.push('record.update'); return { id: 'record' }; });
    const updateMany = vi.fn(async () => { operations.push('record.update'); return { count: 1 }; });
    const insertHistory = vi.fn(async (args: { data: unknown }) => {
        operations.push('history.insert'); retained.push(args.data); return { id: 'history' };
    });
    // Prisma is the external boundary. Admission, merge/CAS, history projection,
    // inTx and terminal Account publication all execute their production logic.
    const tx = {
        $queryRaw: vi.fn(async (query: unknown) => {
            const sql = query && typeof query === 'object' && 'sql' in query ? String(query.sql) : '';
            if (sql.includes('AS "pendingDays"')) { operations.push('pending.read'); return [{ pendingDays: [] }]; }
            return [{ statement_timeout: '0' }];
        }),
        $executeRaw: vi.fn(async (query: unknown) => {
            const sql = query && typeof query === 'object' && 'sql' in query ? String(query.sql) : '';
            operations.push(sql.includes('ProviderAccountUsageDaySummary') ? 'summary.invalidate' : 'pending.update'); return 1;
        }),
        $executeRawUnsafe: vi.fn(async () => 1),
        $queryRawUnsafe: vi.fn(async (sql: string) => {
            if (sql.includes('FOR KEY SHARE')) operations.push('admission');
            else if (sql.includes('FOR NO KEY UPDATE')) operations.push('publication.lock');
            else if (sql.includes('INSERT INTO "AccountChange"')) {
                operations.push('publication.write'); return [{ cursor: 1 }];
            } else throw new Error('Unexpected database statement');
            return [{ id: 'owner' }];
        }),
        account: { findUnique: vi.fn(async () => {
            operations.push('mode.read');
            return { encryptionMode: mode, publicKey: null, contentPublicKey: null, contentPublicKeySig: null };
        }) },
        accountChange: { findMany: vi.fn(async () => {
            operations.push('publication.read');
            return [];
        }) },
        providerAccountUsageRecord: { findUnique: vi.fn(async () => stored), updateMany, update: parentUpdate },
        providerAccountUsageHistory: { findFirst: vi.fn(async () => null), create: insertHistory },
    };
    database.transaction.mockImplementation(async (callback: (client: TransactionClient) => Promise<unknown>) =>
        callback(tx as unknown as TransactionClient));
    const write = (kind: 'material' | 'freshness' | 'noop' = 'material') => writeProviderAccountUsageRecordWithPolicy({ accountId: 'owner',
        recordId: snapshot.recordId, recordKey: snapshot.recordKey, payloadMode: 'plain_json_v1', status: 'ok',
        materialFingerprint: 'fixture',
        fetchedAt: snapshot.fetchedAtMs + (kind === 'noop' ? 0 : 1000), staleAfterMs: snapshot.staleAfterMs,
        snapshot: { ...snapshot, fetchedAtMs: snapshot.fetchedAtMs + (kind === 'noop' ? 0 : 1000),
            observedAtMs: snapshot.observedAtMs + (kind === 'noop' ? 0 : 1000),
            ...(kind === 'material' ? { planLabel: 'changed plan' } : {}) } });
    return { operations, retained, write, parentUpdate, updateMany, insertHistory,
        changeMode: () => { mode = 'e2ee'; }, tx };
}

describe('provider usage write cost and Account admission', () => {
    beforeEach(() => vi.stubEnv('HAPPIER_DB_PROVIDER', 'postgres'));
    afterEach(() => vi.unstubAllEnvs());

    it.each([1, 8])('updates one record once for %i meters and locks Account exclusively only for publication', async meterCount => {
        const boundary = databaseBoundary(meterCount);
        await expect(boundary.write()).resolves.toBe('written');
        expect(boundary.operations.filter(operation => operation === 'record.update')).toHaveLength(1);
        expect(boundary.retained).toHaveLength(1);
        expect(boundary.operations.filter(operation => operation === 'summary.invalidate')).toHaveLength(1);
        expect(boundary.operations.filter(operation => operation === 'pending.update')).toHaveLength(1);
        expect(boundary.operations.filter(operation => operation === 'pending.read')).toHaveLength(0);
        expect(boundary.retained[0]).toMatchObject({ accountId: 'owner', payload: { snapshot: { planLabel: 'changed plan' } } });
        expect(boundary.operations.indexOf('admission')).toBeLessThan(boundary.operations.indexOf('mode.read'));
        const terminal = boundary.operations.slice(boundary.operations.indexOf('publication.lock'));
        expect(terminal).toEqual(['publication.lock', 'publication.read', 'publication.write', 'publication.write']);
        expect(database.transaction.mock.lastCall?.[1]).toMatchObject({ isolationLevel: 'ReadCommitted' });
    });

    it.each([
        { kind: 'freshness', outcome: 'written', observations: 1 },
        { kind: 'noop', outcome: 'noop', observations: 0 },
    ] as const)('retains $observations exact observations for a $kind update', async ({ kind, outcome, observations }) => {
        const boundary = databaseBoundary(8);
        await expect(boundary.write(kind)).resolves.toBe(outcome);
        expect(boundary.retained).toHaveLength(observations);
        expect(boundary.operations.filter(operation => operation === 'summary.invalidate')).toHaveLength(observations);
        expect(boundary.operations.filter(operation => operation === 'pending.update')).toHaveLength(observations);
    });

    it('refuses old-mode content after Account admission without writing a record, history or publication', async () => {
        const boundary = databaseBoundary(1);
        boundary.tx.$queryRawUnsafe.mockImplementationOnce(async () => {
            boundary.operations.push('admission'); boundary.changeMode(); return [{ id: 'owner' }];
        });
        await expect(boundary.write()).rejects.toBeInstanceOf(ProviderAccountUsagePayloadInvariantError);
        expect(boundary.operations).toEqual(['admission', 'mode.read']);
        expect(boundary.updateMany).not.toHaveBeenCalled();
        expect(boundary.parentUpdate).not.toHaveBeenCalled();
        expect(boundary.insertHistory).not.toHaveBeenCalled();
    });
});
