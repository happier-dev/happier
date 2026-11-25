import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
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
import { executeReviewCommentTransportV1 } from '@happier-dev/protocol/reviews/comments/transport';
import type { ReviewCommentResourceCryptoV1 } from '@happier-dev/protocol/reviews/comments/content';
import { computeCanonicalDomainSeparatedKeyedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import { createSignedAccountContentBinding } from '@/testkit/accountEncryption';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerReviewCommentRoutes } from '@/app/reviews/comments/routes';
import { updateAccountEncryptionMode } from '@/app/api/routes/account/updateAccountEncryptionMode';
import { initEncrypt } from '@/modules/encrypt';

const ownerId = randomUUID();
const recipientId = randomUUID();
const reviewId = randomUUID();
let connected = false;
const previousMasterSecret = process.env.HANDY_MASTER_SECRET;
beforeAll(async () => {
    if (!process.env.HAPPIER_DB_CONTRACT_CONTAINER_ID) throw new Error('Review conversion requires the disposable DB-contract runner');
    initDbPostgres();
    await db.$connect();
    connected = true;
    process.env.HANDY_MASTER_SECRET ??= 'review-recipient-conversion-test-only';
    await initEncrypt();
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
    if (previousMasterSecret === undefined) delete process.env.HANDY_MASTER_SECRET;
    else process.env.HANDY_MASTER_SECRET = previousMasterSecret;
});

it('preserves recipient-authored resource ciphertext when that recipient converts from E2EE to Plain', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
    const recipient = await db.account.create({ data: { encryptionMode: 'e2ee', ...createSignedAccountContentBinding() } });
    const encryptedReviewId = randomUUID();
    try {
        await db.artifact.create({ data: { id: encryptedReviewId, accountId: owner.id,
            kind: deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 }),
            header: randomBytes(40), body: randomBytes(40), dataEncryptionKey: randomBytes(80),
            reviewMetadata: { create: { subjectKind: 'comparison', sourceKind: 'direct', state: 'completed',
                currentRoundOrdinal: 1, startedAt: new Date(1) } } } });
        await db.artifactGrant.create({ data: { artifactId: encryptedReviewId, principalKind: 'account', accountId: recipient.id,
            accessLevel: 'view', createdByAccountId: owner.id } });
        // The authorized client's resource-key crypto is the boundary; transport, HTTP and PostgreSQL stay real.
        const resourceKey = randomBytes(32);
        const resource: ReviewCommentResourceCryptoV1 = { reviewId: encryptedReviewId, mode: 'e2ee',
            seal: async value => {
                const nonce = randomBytes(12);
                const cipher = createCipheriv('aes-256-gcm', resourceKey, nonce);
                const bytes = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
                return { t: 'encrypted', c: Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64') };
            },
            open: async envelope => {
                if (envelope.t !== 'encrypted') throw new Error('Expected resource ciphertext');
                const bytes = Buffer.from(envelope.c, 'base64');
                const decipher = createDecipheriv('aes-256-gcm', resourceKey, bytes.subarray(0, 12));
                decipher.setAuthTag(bytes.subarray(12, 28));
                return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()) as unknown;
            },
            commitment: (purpose, input) => computeCanonicalDomainSeparatedKeyedDigest(resourceKey,
                'happier:review-comment-resource-commitment:v1', [encryptedReviewId, purpose, input]),
        };
        await withAuthenticatedTestApp(registerReviewCommentRoutes, async app => {
            const request = async (request: Parameters<Parameters<typeof executeReviewCommentTransportV1>[0]['request']>[0]) => {
                const response = await app.inject({ method: request.method.toUpperCase() as 'GET' | 'POST', url: request.path,
                    headers: { 'x-test-user-id': recipient.id }, payload: request.body, query: request.query });
                expect(response.statusCode, response.body).toBe(200);
                return response.json() as unknown;
            };
            const input = { reviewId: encryptedReviewId, roundOrdinal: 1, body: 'Recipient encrypted finding',
                anchor: { kind: 'file', filePath: 'recipient-private.ts' }, snapshot: { kind: 'none', capturedAt: 1 },
                authorIntent: 'open', clientMutationId: randomUUID() };
            const create = await executeReviewCommentTransportV1({ actionId: 'reviews.comments.create', input,
                context: { accountId: recipient.id, mode: 'e2ee', material: null, resource },
                actor: { kind: 'user', userId: recipient.id }, randomBytes, request });
            expect(create).toMatchObject({ comment: { accountId: owner.id, reviewId: encryptedReviewId,
                author: { kind: 'user', userId: recipient.id }, body: input.body } });
            const before = (await readArtifactAccountEncryptionMigrationRowsInTx(db, owner.id))[0]!;
            expect(before.reviewGraph!.comments).toHaveLength(1);
            expect(before.reviewGraph!.comments[0]!.stored.sensitiveEnvelope).toMatchObject({ t: 'encrypted' });
            expect(before.reviewGraph!.comments[0]!.events).toHaveLength(1);
            expect(await createReviewCommentAccountEncryptionMigrationPersistenceInTx(db).readInventory(recipient.id)).toEqual([]);
            const serialized = JSON.stringify(before.reviewGraph);
            expect(serialized).not.toContain(input.body);
            expect(serialized).not.toContain('recipient-private.ts');
            expect(await updateAccountEncryptionMode({ accountId: recipient.id, mode: 'plain' }))
                .toMatchObject({ status: 'updated', mode: 'plain' });
            expect((await db.account.findUniqueOrThrow({ where: { id: recipient.id } })).encryptionMode).toBe('plain');
            expect((await db.account.findUniqueOrThrow({ where: { id: owner.id } })).encryptionMode).toBe('e2ee');
            const after = (await readArtifactAccountEncryptionMigrationRowsInTx(db, owner.id))[0]!;
            expect(after).toEqual(before);
            const commentId = before.reviewGraph!.comments[0]!.stored.structural.id;
            expect(await executeReviewCommentTransportV1({ actionId: 'reviews.comments.get', input: { commentId, reviewId: encryptedReviewId },
                context: { accountId: recipient.id, mode: 'e2ee', material: null, resource },
                actor: { kind: 'user', userId: recipient.id }, randomBytes, request }))
                .toMatchObject({ comment: { id: commentId, body: input.body, anchor: input.anchor } });
        });
    } finally {
        await db.artifact.deleteMany({ where: { id: encryptedReviewId } });
        await db.account.deleteMany({ where: { id: { in: [owner.id, recipient.id] } } });
    }
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
    if (directive.action !== 'migrate') throw new Error('Expected migrate directive');
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
