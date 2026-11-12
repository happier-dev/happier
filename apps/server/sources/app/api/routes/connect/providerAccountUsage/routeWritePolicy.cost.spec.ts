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
        staleAfterMs: snapshot.staleAfterMs, refreshRequestedAt: null, metadata: null };
    const retained: unknown[] = [];
    const parentUpdate = vi.fn(async () => { operations.push('record.update'); return { id: 'record' }; });
    const updateMany = vi.fn(async () => { operations.push('record.update'); return { count: 1 }; });
    const insertHistory = vi.fn(async (args: { data: unknown }) => {
        operations.push('history.insert'); retained.push(args.data); return { id: 'history' };
    });
    // Prisma is the external boundary. Admission, merge/CAS, history projection,
    // inTx and terminal Account publication all execute their production logic.
    const tx = {
        $queryRaw: vi.fn(async () => [{ statement_timeout: '0' }]),
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
        providerAccountUsageRecord: { findUnique: vi.fn(async () => stored), updateMany, update: parentUpdate },
        providerAccountUsageHistory: { create: insertHistory },
    };
    database.transaction.mockImplementation(async (callback: (client: TransactionClient) => Promise<unknown>) =>
        callback(tx as unknown as TransactionClient));
    const write = () => writeProviderAccountUsageRecordWithPolicy({ accountId: 'owner',
        recordId: snapshot.recordId, recordKey: snapshot.recordKey, payloadMode: 'plain_json_v1', status: 'ok',
        fetchedAt: snapshot.fetchedAtMs + 1000, staleAfterMs: snapshot.staleAfterMs,
        snapshot: { ...snapshot, fetchedAtMs: snapshot.fetchedAtMs + 1000,
            observedAtMs: snapshot.observedAtMs + 1000, planLabel: 'changed plan' } });
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
        expect(boundary.retained[0]).toMatchObject({ accountId: 'owner', payload: { snapshot: { planLabel: 'changed plan' } } });
        expect(boundary.operations.indexOf('admission')).toBeLessThan(boundary.operations.indexOf('mode.read'));
        const terminal = boundary.operations.slice(boundary.operations.indexOf('publication.lock'));
        expect(terminal).toEqual(['publication.lock', 'publication.write', 'publication.write']);
        expect(database.transaction.mock.lastCall?.[1]).toMatchObject({ isolationLevel: 'ReadCommitted' });
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
