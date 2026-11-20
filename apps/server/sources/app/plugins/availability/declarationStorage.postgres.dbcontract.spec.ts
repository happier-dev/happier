import { symbols, type DestinationStream } from 'pino';
import { logger } from '@/utils/logging/log';
import { readPrismaDriverErrorCause } from '@/storage/prismaErrors';
import { randomUUID } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1 } from '@happier-dev/protocol/plugins/installations/manifests';
import { createSignedPluginInstallationPublisherHeader, createTrustedMachineInstallation } from '@/testkit/pluginInstallationPublisherTestkit';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import type { Fastify } from '@/app/api/types';
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

    it.each([false, true])('converges concurrent signed claims when the digest body already exists: %s', async (existingBody) => {
        const { id: accountId } = await db.account.create({ data: { encryptionMode: 'plain' } });
        const manifest = PluginManifestV2Schema.parse({
            schemaVersion: 2, id: 'com.example.writer-claim', version: '1.0.0',
            displayName: 'Writer “claim” 🐈', engines: { happier: '^1.0.0' }, contributes: {},
            metadata: { nested: { labels: ['quoted "text"', 'ümlaut'] } },
        });
        const declaration = createReleaseLessDeclarationV1(manifest);
        const where = { accountId, pluginId: manifest.id };
        if (existingBody) {
            await db.accountPluginIntent.create({ data: {
                ...where, enabled: true, writableCollections: [], releaseLessDeclaration: declaration,
            } });
            await db.accountPluginDeclarationBody.create({ data: {
                ...where, declarationDigest: declaration.manifestDigestSha256, manifest,
            } });
        }
        const publishers = await Promise.all(Array.from({ length: 3 }, async () => {
            const publisher = { machineId: randomUUID(), installationId: randomUUID(), keyPair: tweetnacl.sign.keyPair() };
            await createTrustedMachineInstallation({ ...publisher, accountId });
            return publisher;
        }));
        const path = PluginAvailabilityActionHttpPathsV1['account.plugins.availability.collectionWriters.claim'];
        const body = { manifest };
        const failures: Array<{ prismaCode: string; databaseCode: string | undefined }> = [];
        await withAuthenticatedTestApp((app: Fastify) => {
            app.addHook('onError', async (_request, _reply, error) => {
                failures.push({ prismaCode: error.code, databaseCode: readPrismaDriverErrorCause(error)?.code });
            });
            registerPluginAvailabilityRoutes(app);
        }, async app => {
            const responses = await Promise.all(publishers.map(publisher => app.inject({
                method: 'POST', url: path, payload: body,
                headers: {
                    'x-test-user-id': accountId,
                    [PLUGIN_INSTALLATION_MANIFEST_PUBLISHER_HEADER_V1]:
                        createSignedPluginInstallationPublisherHeader({ ...publisher, path, body }),
                },
            })));
            expect(responses.map(response => response.statusCode), JSON.stringify(failures)).toEqual([200, 200, 200]);
        });
        await expect(db.accountPluginDeclarationBody.findMany({
            where, select: { declarationDigest: true, manifest: true },
        })).resolves.toEqual([{ declarationDigest: declaration.manifestDigestSha256, manifest }]);
        const operations = createPluginAvailabilityOperations({ resolveHostingCapability: () => ({ enabled: false }) });
        const read = await operations.readIntent({ accountId, input: { pluginId: manifest.id,
            declarationDigests: [declaration.manifestDigestSha256] } });
        expect(read.machineDeclarations?.map(entry => entry.machineId).sort()).toEqual(publishers.map(entry => entry.machineId).sort());
        expect(read.declarationBodies).toEqual([{ declarationDigestSha256: declaration.manifestDigestSha256, manifest }]);
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
        const records: Record<string, unknown>[] = [];
        const stream = Reflect.get(logger, symbols.streamSym) as DestinationStream;
        const sink = vi.spyOn(stream, 'write').mockImplementation(chunk => { records.push(JSON.parse(String(chunk))); });
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
                expect(records).toContainEqual(expect.objectContaining({
                    method: 'POST',
                    route: PluginAvailabilityActionHttpPathsV1['account.plugins.availability.collectionWriters.claim'],
                    prismaCode: 'P2010',
                    databaseErrorCode: '42P01',
                    databaseErrorMessage: 'undefined table',
                }));
                expect(JSON.stringify(records)).not.toContain('Changed declaration');
            });
        } finally {
            sink.mockRestore();
            await db.$executeRaw`ALTER TABLE "ParkedDeclarationBody" RENAME TO "AccountPluginDeclarationBody"`;
            vi.unstubAllEnvs();
        }
    });
});
