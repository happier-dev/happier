import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { createReleaseLessDeclarationV1, resolveCurrentPluginDeclarationsTx } from './currentDeclaration';
import { createPluginAvailabilityOperations } from './operations';
import { readIntentRows, readIntentListDeclarations, decodeIntentListDeclaration } from './intentReadRows';
import { backfillPluginDeclarations } from './declarationBackfill';

describe('Account declaration body deduplication PostgreSQL contract', () => {
    beforeAll(async () => {
        if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
            throw new Error('Use the disposable PostgreSQL DB-contract harness');
        }
        initDbPostgres();
        await db.$connect();
    });
    afterAll(async () => { await db.$disconnect(); });

    it('compacts a 490-Machine claim through the writer, keeps offline/list reads and isolates Accounts', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        const other = await db.account.create({ data: { encryptionMode: 'plain' } });
        const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: 'com.example.storage', version: '1.0.0',
            displayName: 'Storage', engines: { happier: '^1.0.0' }, contributes: {}, metadata: { body: 'stored-body-marker' } });
        const declaration = createReleaseLessDeclarationV1(manifest);
        const legacy = { schemaVersion: 2, machines: Array.from({ length: 490 }, (_, index) => ({
            machineId: `machine-${index}`, machineInstallationId: `installation-${index}`, declaration,
        })), legacyDeclaration: null };
        await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId: manifest.id, enabled: true,
            desiredVersion: null, writableCollections: [], releaseLessDeclaration: legacy } });
        const operations = createPluginAvailabilityOperations({ resolveHostingCapability: () => ({ enabled: false }) });
        await operations.claimCollectionWriters({ accountId: account.id, input: { manifest } });
        const stored = await db.accountPluginIntent.findUniqueOrThrow({ where: { accountId_pluginId: { accountId: account.id, pluginId: manifest.id } } });
        expect(JSON.stringify(stored.releaseLessDeclaration).split('stored-body-marker').length - 1).toBe(1);
        const refs = [{ pluginId: manifest.id, version: manifest.version }];
        expect([...(await inTx(tx => resolveCurrentPluginDeclarationsTx({ tx, accountId: account.id, refs }))).values()][0]?.manifest).toEqual(manifest);
        const listed = await inTx(async tx => {
            const rows = await readIntentRows(tx, { accountId: account.id, list: true });
            return readIntentListDeclarations(tx, account.id, rows);
        });
        expect(decodeIntentListDeclaration(listed.get(manifest.id)!).currentDeclaration?.manifest).toEqual(manifest);
        expect((await inTx(tx => resolveCurrentPluginDeclarationsTx({ tx, accountId: other.id, refs }))).size).toBe(0);
        await expect(operations.claimCollectionWriters({ accountId: other.id, input: {
            pluginId: manifest.id, manifestDigestSha256: declaration.manifestDigestSha256,
        } })).rejects.toMatchObject({ code: 'plugin_declaration_not_found' });
        // Exercise the migration on retained old rows, preserving their domain CAS and timestamp.
        await db.accountPluginIntent.update({ where: { id: stored.id }, data: { releaseLessDeclaration: legacy } });
        const before = await db.accountPluginIntent.findUniqueOrThrow({ where: { id: stored.id } });
        const result = await backfillPluginDeclarations(db, true);
        expect(result.unsupported).toBe(0);
        const after = await db.accountPluginIntent.findUniqueOrThrow({ where: { id: stored.id } });
        expect(after.revision).toBe(before.revision);
        expect(after.updatedAt).toEqual(before.updatedAt);
        expect(JSON.stringify(after.releaseLessDeclaration).split('stored-body-marker').length - 1).toBe(1);
        expect((await backfillPluginDeclarations(db, true)).converted).toBe(0);
    });
});
