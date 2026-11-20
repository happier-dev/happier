import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerPluginAvailabilityRoutes } from './routes';
import { PluginAvailabilityActionHttpPathsV1 } from '@happier-dev/protocol/plugins/availability';
import { observePrismaRequests } from '@/testkit/observeSqliteRequests';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest/v2';
import { compactReleaseLessDeclarations, createReleaseLessDeclarationV1, resolveCurrentPluginDeclarationsTx } from './currentDeclaration';
import { createPluginAvailabilityOperations } from './operations';
import { readIntentRows, readIntentListDeclarations } from './intentReadRows';
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
        expect(stored.releaseLessDeclaration).toMatchObject({ schemaVersion: 4 });
        expect(JSON.stringify(stored.releaseLessDeclaration)).not.toContain('stored-body-marker');
        expect(await db.accountPluginDeclarationBody.findMany({
            where: { accountId: account.id, pluginId: manifest.id },
            select: { declarationDigest: true, manifest: true },
        })).toEqual([{ declarationDigest: declaration.manifestDigestSha256, manifest }]);
        const refs = [{ pluginId: manifest.id, version: manifest.version }];
        expect([...(await inTx(tx => resolveCurrentPluginDeclarationsTx({ tx, accountId: account.id, refs }))).values()][0]?.manifest).toEqual(manifest);
        const listed = await inTx(async tx => readIntentListDeclarations(await readIntentRows(tx, { accountId: account.id, list: true })));
        expect(listed.get(manifest.id)?.currentDeclaration).toEqual({ declarationDigestSha256: declaration.manifestDigestSha256 });
        expect((await inTx(tx => resolveCurrentPluginDeclarationsTx({ tx, accountId: other.id, refs }))).size).toBe(0);
        await expect(operations.claimCollectionWriters({ accountId: other.id, input: {
            pluginId: manifest.id, manifestDigestSha256: declaration.manifestDigestSha256,
        } })).rejects.toMatchObject({ code: 'plugin_declaration_not_found' });
        // Explicit maintenance can still compact an inline row without touching
        // the new-format row or its children.
        const before = await db.accountPluginIntent.create({ data: { accountId: other.id, pluginId: manifest.id,
            enabled: true, desiredVersion: null, writableCollections: [], releaseLessDeclaration: legacy } });
        const result = await backfillPluginDeclarations(db, true);
        expect(result.unsupported).toBe(0);
        const after = await db.accountPluginIntent.findUniqueOrThrow({ where: { id: before.id } });
        expect(after.revision).toBe(before.revision);
        expect(after.updatedAt).toEqual(before.updatedAt);
        expect(JSON.stringify(after.releaseLessDeclaration).split('stored-body-marker').length - 1).toBe(1);
        expect((await backfillPluginDeclarations(db, true)).converted).toBe(0);
    });

    it('reports physically incomplete declarations and leaves their rows untouched', async () => {
        const account = await db.account.create({ data: { encryptionMode: 'plain' } });
        for (const state of ['unexpected-child', 'missing-child']) {
            const pluginId = `com.example.${state}`;
            const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: pluginId, version: '1.0.0',
                displayName: 'Storage', engines: { happier: '^1.0.0' }, contributes: {} });
            const declaration = createReleaseLessDeclarationV1(manifest);
            const inline = compactReleaseLessDeclarations(declaration, pluginId);
            const { manifests: _bodies, ...references } = inline;
            await db.accountPluginIntent.create({ data: { accountId: account.id, pluginId, enabled: true,
                desiredVersion: null, writableCollections: [],
                releaseLessDeclaration: state === 'missing-child' ? { ...references, schemaVersion: 4 } : inline } });
            if (state === 'unexpected-child') {
                await db.accountPluginDeclarationBody.create({ data: { accountId: account.id, pluginId,
                    declarationDigest: declaration.manifestDigestSha256, manifest } });
            }
        }
        const before = await db.accountPluginIntent.findMany({ where: { accountId: account.id }, orderBy: { pluginId: 'asc' } });
        const result = await backfillPluginDeclarations(db, true);
        expect(result).toMatchObject({ incomplete: 2 });
        await expect(db.accountPluginIntent.findMany({ where: { accountId: account.id }, orderBy: { pluginId: 'asc' } }))
            .resolves.toEqual(before);
        await expect(db.accountPluginDeclarationBody.count({ where: { accountId: account.id } })).resolves.toBe(1);
    });

    it('replays overlapping claims before retiring bodies and clears them on portable release selection', async () => {
        const { id: accountId } = await db.account.create({ data: { encryptionMode: 'plain' } });
        const pluginId = 'com.example.concurrent-storage';
        const previous = PluginManifestV2Schema.parse({ schemaVersion: 2, id: pluginId, version: '1.0.0',
            displayName: 'Previous', engines: { happier: '^1.0.0' }, contributes: {} });
        const operations = createPluginAvailabilityOperations({ resolveHostingCapability: () => ({ enabled: false }) });
        const claim = (machineId: string, manifest: typeof previous) => operations.claimCollectionWriters({ accountId,
            input: { manifest }, publisher: { machineId, installationId: `${machineId}-installation` } });
        await claim('machine-a', previous);
        await claim('machine-b', previous);
        const nextA = { ...previous, displayName: 'Machine A' };
        const nextB = { ...previous, displayName: 'Machine B' };
        const expected = [nextA, nextB].map(manifest => ({
            declarationDigestSha256: createReleaseLessDeclarationV1(manifest).manifestDigestSha256, manifest,
        }));
        const condition = { accountId, pluginId };
        let release = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        const fenced = new Set<string>();
        const observe = observePrismaRequests(db, { async before(request) {
            if (request.transactionId && request.action === 'queryRaw'
                && JSON.stringify(request.args).includes('FOR NO KEY UPDATE') && fenced.size < 2) {
                fenced.add(request.transactionId);
                await gate;
            }
        } });
        const writes = Promise.allSettled([claim('machine-a', nextA), claim('machine-b', nextB)]);
        let result: Awaited<typeof writes>;
        try {
            // Both drafts reach the real DB fence from the same parent revision.
            await vi.waitFor(() => expect(fenced.size).toBe(2), { timeout: 5000 });
        } finally {
            release();
            result = await writes;
            observe();
        }
        expect(result.map(write => write.status)).toEqual(['fulfilled', 'fulfilled']);
        const read = await operations.readIntent({ accountId, input: { pluginId,
            declarationDigests: expected.map(body => body.declarationDigestSha256) } });
        expect(read.declarationBodies).toEqual(expect.arrayContaining(expected));
        expect(await db.accountPluginDeclarationBody.count({ where: condition })).toBe(2);

        const portable = { ...previous, version: '2.0.0', displayName: 'Portable', runtime: { apiVersion: 1 } };
        await operations.publishRelease({ accountId, input: { sourceClass: 'registryPackage', facts: {
            ref: { pluginId, version: portable.version }, archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest: portable, collectionContracts: [], uiSlots: [],
            packageAssetArchive: { archiveDigestSha256: `sha256:${'b'.repeat(64)}`, resources: [] },
        } } });
        const selected = await operations.setIntent({ accountId, input: { pluginId, desiredVersion: portable.version,
            enabled: true, offlineUiHosting: 'disabled', writableCollections: [], expectedRevision: read.intent?.revision } });
        expect(selected.intent.desiredVersion).toBe(portable.version);
        expect(await db.accountPluginDeclarationBody.count({ where: condition })).toBe(0);
    });

    it.each([
        { mode: 'ordinary server', sharedSource: undefined },
        { mode: 'shared QA server', sharedSource: 'p03-disposable-schema-fixture' },
    ])('reports missing declaration migration and rolls back the write on a $mode', async ({ sharedSource }) => {
        const { id: accountId } = await db.account.create({ data: { encryptionMode: 'plain' } });
        const pluginId = 'com.example.missing-ddl';
        const manifest = PluginManifestV2Schema.parse({ schemaVersion: 2, id: pluginId, version: '1.0.0',
            displayName: 'Old schema', engines: { happier: '^1.0.0' }, contributes: {} });
        const where = { accountId_pluginId: { accountId, pluginId } };
        const parent = await db.accountPluginIntent.create({ data: { accountId, pluginId, enabled: true,
            desiredVersion: null, writableCollections: [],
            releaseLessDeclaration: createReleaseLessDeclarationV1(manifest) } });
        vi.stubEnv('HAPPIER_STACK_SHARED_DB_SOURCE_STACK', sharedSource);
        await db.$executeRaw`ALTER TABLE "AccountPluginDeclarationBody" RENAME TO "ParkedDeclarationBody"`;
        try {
            await withAuthenticatedTestApp(registerPluginAvailabilityRoutes, async app => {
                const response = await app.inject({
                    method: 'POST',
                    url: PluginAvailabilityActionHttpPathsV1['account.plugins.availability.collectionWriters.claim'],
                    headers: { 'x-test-user-id': accountId },
                    payload: { manifest: { ...manifest, displayName: 'Changed declaration' } },
                });
                await expect(db.accountPluginIntent.findUnique({ where })).resolves.toEqual(parent);
                await expect(db.accountChange.count({ where: { accountId } })).resolves.toBe(0);
                expect(response.statusCode).toBe(500);
                expect(response.json()).toMatchObject({
                    error: 'database_migration_required', statusCode: 500, message: expect.stringMatching(/apply .*migration/i),
                });
                expect(response.body).not.toContain('AccountPluginDeclarationBody');
            });
        } finally {
            await db.$executeRaw`ALTER TABLE "ParkedDeclarationBody" RENAME TO "AccountPluginDeclarationBody"`;
            vi.unstubAllEnvs();
        }
    });
});
