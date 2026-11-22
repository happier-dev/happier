import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { AccountEncryptionMigrateArtifactsDirectiveSchema, ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol';
import { db, initDbPostgres } from '@/storage/db';
import { inTx } from '@/storage/inTx';
import { createReviewCommentOperations } from '@/app/reviews/comments/operations';
import { createSqlReviewCommentStore } from '@/app/reviews/comments/store';
import { resolveReviewAccessInTx } from '@/app/reviews/reviewAccess';
import { createReviewCommentAccountEncryptionMigrationPersistenceInTx } from '@/app/reviews/comments/accountEncryptionMigrationPersistence';
import { readArtifactAccountEncryptionMigrationRowsInTx, migrateArtifactAccountEncryptionInTx } from './artifactWriteService';

const ownerId = randomUUID();
const recipientId = randomUUID();
const reviewId = randomUUID();
let connected = false;
beforeAll(async () => {
    if (!process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID) throw new Error('Review conversion requires the disposable DB-contract runner');
    initDbPostgres();
    await db.$connect();
    connected = true;
    await db.account.createMany({ data: [ownerId, recipientId].map(id => ({ id, publicKey: id, encryptionMode: 'plain' })) });
    await db.artifact.create({ data: { id: reviewId, accountId: ownerId, kind: deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 }),
        header: Buffer.from(encodePlainArtifactStoredContent({ kind: REVIEW_ARTIFACT_KIND_V1, title: 'Review' }), 'base64'),
        body: Buffer.from(encodePlainArtifactStoredContent({ body: 'Review' }), 'base64'),
        dataEncryptionKey: Buffer.from(ARTIFACT_PLAIN_DATA_KEY_MARKER, 'base64'),
        reviewMetadata: { create: { subjectKind: 'comparison', sourceKind: 'direct', state: 'completed', currentRoundOrdinal: 1, startedAt: new Date(1) } } } });
    await db.artifactGrant.create({ data: { artifactId: reviewId, principalKind: 'account', accountId: recipientId,
        accessLevel: 'edit', createdByAccountId: ownerId } });
});
afterAll(async () => {
    if (!connected) return;
    await db.artifact.deleteMany({ where: { id: reviewId } });
    await db.account.deleteMany({ where: { id: { in: [ownerId, recipientId] } } });
    await db.$disconnect();
});

