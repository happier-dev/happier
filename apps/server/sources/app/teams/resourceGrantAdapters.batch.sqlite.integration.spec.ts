import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { db } from '@/storage/db';
import { inReadSnapshot } from '@/storage/inTx';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { observePrismaReads } from '@/testkit/observePrismaReads';
import { artifactGrantStorageAdapter } from '@/app/artifacts/artifactGrantStorageAdapter';
import { discussionGrantStorageAdapter } from '@/app/discussions/access';
import { taskGrantStorageAdapter } from '@/app/todos/taskGrantStorageAdapter';
import { collectionGrantStorageAdapter } from '@/app/plugins/data/collections/sharingStorage';
import { resolveResourceGrantAccessFromFacts } from './resourceGrantAccess';

let harness: LightSqliteHarness;
beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'happier-grant-batch-' }); }, 180_000);
afterAll(async () => { await harness?.close(); });

it('reads each resource set once, preserves mode and direct access, and omits absent or deleted resources', async () => {
    const owner = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const reader = await db.account.create({ data: { publicKey: randomUUID(), encryptionMode: 'plain' } });
    const artifacts = await Promise.all([null, new Date()].map(deletedAt => db.artifact.create({ data: {
        id: randomUUID(), accountId: owner.id, header: new Uint8Array(), body: new Uint8Array(),
        dataEncryptionKey: new Uint8Array(), deletedAt,
    } })));
    await db.artifactGrant.create({ data: { principalKind: 'account', artifactId: artifacts[0]!.id, accountId: reader.id,
        accessLevel: 'edit', createdByAccountId: owner.id } });
    const tasks = await Promise.all(['todo.task', 'todo.index'].map(key => db.userKVStore.create({ data: {
        accountId: owner.id, key, value: new Uint8Array([1]),
    } })));
    const discussion = await db.discussion.create({ data: { ownerAccountId: owner.id, encryptionMode: 'plain',
        dataEncryptionKey: new Uint8Array(), creationLocalId: randomUUID(), creationEqualityEvidenceV1: {},
        titleContent: {}, lastMessageAt: new Date(),
    } });
    const contract = await db.pluginCollectionContract.create({ data: {
        pluginId: 'grant.batch', collectionId: 'rows', schemaVersion: 1,
        contractDigest: 'A'.repeat(43), normalizedSchema: {}, indexes: [], relations: [], privacyProjection: {},
    } });
    const collections = await Promise.all([null, new Date()].map(deletedAt => db.pluginCollectionRow.create({ data: {
        accountId: owner.id, pluginId: 'grant.batch', collectionId: 'rows', rowId: randomUUID(), schemaVersion: 1,
        revision: 1, contractId: contract.id, contractDigest: contract.contractDigest, contentEnvelope: {}, deletedAt,
    } })));
    const cases = [
        { adapter: artifactGrantStorageAdapter, model: 'artifact' as const, present: artifacts[0]!.id, absent: artifacts[1]!.id },
        { adapter: taskGrantStorageAdapter, model: 'userKVStore' as const, present: tasks[0]!.id, absent: tasks[1]!.id },
        { adapter: discussionGrantStorageAdapter, model: 'discussion' as const, present: discussion.id, absent: randomUUID() },
        { adapter: collectionGrantStorageAdapter, model: 'pluginCollectionRow' as const, present: collections[0]!.id, absent: collections[1]!.id },
    ];
    for (const entry of cases) {
        await inReadSnapshot(async tx => {
            const observed = observePrismaReads(tx, [entry.model]);
            const facts = await entry.adapter.readAccessFactsBatchInTx(observed.tx,
                [entry.present, entry.absent, entry.present, 'missing'], reader.id);
            expect([...facts.keys()]).toEqual([entry.present]);
            expect(facts.get(entry.present)).toMatchObject({ ownerAccountId: owner.id, encryptionMode: 'plain' });
            expect(resolveResourceGrantAccessFromFacts(facts.get(entry.present)!, owner.id)?.level).toBe('owner');
            expect(resolveResourceGrantAccessFromFacts(facts.get(entry.present)!, reader.id)?.level ?? null)
                .toBe(entry.model === 'artifact' ? 'edit' : null);
            expect(observed.reads).toEqual([entry.model + '.findMany']);
            observed.reads.length = 0;
            expect(await entry.adapter.readAccessFactsBatchInTx(observed.tx, [], reader.id)).toEqual(new Map());
            expect(observed.reads).toEqual([]);
            expect(await entry.adapter.readAccessFactsInTx(observed.tx, entry.present, reader.id)).toEqual(facts.get(entry.present));
            expect(observed.reads).toEqual([entry.model + '.findMany']);
        });
    }
});
