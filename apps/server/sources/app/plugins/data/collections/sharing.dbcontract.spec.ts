import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';
import tweetnacl from 'tweetnacl';
import { encodeBase64, computeContentPublicKeyFingerprint, sealEncryptedDataKeyEnvelopeV1, sealPluginCollectionPrivatePayloadV1 } from '@happier-dev/protocol';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { db, getDbProviderFromEnv, initDbMysql, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createPresentUserSessionAccessAuthentication } from '@/app/session/access/sessionAccessAuthentication.testkit';
import { materializePluginCollectionContractsFromManifestTx } from './contracts';
import { mutatePluginCollection } from './mutation';
import { setCollectionGrant, revokeCollectionGrant, readCollectionRecipientCensus, commitCollectionRecipientKeys, listCollectionGrants } from './sharingAccessService';
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

    it.each(['plain', 'e2ee'] as const)('creates, changes and revokes explicit guest grants through stored-content owners (%s)', async mode => {
        const pluginId = `example.sharing.guests.${randomUUID()}`;
        const account = () => db.account.create({ data: { encryptionMode: mode,
            ...(mode === 'e2ee' ? createSignedAccountContentBinding() : {}) } });
        const [owner, teamGuest, groupGuest, directGuest] = await Promise.all(Array.from({ length: 4 }, account));
        const keyless = await db.account.create({ data: { encryptionMode: 'e2ee' } });
        const team = await db.team.create({ data: { name: 'Collection guest lifecycle' } });
        await db.teamMembership.createMany({ data: [
            { teamId: team.id, accountId: owner.id, role: 'owner' },
            ...[teamGuest, groupGuest, directGuest, keyless].map(actor => ({ teamId: team.id, accountId: actor.id, role: 'guest' as const })),
        ] });
        const group = await db.teamGroup.create({ data: { teamId: team.id, name: 'Explicit collection guests' } });
        const membership = await db.teamMembership.findUniqueOrThrow({ where: { teamId_accountId: { teamId: team.id, accountId: groupGuest.id } } });
        await db.teamGroupMembership.create({ data: { teamId: team.id, teamGroupId: group.id, teamMembershipId: membership.id, nativeContribution: true } });
        const authentication = createPresentUserSessionAccessAuthentication();
        const manifest = { schemaVersion: 2, id: pluginId, version: '1.0.0', displayName: 'Guest lifecycle contract',
            engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 }, contributes: { accountCollections: [{
                id: 'documents', schemaVersion: 1, rowIdField: 'id', schema: { type: 'object', properties: {
                    id: { type: 'string', maxLength: 256 }, title: { type: 'string' },
                }, required: ['id', 'title'], additionalProperties: false }, serverReadable: ['title'], indexes: [],
            }] } };
        const dataKey = tweetnacl.randomBytes(32);
        const seal = () => sealPluginCollectionPrivatePayloadV1({ material: { type: 'dataKey', machineKey: dataKey },
            payload: {}, randomBytes: tweetnacl.randomBytes });
        const wrap = (actor: typeof owner) => {
            if (!actor.contentPublicKey) throw new Error('Encrypted fixture needs a verified recipient key');
            return { recipientAccountId: actor.id, recipientContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(actor.contentPublicKey),
                encryptedDataKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: actor.contentPublicKey, randomBytes: tweetnacl.randomBytes })) };
        };
        try {
            const [ref] = await inTx(tx => materializePluginCollectionContractsFromManifestTx({ tx, manifest }));
            if (!ref) throw new Error('Expected materialized collection');
            const contractContext = { schemaVersion: ref.schemaVersion, contractDigest: ref.contractDigest };
            await db.accountPluginIntent.create({ data: { accountId: owner.id, pluginId, enabled: true,
                desiredVersion: null, offlineUiHosting: 'disabled', writableCollections: json([ref]) } });
            const address = { ownerAccountId: owner.id, pluginId, collectionId: ref.collectionId, rowId: 'guest-document' };
            const content = mode === 'plain' ? { t: 'plain' as const, v: {} } : { t: 'encrypted' as const, c: seal() };
            const created = await mutatePluginCollection({ accountId: owner.id, authentication, request: {
                pluginId, collectionId: ref.collectionId, writerContext: contractContext, operations: [{ kind: 'put', rowId: address.rowId,
                    expectedRevision: 'absent', expectedAbsenceEpoch: 0, content, projection: { title: 'Guest document' } }],
            } });
            expect(created.status).toBe('updated');
            if (created.status !== 'updated') throw new Error('Expected stored-content create');
            let revision = created.results[0]!.revision;
            const resourceContent = mode === 'plain' ? content : { t: 'encrypted' as const, k: 'collection' as const, c: seal() };
            const ownerWrap = mode === 'e2ee' ? wrap(owner) : null;
            await setCollectionGrant(owner.id, { ...address, principal: { kind: 'team', teamId: team.id }, accessLevel: 'edit', expectedRevision: revision,
                ...(ownerWrap ? { promotion: { expectedRevision: revision, content: resourceContent, ownerKeyEnvelope: ownerWrap, recipientKeyEnvelopes: [] } } : {}) }, authentication);
            if (ownerWrap) revision++;
            const read = (actor: typeof owner) => readSharedCollectionResource(actor.id, { ...address, readerContext: ref });
            await expect(read(teamGuest)).rejects.toMatchObject({ code: 'collection_unavailable' });
            const explicit: readonly { principal: PrincipalRefV1; actor: typeof owner }[] = [
                { principal: { kind: 'group', teamId: team.id, groupId: group.id }, actor: groupGuest },
                { principal: { kind: 'account', accountId: directGuest.id }, actor: directGuest },
            ];
            for (const { principal, actor } of explicit) await setCollectionGrant(owner.id, { ...address, principal,
                accessLevel: 'view', expectedRevision: revision, ...(ownerWrap ? { recipientKeyEnvelopes: [wrap(actor)] } : {}) }, authentication);
            await setCollectionGrant(owner.id, { ...address, principal: { kind: 'account', accountId: keyless.id },
                accessLevel: 'view', expectedRevision: revision }, authentication);
            const listed = await listCollectionGrants(owner.id, address);
            expect(listed.grants.map(grant => grant.principal)).toEqual(expect.arrayContaining([
                { kind: 'team', teamId: team.id },
                ...explicit.map(grant => grant.principal),
                { kind: 'account', accountId: keyless.id },
            ]));
            expect(listed.grants).toHaveLength(4);
            const mutation = () => ({ ...address, writerContext: ref, expectedRevision: revision,
                content: resourceContent, projection: { title: 'Guest edit' } });
            for (const { actor } of explicit) {
                expect(await read(actor)).toMatchObject({ access: 'view', encryptionMode: mode,
                    encryptedDataKey: ownerWrap ? expect.any(String) : null });
                await expect(putSharedCollectionResource(actor.id, mutation(), authentication)).rejects.toMatchObject({ code: 'collection_unavailable' });
            }
            const census = await readCollectionRecipientCensus(owner.id, address);
            expect(census.recipients.map(row => row.recipientAccountId).sort()).toEqual([owner.id, groupGuest.id, directGuest.id, keyless.id].sort());
            expect(census.recipients.find(row => row.recipientAccountId === keyless.id))
                .toMatchObject({ contentPublicKeyFingerprint: null, encryptedDataKey: null });
            if (ownerWrap) {
                await expect(read(keyless)).rejects.toMatchObject({ code: 'collection_content_unavailable' });
                const keys = await commitCollectionRecipientKeys(owner.id, { ...address, expectedDataEncryptionKey: ownerWrap.encryptedDataKey,
                    recipientKeyEnvelopes: [wrap(teamGuest), { ...wrap(directGuest), recipientAccountId: keyless.id }] });
                expect(keys).toEqual({ appliedRecipientAccountIds: [], skippedRecipientAccountIds: [teamGuest.id, keyless.id] });
            } else {
                expect(await read(keyless)).toMatchObject({ access: 'view', encryptedDataKey: null });
                expect(census).toMatchObject({ dataEncryptionKey: null, callerDataEncryptionKey: null });
            }
            const row = await db.pluginCollectionRow.findFirstOrThrow({ where: { accountId: owner.id, pluginId, rowId: address.rowId } });
            const envelopes = () => db.pluginCollectionKeyEnvelope.findMany({ where: { rowDbId: row.id }, orderBy: { recipientAccountId: 'asc' } });
            const before = await envelopes();
            expect(before.map(row => row.recipientAccountId).sort()).toEqual(ownerWrap ? [owner.id, groupGuest.id, directGuest.id].sort() : []);
            for (const { principal } of explicit) await setCollectionGrant(owner.id, { ...address, principal,
                accessLevel: 'edit', expectedRevision: revision }, authentication);
            for (const { actor } of explicit) {
                const edited = await putSharedCollectionResource(actor.id, mutation(), authentication);
                expect(edited).toMatchObject({ access: 'edit', row: { revision: revision + 1 } });
                revision++;
            }
            for (const { principal } of explicit) await revokeCollectionGrant(owner.id, { ...address, principal });
            for (const actor of [teamGuest, groupGuest, directGuest]) await expect(read(actor)).rejects.toMatchObject({ code: 'collection_unavailable' });
            expect((await listSharedCollectionResources(groupGuest.id, { pluginId, collectionId: ref.collectionId, readerContext: ref })).resources).toEqual([]);
            expect(await envelopes()).toEqual(before);
        } finally {
            await db.account.deleteMany({ where: { id: { in: [owner.id, teamGuest.id, groupGuest.id, directGuest.id, keyless.id] } } });
            await db.team.delete({ where: { id: team.id } });
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
            expect(await db.pluginCollectionGrant.count({ where: { row: { accountId: owner.id } } })).toBe(0);
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
