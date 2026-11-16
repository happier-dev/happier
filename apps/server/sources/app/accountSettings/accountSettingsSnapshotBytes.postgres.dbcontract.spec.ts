import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as privacyKit from 'privacy-kit';
import { db, getDbProviderFromEnv, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { recordAccountSettingsSnapshotsForWrite } from './accountSettingsHistoryRepository';
import { accountSettingsSnapshotToContent } from './accountSettingsHistoryContent';
import { readAccountSettingsEncryptionMigrationInventoryInTx } from './migrateAccountSettingsEncryptionInTx';

describe.skipIf(getDbProviderFromEnv(process.env, 'postgres') !== 'postgres')('Account Settings snapshot byte storage', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use only the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
        // The feature migration remains a draft until integration; this database is disposable.
    });
    afterAll(async () => { await db.$disconnect(); });
    it('stores E2EE bytes while preserving history, legacy reads, and migration inventory', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'e2ee' } });
        const ciphertext = privacyKit.encodeBase64(new Uint8Array(Array.from({ length: 192 }, (_, i) => i)));
        try {
            await inTx(tx => recordAccountSettingsSnapshotsForWrite({ tx,
                previous: { accountId: account.id, version: 0, encryptionMode: 'e2ee', settingsDbValue: null },
                next: { accountId: account.id, version: 1, encryptionMode: 'e2ee', settingsDbValue: ciphertext },
            }));
            const [stored] = await db.$queryRaw<Array<{ settingsDbValue: string | null; storedBytes: number | null }>>                `SELECT "settingsDbValue", octet_length("settingsDbValueBytes")::int AS "storedBytes"
                  FROM "AccountSettingsSnapshot" WHERE "accountId" = ${account.id} AND "version" = 1`;
            expect(stored).toEqual({ settingsDbValue: '', storedBytes: 192 });
            const row = await db.accountSettingsSnapshot.findUniqueOrThrow({ where: { accountId_version: { accountId: account.id, version: 1 } } });
            expect(accountSettingsSnapshotToContent(row)).toEqual({ t: 'encrypted', c: ciphertext });
            await db.accountSettingsSnapshot.create({ data: { accountId: account.id, version: 2, encryptionMode: 'e2ee',
                contentKind: 'encrypted', settingsDbValue: ciphertext } });
            const rowSizes = await db.$queryRaw<Array<{ version: number; rowBytes: number }>>`
                SELECT "version", pg_column_size(snapshot)::int AS "rowBytes" FROM "AccountSettingsSnapshot" snapshot
                WHERE "accountId" = ${account.id} AND "version" IN (1, 2) ORDER BY "version"`;
            expect(rowSizes[0].rowBytes).toBeLessThan(rowSizes[1].rowBytes);
            console.info('STORAGE_CODEC_SETTINGS_SAMPLE', JSON.stringify({ byteRow: rowSizes[0].rowBytes,
                legacyRow: rowSizes[1].rowBytes, ciphertextBytes: ciphertext.length, storedBytes: stored.storedBytes }));
            const inventory = await inTx(tx => readAccountSettingsEncryptionMigrationInventoryInTx({ tx, accountId: account.id }));
            expect(inventory).toMatchObject({ status: 'ready', page: { items: [
                { version: 2, content: { t: 'encrypted', c: ciphertext } },
                { version: 1, content: { t: 'encrypted', c: ciphertext } },
                { version: 0, content: null },
            ] } });
        } finally { await db.account.delete({ where: { id: account.id } }); }
    });
});
