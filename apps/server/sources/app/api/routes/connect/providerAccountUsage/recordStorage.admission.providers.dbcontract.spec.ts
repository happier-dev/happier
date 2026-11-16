import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { db, getDbProviderFromEnv, initDbPostgres, initDbMysql } from '@/storage/db';
import { createUsageSnapshot } from '../providerAccountUsageTestkit';
import { PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING } from '@happier-dev/protocol/connect/providerAccountUsagePageProjection';
import { BuiltInLegacyConnectedServiceCompatibilityError } from '@happier-dev/protocol/connect/legacyConnectedServiceCompatibility';
import { readProviderAccountUsageRecord, readProviderAccountUsageRecordWithCurrentGuard, upsertProviderAccountUsageRecord } from './recordStorage';
import { ProviderAccountUsagePayloadInvariantError } from './types';

const provider = getDbProviderFromEnv(process.env, 'postgres');

describe.skipIf(provider !== 'postgres' && provider !== 'mysql')('provider usage admission database projection', () => {
    let accountId: string | undefined;

    beforeAll(async () => {
        const supplied = process.env[provider === 'mysql' ? 'HAPPIER_TEST_MYSQL_DATABASE_URL' : 'HAPPIER_TEST_POSTGRES_DATABASE_URL'];
        if (!supplied || process.env.DATABASE_URL !== supplied) throw new Error('Use the disposable DB-contract harness');
        if (provider === 'mysql') await initDbMysql();
        else initDbPostgres();
        await db.$connect();
        accountId = (await db.account.create({ data: { id: randomUUID(), publicKey: null, encryptionMode: 'plain' } })).id;
    });

    afterAll(async () => {
        if (accountId) await db.account.delete({ where: { id: accountId } });
        await db.$disconnect();
    });

    it('transfers no extra current-record bytes when the retained projection grows', async () => {
        if (!accountId) throw new Error('Disposable Account was not initialized');
        const snapshot = createUsageSnapshot({ fetchedAt: Date.UTC(2026, 10, 1, 12, 34, 56, 789) });
        const key = { accountId, recordId: snapshot.recordId };
        await upsertProviderAccountUsageRecord({ ...key, recordKey: snapshot.recordKey, snapshot,
            payloadMode: 'plain_json_v1', status: 'ok', fetchedAt: snapshot.fetchedAtMs,
            staleAfterMs: snapshot.staleAfterMs, refreshRequestedAt: snapshot.fetchedAtMs + 1 });
        const bytes: number[] = [];
        const capture = (value: unknown) => {
            bytes.push(Buffer.byteLength(JSON.stringify(value, (_key, leaf) => typeof leaf === 'bigint' ? Number(leaf) : leaf)));
            return value;
        };
        const storage = new Proxy(db, {
            get(target, property, receiver) {
                if (property === '$queryRaw') return async (...args: Parameters<typeof db.$queryRaw>) => capture(await target.$queryRaw(...args));
                if (property === 'providerAccountUsageRecord') return new Proxy(target.providerAccountUsageRecord, {
                    get(delegate, method, delegateReceiver) {
                        if (method === 'findUnique') return async (...args: Parameters<typeof delegate.findUnique>) => capture(await delegate.findUnique(...args));
                        return Reflect.get(delegate, method, delegateReceiver);
                    },
                });
                return Reflect.get(target, property, receiver);
            },
        });
        for (const repetitions of [1, 4096]) {
            const pageProjection = { recordId: snapshot.recordId, encoding: PROVIDER_ACCOUNT_USAGE_PAGE_ENCODING,
                demand: { range: { startAtMs: 0, endAtMs: snapshot.fetchedAtMs + 1 }, resolution: 'accepted_observations' as const },
                frontier: null, observationCount: 0, content: { t: 'encrypted' as const, c: 'projection-only'.repeat(repetitions) } };
            await db.providerAccountUsageRecord.update({ where: { accountId_recordId: key },
                data: { metadata: { materialFingerprint: 'preserved', pageProjection } } });
            const current = await readProviderAccountUsageRecord(key, storage);
            expect(current).toMatchObject({ snapshot, fetchedAt: snapshot.fetchedAtMs,
                refreshRequestedAt: snapshot.fetchedAtMs + 1, metadata: { materialFingerprint: 'preserved' } });
            expect(current?.metadata).toEqual({ materialFingerprint: 'preserved' });
            expect((await readProviderAccountUsageRecordWithCurrentGuard(key, db))?.rawMetadata).toMatchObject({ pageProjection });
        }
        expect(bytes).toHaveLength(2);
        expect(bytes[1], 'projection growth transfers zero extra database-result bytes').toBe(bytes[0]);
        await expect(readProviderAccountUsageRecord({ ...key, accountId: randomUUID() }, storage)).resolves.toBeNull();
    });

    it('rejects JSON strings containing serialized objects instead of reinterpreting stored payloads', async () => {
        if (!accountId) throw new Error('Disposable Account was not initialized');
        const snapshot = createUsageSnapshot({ fetchedAt: Date.UTC(2026, 10, 1) });
        const key = { accountId, recordId: snapshot.recordId };
        for (const { invalidField, errorType } of [
            { invalidField: { snapshot: JSON.stringify(snapshot) }, errorType: BuiltInLegacyConnectedServiceCompatibilityError },
            { invalidField: { metadata: JSON.stringify({ materialFingerprint: 'invalid-scalar' }) }, errorType: ProviderAccountUsagePayloadInvariantError },
        ]) {
            await upsertProviderAccountUsageRecord({ ...key, recordKey: snapshot.recordKey, snapshot,
                payloadMode: 'plain_json_v1', status: 'ok', fetchedAt: snapshot.fetchedAtMs, staleAfterMs: snapshot.staleAfterMs });
            await db.providerAccountUsageRecord.update({ where: { accountId_recordId: key }, data: invalidField });
            await expect(readProviderAccountUsageRecord(key)).rejects.toBeInstanceOf(errorType);
        }
    });
});
