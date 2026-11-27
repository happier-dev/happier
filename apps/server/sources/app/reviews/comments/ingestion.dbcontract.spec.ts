import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as privacyKit from 'privacy-kit';

import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { computeCanonicalDomainSeparatedDigest } from '@happier-dev/protocol/crypto/canonicalDigest';
import type { ReviewCommentResourceCryptoV1 } from '@happier-dev/protocol/reviews/comments/content';
import { REVIEW_COMMENT_RESOURCE_COMMITMENT_DOMAIN_V1 } from '@happier-dev/protocol/reviews/comments/content';
import { ReviewCommentCommitMutationRequestV1Schema } from '@happier-dev/protocol/reviews/comments/mutation';
import { executeReviewCommentCreateBatchTransportV1, ReviewCommentPrepareMutationBatchResponseV1Schema,
    ReviewCommentCommitMutationBatchResponseV1Schema } from '@happier-dev/protocol/reviews/comments/transport';
import { db, initDbMysql, initDbPostgres } from '@/storage/db';
import { initEncrypt } from '@/modules/encrypt';
import { withAuthenticatedTestApp } from '@/app/api/testkit/sqliteFastify';
import { registerReviewCommentRoutes } from './routes';

describe('Review finding ingestion database cost contract', () => {
    const accountId = `review-ingestion-${randomUUID()}`;
    const reviewId = randomUUID();
    let connected = false;
    beforeAll(async () => {
        if (!process.env.DATABASE_URL) throw new Error('Missing disposable DB contract DATABASE_URL');
        if (process.env.HAPPIER_DB_PROVIDER === 'mysql') await initDbMysql();
        else initDbPostgres();
        await db.$connect();
        connected = true;
        vi.stubEnv('HANDY_MASTER_SECRET', 'review-ingestion-disposable-test-master-secret');
        await initEncrypt();
        await db.account.create({ data: { id: accountId, publicKey: `pk-${accountId}`, encryptionMode: 'plain' } });
        await db.artifact.create({ data: { id: reviewId, accountId, kind: 'v1:other:review.v1',
            header: new Uint8Array(), body: new Uint8Array(),
            dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) } });
        await db.reviewMetadata.create({ data: { artifactId: reviewId, subjectKind: 'comparison', sourceKind: 'direct',
            state: 'completed', currentRoundOrdinal: 1, startedAt: new Date(1), finishedAt: new Date(2) } });
    });
    afterAll(async () => {
        if (!connected) return;
        await db.artifact.deleteMany({ where: { id: reviewId } });
        await db.account.deleteMany({ where: { id: accountId } });
        await db.$disconnect();
        vi.unstubAllEnvs();
    });

    it('creates fifteen findings in two HTTP requests, one transaction and one publication, preserving replay and partial failures', async () => {
        // The transport consumes an already acquired resource crypto boundary.
        // Plain resource encoding is the identity envelope used by Artifact storage.
        const resource: ReviewCommentResourceCryptoV1 = { reviewId, mode: 'plain',
            seal: async value => ({ t: 'plain', v: value }),
            open: async envelope => {
                if (envelope.t !== 'plain') throw new Error('Resource mode mismatch');
                return envelope.v;
            },
            commitment: (purpose, input) => computeCanonicalDomainSeparatedDigest(
                REVIEW_COMMENT_RESOURCE_COMMITMENT_DOMAIN_V1, [reviewId, purpose, input]),
        };
        const context = { accountId, mode: 'plain', material: null, resource } as const;
        const actor = { kind: 'user', userId: accountId } as const;
        const makeItem = (ordinal: number) => ({ context, actor, input: { reviewId,
            appearance: { roundOrdinal: 1, runId: 'run-ingest', reviewerId: 'reviewer-ingest' },
            findingId: `finding-${ordinal}`, findingIdentity: createHash('sha256').update(`identity-${ordinal}`).digest('hex'),
            anchor: { kind: 'finding', runId: 'run-ingest', findingId: `finding-${ordinal}` },
            snapshot: { kind: 'none', capturedAt: 1 }, body: `Finding ${ordinal}`,
            authorIntent: 'open', clientMutationId: `create-finding-${ordinal}`,
        } });
        const items = Array.from({ length: 15 }, (_, ordinal) => makeItem(ordinal));
        await withAuthenticatedTestApp(registerReviewCommentRoutes, async app => {
            const paths: string[] = [];
            let corruptNextCommit = false;
            const ingest = (selected: typeof items) => executeReviewCommentCreateBatchTransportV1({ items: selected, randomBytes,
                request: async request => {
                    paths.push(request.path);
                    const submitted = request.items.map(item => ({ input: item.body }));
                    if (corruptNextCommit && request.path.endsWith('/commitBatch')) {
                        const first = ReviewCommentCommitMutationRequestV1Schema.parse(submitted[0]!.input);
                        submitted[0] = { input: { ...first, records: first.records.map(record => ({ ...record,
                            sensitiveEnvelope: { t: 'encrypted', c: 'wrong-mode' } })) } };
                        corruptNextCommit = false;
                    }
                    const response = await app.inject({ method: 'POST', url: request.path,
                        headers: { 'x-test-user-id': accountId }, payload: { items: submitted } });
                    expect(response.statusCode, response.body).toBe(200);
                    return (request.path.endsWith('/prepareBatch') ? ReviewCommentPrepareMutationBatchResponseV1Schema
                        : ReviewCommentCommitMutationBatchResponseV1Schema).parse(response.json());
                },
            });
            const transaction = db.$transaction;
            let transactions = 0;
            db.$transaction = new Proxy(transaction, { apply: (target, thisArg, args) => {
                transactions++;
                return Reflect.apply(target, thisArg, args);
            } });
            try {
                const before = await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } });
                const created = await ingest(items);
                expect(created.every(item => item.ok && !item.replayed)).toBe(true);
                expect(created.flatMap(item => item.ok ? [item.comment.body] : [])).toEqual(items.map(item => item.input.body));
                const after = await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } });
                expect(paths).toEqual(['/v1/reviews/comments/mutations/prepareBatch', '/v1/reviews/comments/mutations/commitBatch']);
                expect(transactions).toBe(1);
                expect(after.seq - before.seq).toBe(1);
                expect(await db.reviewComment.count({ where: { reviewId } })).toBe(15);
                const publication = await db.accountChange.findUniqueOrThrow({ where: {
                    accountId_kind_entityId: { accountId, kind: 'artifact', entityId: reviewId } } });
                expect(publication.hint).toMatchObject({ reviewComments: { changes: created.flatMap(item => item.ok
                    ? [{ commentId: item.comment.id, serverRevision: 1, state: 'open' }] : []) } });
                console.info(`[review-ingestion] findings=15 http=${paths.length} transactions=${transactions} publications=${after.seq - before.seq}`);

                transactions = 0;
                const replay = await ingest(items.map(item => ({ ...item, input: { ...item.input,
                    clientMutationId: `${item.input.clientMutationId}-semantic-replay` } })));
                expect(replay.every(item => item.ok && item.replayed)).toBe(true);
                expect(replay.flatMap(item => item.ok ? [item.comment.id] : []))
                    .toEqual(created.flatMap(item => item.ok ? [item.comment.id] : []));
                expect(transactions).toBe(1);
                expect((await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } })).seq).toBe(after.seq);

                transactions = 0;
                const nextRound = await ingest(items.map(item => ({ ...item, input: { ...item.input,
                    appearance: { ...item.input.appearance, roundOrdinal: 2, runId: 'run-ingest-2' },
                    clientMutationId: `${item.input.clientMutationId}-round-two` } })));
                expect(nextRound.every(item => item.ok && item.replayed)).toBe(true);
                expect(transactions).toBe(1);
                expect((await db.account.findUniqueOrThrow({ where: { id: accountId }, select: { seq: true } })).seq - after.seq).toBe(1);
                expect(await db.reviewCommentAppearance.count({ where: { reviewId, roundOrdinal: 2 } })).toBe(15);

                const mixed = await ingest([{ ...items[0]!, input: { ...items[0]!.input, body: 'Changed immutable request' } }, makeItem(15)]);
                expect(mixed[0]).toMatchObject({ ok: false, errorCode: 'review_comment_idempotency_conflict' });
                expect(mixed[1]).toMatchObject({ ok: true, comment: { body: 'Finding 15' } });
                expect(await db.reviewComment.count({ where: { reviewId } })).toBe(16);
                expect(await db.reviewCommentEvent.count({ where: { accountId } })).toBe(16);
                corruptNextCommit = true;
                const wrongMode = await ingest([makeItem(16), makeItem(17)]);
                expect(wrongMode[0]).toMatchObject({ ok: false, errorCode: 'review_comment_encryption_mode_mismatch' });
                expect(wrongMode[1]).toMatchObject({ ok: true, comment: { body: 'Finding 17' } });
                expect(await db.reviewComment.count({ where: { reviewId } })).toBe(17);
                const duplicate = makeItem(18);
                const duplicates = await ingest([duplicate, { ...duplicate, input: { ...duplicate.input,
                    clientMutationId: `${duplicate.input.clientMutationId}-same-batch` } }]);
                expect(duplicates).toMatchObject([{ ok: true, replayed: false }, { ok: true, replayed: true }]);
                expect(new Set(duplicates.flatMap(item => item.ok ? [item.comment.id] : [])).size).toBe(1);
                expect(await db.reviewComment.count({ where: { reviewId } })).toBe(18);
                const sharedMutation = makeItem(19);
                const conflicts = await ingest([sharedMutation, { ...sharedMutation, input: { ...sharedMutation.input,
                    body: 'Conflicting same-batch immutable request' } }, makeItem(20)]);
                expect(conflicts).toMatchObject([{ ok: true },
                    { ok: false, errorCode: 'review_comment_idempotency_conflict' }, { ok: true }]);
                const durableComments = await db.reviewComment.count({ where: { reviewId } });
                const durableEvents = await db.reviewCommentEvent.count({ where: { accountId } });
                expect(durableComments).toBe(20);
                expect(durableEvents).toBe(20);
                console.info(`[review-ingestion] scenario=same-batch-client-conflict comments=${durableComments} events=${durableEvents}`);
            } finally { db.$transaction = transaction; }
        });
    });
});
