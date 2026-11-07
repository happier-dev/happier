import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import { db, getDbProviderFromEnv, initDbMysql, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { materializePluginCollectionContractsFromManifestTx } from './contracts';
import { mutatePluginCollection } from './mutation';
import { setCollectionGrant, revokeCollectionGrant, readCollectionRecipientCensus } from './sharingAccessService';
import { readSharedCollectionResource, putSharedCollectionResource, listSharedCollectionResources } from './sharingResourceService';

function json(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

describe('Collection sharing database contract', () => {
    const provider = getDbProviderFromEnv(process.env, 'postgres');
    let sqlite: LightSqliteHarness | undefined;
    beforeAll(async () => {
        if (provider === 'sqlite') {
            sqlite = await createLightSqliteHarness({ tempDirPrefix: 'happier-collection-sharing-',
                initAuth: false, initEncrypt: false, initFiles: false });
            return;
        }
        const testUrl = provider === 'mysql' ? process.env.HAPPIER_TEST_MYSQL_DATABASE_URL : process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL;
        if (!testUrl || process.env.DATABASE_URL !== testUrl) throw new Error('Use the disposable database contract harness');
        if (provider === 'mysql') await initDbMysql(); else initDbPostgres();
        await db.$connect();
    }, 120_000);
    afterAll(async () => { if (sqlite) await sqlite.close(); else await db.$disconnect(); });

    it('preserves private relation edges for editor content writes and refuses target changes', async () => {
        const pluginId = `example.sharing.relations.${randomUUID()}`;
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const peer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const authentication = createPresentUserSessionAccessAuthentication();
        const manifest = { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Sharing relation contract',
            engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: { accountCollections: [{
                id: 'documents', schemaVersion: 1, rowIdField: 'id', schema: { type: 'object', properties: {
                    id: { type: 'string', maxLength: 256 }, title: { type: 'string' },
                    parent: { type: 'string', maxLength: 256 },
                }, required: ['id', 'title'], additionalProperties: false }, serverReadable: ['title', 'parent'], indexes: [],
                relations: [{ id: 'parent', kind: 'collection', field: 'parent', collectionId: 'documents',
                    required: false, unique: false, onDelete: 'nullify' }],
            }] } };
        try {
            const [ref] = await inTx(tx => materializePluginCollectionContractsFromManifestTx({ tx, manifest }));
            if (!ref) throw new Error('Expected materialized collection');
            await db.accountPluginIntent.create({ data: { accountId: owner.id, pluginId, enabled: true,
                desiredVersion: null, offlineUiHosting: 'disabled', writableCollections: json([ref]) } });
            await db.userRelationship.create({ data: { fromUserId: peer.id, toUserId: owner.id, status: 'friend' } });
            for (const [rowId, parent] of [['private', null], ['shared', 'private']] as const) {
                expect((await mutatePluginCollection({ accountId: owner.id, authentication, request: { pluginId,
                    collectionId: ref.collectionId, writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest },
                    operations: [{ kind: 'put', rowId, expectedRevision: 'absent', expectedAbsenceEpoch: 0,
                        content: { t: 'plain', v: {} }, projection: { title: rowId, parent } }] } })).status).toBe('updated');
            }
            const address = { ownerAccountId: owner.id, pluginId, collectionId: ref.collectionId, rowId: 'shared' };
            await setCollectionGrant(owner.id, { ...address, principal: { kind: 'account', accountId: peer.id },
                accessLevel: 'edit', expectedRevision: 1 }, authentication);
            const mutation = { ...address, writerContext: ref, expectedRevision: 1,
                content: { t: 'plain' as const, v: {} }, projection: { title: 'Edited', parent: 'private' } };
            expect((await putSharedCollectionResource(peer.id, mutation, authentication)).row.revision).toBe(2);
            for (const parent of ['missing', null]) {
                await expect(putSharedCollectionResource(peer.id, { ...mutation, expectedRevision: 2,
                    projection: { ...mutation.projection, parent } }, authentication))
                    .rejects.toMatchObject({ code: 'collection_relation_unavailable' });
            }
            const source = await db.pluginCollectionRow.findFirstOrThrow({ where: { accountId: owner.id, rowId: 'shared' } });
            expect(await db.pluginCollectionRelation.findMany({ where: { sourceRowDbId: source.id, deletedAt: null },
                select: { targetRowId: true, sourceRevision: true } })).toEqual([{ targetRowId: 'private', sourceRevision: 2 }]);
        } finally {
            await db.account.deleteMany({ where: { id: { in: [owner.id, peer.id] } } });
            await db.pluginCollectionContract.deleteMany({ where: { pluginId } });
        }
    });

    it('preserves the one writer CAS, live grants, recipient invalidations and keyless Plain storage', async () => {
        const pluginId = `example.sharing.${randomUUID()}`;
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const peer = await db.account.create({ data: { encryptionMode: 'plain' } });
        const authentication = createPresentUserSessionAccessAuthentication();
        const manifest = { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Sharing contract',
            engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: { accountCollections: [{
                id: 'documents', schemaVersion: 1, rowIdField: 'id', schema: { type: 'object', properties: {
                    id: { type: 'string', maxLength: 256 }, title: { type: 'string' }, note: { type: 'string' },
                }, required: ['id', 'title', 'note'], additionalProperties: false }, serverReadable: ['title'], indexes: [],
            }] } };
        try {
            const [ref] = await inTx(tx => materializePluginCollectionContractsFromManifestTx({ tx, manifest }));
            if (!ref) throw new Error('Expected materialized collection');
            await db.accountPluginIntent.create({ data: { accountId: owner.id, pluginId, enabled: true,
                desiredVersion: null, offlineUiHosting: 'disabled', writableCollections: json([ref]) } });
            await db.userRelationship.create({ data: { fromUserId: peer.id, toUserId: owner.id, status: 'friend' } });
            const address = { ownerAccountId: owner.id, pluginId, collectionId: ref.collectionId, rowId: 'document' };
            const created = await mutatePluginCollection({ accountId: owner.id, authentication, request: {
                pluginId, collectionId: ref.collectionId, writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest }, operations: [{ kind: 'put', rowId: address.rowId,
                    expectedRevision: 'absent', expectedAbsenceEpoch: 0, content: { t: 'plain', v: { note: 'Private original' } }, projection: { title: 'Original' } }],
            } });
            expect(created.status).toBe('updated');
            if (created.status !== 'updated') throw new Error('Expected first write');
            const revision = created.results[0]!.revision;
            const principal = { kind: 'account' as const, accountId: peer.id };
            await expect(readSharedCollectionResource(peer.id, { ...address, readerContext: ref })).rejects.toMatchObject({ code: 'collection_unavailable' });
            await setCollectionGrant(owner.id, { ...address, principal, accessLevel: 'view', expectedRevision: revision }, authentication);
            const read = await readSharedCollectionResource(peer.id, { ...address, readerContext: ref });
            expect(read).toMatchObject({ access: 'view', encryptedDataKey: null, row: { revision } });
            const mutation = { ...address, writerContext: ref, expectedRevision: revision,
                content: { t: 'plain' as const, v: { note: 'Private peer edit' } }, projection: { title: 'Edited' } };
            await expect(putSharedCollectionResource(peer.id, { ...mutation, expectedRevision: 999 }, authentication)).rejects.toMatchObject({ code: 'collection_unavailable' });
            await setCollectionGrant(owner.id, { ...address, principal, accessLevel: 'edit', expectedRevision: revision }, authentication);
            const updated = await putSharedCollectionResource(peer.id, mutation, authentication);
            expect(updated.row).toMatchObject({ revision: revision + 1, content: mutation.content });
            await expect(putSharedCollectionResource(peer.id, mutation, authentication)).rejects.toMatchObject({ code: 'collection_revision_conflict' });
            expect((await listSharedCollectionResources(peer.id, { pluginId, collectionId: ref.collectionId, readerContext: ref })).resources).toEqual([updated]);
            expect(await readCollectionRecipientCensus(owner.id, address)).toMatchObject({ encryptionMode: 'plain', dataEncryptionKey: null });
            expect(await db.pluginCollectionKeyEnvelope.count({ where: { row: { accountId: owner.id } } })).toBe(0);
            const beforeRevoke = await db.account.findUniqueOrThrow({ where: { id: peer.id }, select: { seq: true } });
            await revokeCollectionGrant(owner.id, { ...address, principal });
            expect((await db.account.findUniqueOrThrow({ where: { id: peer.id }, select: { seq: true } })).seq).toBeGreaterThan(beforeRevoke.seq);
            await expect(readSharedCollectionResource(peer.id, { ...address, readerContext: ref })).rejects.toMatchObject({ code: 'collection_unavailable' });
            await setCollectionGrant(owner.id, { ...address, principal, accessLevel: 'edit', expectedRevision: revision + 1 }, authentication);
            const deleted = await mutatePluginCollection({ accountId: owner.id, authentication, request: {
                pluginId, collectionId: ref.collectionId, writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest },
                operations: [{ kind: 'delete', rowId: address.rowId, expectedRevision: revision + 1 }],
            } });
            expect(deleted.status).toBe('updated');
            expect(await db.pluginCollectionAccountGrant.count({ where: { row: { accountId: owner.id } } })).toBe(0);
            const recreated = await mutatePluginCollection({ accountId: owner.id, authentication, request: {
                pluginId, collectionId: ref.collectionId, writerContext: { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest },
                operations: [{ kind: 'put', rowId: address.rowId, expectedRevision: revision + 2,
                    content: mutation.content, projection: mutation.projection }],
            } });
            expect(recreated.status).toBe('updated');
            await expect(readSharedCollectionResource(peer.id, { ...address, readerContext: ref })).rejects.toMatchObject({ code: 'collection_unavailable' });
            expect((await listSharedCollectionResources(peer.id, { pluginId, collectionId: ref.collectionId, readerContext: ref })).resources).toEqual([]);
            const changes = await db.accountChange.findMany({ where: { accountId: peer.id } });
            expect(JSON.stringify(changes)).not.toContain('Private peer edit');
            expect(JSON.stringify(changes)).not.toContain('Edited');
        } finally {
            await db.account.deleteMany({ where: { id: { in: [owner.id, peer.id] } } });
            await db.pluginCollectionContract.deleteMany({ where: { pluginId } });
        }
    });
});