it('keeps attached content out of Account conversion and commits the complete resource graph or rolls it back', async () => {
    const operations = createReviewCommentOperations(createSqlReviewCommentStore(), {
        now: Date.now,
        createId: prefix => `${prefix}-${randomUUID()}`,
    });
    const actor = { kind: 'user' as const, userId: recipientId };
    const access = await resolveReviewAccessInTx(db, { actorAccountId: recipientId, reviewId });
    expect(access).not.toBeNull();
    const input = { anchor: { kind: 'file' as const, filePath: 'private.ts' }, snapshot: { kind: 'none' as const, capturedAt: 1 },
        body: 'recipient comment', authorIntent: 'open' as const, clientMutationId: randomUUID() };
    const attached = await operations.create({ accountId: recipientId, actor, reviewAccess: access!, input: { ...input, reviewId } });
    const privateComment = await operations.create({ accountId: recipientId, actor,
        input: { ...input, projectId: randomUUID(), clientMutationId: randomUUID() } });
    await db.reviewVerdict.create({ data: { reviewId, roundOrdinal: 1, accountId: recipientId, verdict: 'comment', revision: 1,
        content: { t: 'plain', v: { reviewId, roundOrdinal: 1, accountId: recipientId, revision: 1, body: 'private verdict' } } } });
    const persistence = createReviewCommentAccountEncryptionMigrationPersistenceInTx(db);
    expect((await persistence.readInventory(recipientId)).map(item => item.commentId)).toEqual([privateComment.comment.id]);
    expect(await persistence.readInventory(ownerId)).toEqual([]);
    // Removed access never removes the collaborator's already-owned Review content.
    await db.artifactGrant.deleteMany({ where: { artifactId: reviewId, accountId: recipientId } });
    const row = (await readArtifactAccountEncryptionMigrationRowsInTx(db, ownerId))[0]!;
    const graph = row.reviewGraph!;
    expect(graph.comments).toMatchObject([{ stored: { structural: { id: attached.comment.id } }, events: [{ event: { commentId: attached.comment.id } }] }]);
    expect(graph.verdicts).toMatchObject([{ accountId: recipientId, content: { t: 'plain' } }]);
    const bound = graph.comments[0]!;
    await expect(persistence.rewriteCommentSensitiveEnvelope({
        accountId: ownerId, commentId: bound.stored.structural.id,
        expectedServerRevision: bound.stored.structural.serverRevision,
        expectedBodyVersion: bound.stored.structural.bodyVersion,
        expectedSensitiveSource: { v: 1, layout: 'canonical_v1', envelope: bound.stored.sensitiveEnvelope },
        targetSensitiveEnvelope: bound.stored.sensitiveEnvelope,
    })).rejects.toThrow('review_comment_migration_inventory_mismatch');
    const boundEvent = bound.events[0]!;
    await expect(persistence.rewriteEventSensitiveEnvelope({
        accountId: ownerId, commentId: bound.stored.structural.id, eventId: boundEvent.event.eventId,
        expectedSensitiveEnvelope: boundEvent.sensitiveEnvelope,
        targetSensitiveEnvelope: boundEvent.sensitiveEnvelope,
    })).rejects.toThrow('review_comment_migration_inventory_mismatch');
    await db.reviewCommentPublicationCorrelation.createMany({ data: [null, privateComment.comment.id, attached.comment.id]
        .map(commentId => ({ publicationCorrelationId: randomUUID(), accountId: recipientId, commentId,
            targetKey: randomUUID(), targetJson: '{}', createdAt: 1n })) });
    // Account-wide verdict publication and private comment publication remain Account-owned;
    // a collaborator's Review publication does not enter that Account's conversion inventory.
    expect(await persistence.readPublicationCorrelationCount(recipientId)).toBe(2);
    const target = { comments: graph.comments.map(item => ({ ...item,
        stored: { ...item.stored, sensitiveEnvelope: { t: 'encrypted' as const, c: 'opaque-resource-comment' } },
        events: item.events.map(event => ({ ...event, sensitiveEnvelope: { ...event.sensitiveEnvelope,
            sensitive: { t: 'encrypted' as const, c: 'opaque-resource-event' } } })) })),
        verdicts: graph.verdicts.map(item => ({ ...item, content: { t: 'encrypted' as const, c: 'opaque-resource-verdict' } })) };
    const replacementKey = Buffer.from([3, 4, 5]);
    // HTTP drops absent optional members from the storage owner's native objects.
    const directive = AccountEncryptionMigrateArtifactsDirectiveSchema.parse(JSON.parse(JSON.stringify({ action: 'migrate', items: [{ artifactId: reviewId,
        expectedHeaderVersion: row.headerVersion, expectedBodyVersion: row.bodyVersion,
        expectedDataEncryptionKey: Buffer.from(row.dataEncryptionKey).toString('base64'),
        header: Buffer.from([2, 1]).toString('base64'), body: Buffer.from([2, 2]).toString('base64'),
        dataEncryptionKey: replacementKey.toString('base64'), recipientKeyEnvelopes: [], blobs: [], revisions: [],
        reviewGraph: { expected: graph, target } }] })));
    const stale = structuredClone(directive);
    stale.items[0]!.reviewGraph!.expected.comments[0]!.stored.structural.bodyVersion += 1;
    expect(await inTx(tx => migrateArtifactAccountEncryptionInTx({ tx, accountId: ownerId,
        fromMode: 'plain', toMode: 'e2ee', directive: stale }))).toEqual({ status: 'migration_incomplete' });
    const convert = async (tx: Parameters<typeof migrateArtifactAccountEncryptionInTx>[0]['tx']) => {
        expect(await migrateArtifactAccountEncryptionInTx({ tx, accountId: ownerId, fromMode: 'plain', toMode: 'e2ee', directive }))
            .toEqual({ status: 'applied' });
    };
    const rollback = new Error('transaction-control');
    await expect(inTx(async tx => { await convert(tx); throw rollback; })).rejects.toBe(rollback);
    const unchanged = (await readArtifactAccountEncryptionMigrationRowsInTx(db, ownerId))[0]!;
    expect(unchanged.reviewGraph).toEqual(graph);
    expect(unchanged.dataEncryptionKey).toEqual(row.dataEncryptionKey);
    expect(unchanged.headerVersion).toBe(row.headerVersion);
    await inTx(convert);
    const converted = (await readArtifactAccountEncryptionMigrationRowsInTx(db, ownerId))[0]!;
    expect(converted.reviewGraph).toEqual(target);
    expect(Buffer.from(converted.dataEncryptionKey)).toEqual(replacementKey);
    expect(converted.headerVersion).toBe(row.headerVersion + 1);
    expect((await persistence.readInventory(recipientId)).map(item => item.commentId)).toEqual([privateComment.comment.id]);
});
