import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ReviewCommentListRequestV1Schema } from '@happier-dev/protocol/reviews/comments/actions';
import { deriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { REVIEW_ARTIFACT_KIND_V1 } from '@happier-dev/protocol/reviews/reviewArtifactV1';
import { db } from '@/storage/db';
import { createLightSqliteHarness, type LightSqliteHarness } from '@/testkit/lightSqliteHarness';
import { createSqlReviewCommentStore } from './store';
import { createReviewCommentOperations } from './operations';
import { resolveReviewAccessInTx } from '@/app/reviews/reviewAccess';

let harness: LightSqliteHarness;
beforeAll(async () => { harness = await createLightSqliteHarness({ tempDirPrefix: 'selected-findings-', initAuth: false }); }, 120_000);
afterAll(async () => { await harness?.close(); });

it('reads only selected authorized Review findings before paging and preserves history selection', async () => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const reader = await db.account.create({ data: { encryptionMode: 'plain' } });
    const operations = createReviewCommentOperations(createSqlReviewCommentStore(), {
        now: Date.now, createId: prefix => `${prefix}-${randomUUID()}`,
    });
    const reviews = await Promise.all([0, 1].map(() => db.artifact.create({ data: { id: randomUUID(), accountId: owner.id,
        kind: deriveArtifactStoredKindV1({ kind: REVIEW_ARTIFACT_KIND_V1 }),
        header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array(),
        reviewMetadata: { create: { subjectKind: 'repository', sourceKind: 'direct', state: 'completed',
            currentRoundOrdinal: 1, startedAt: new Date(1), finishedAt: new Date(2) } } } })));
    await db.artifactGrant.create({ data: { artifactId: reviews[0]!.id, principalKind: 'account',
        accountId: reader.id, accessLevel: 'view', createdByAccountId: owner.id } });
    const create = async (name: string, reviewId?: string) => operations.create({ accountId: owner.id,
        actor: { kind: 'user', userId: owner.id }, ...(reviewId ? { reviewAccess: (await resolveReviewAccessInTx(db,
            { actorAccountId: owner.id, reviewId }))! } : {}),
        input: { ...(reviewId ? { reviewId } : {}), projectId: 'selection-project',
            anchor: { kind: 'file', filePath: `${name}.ts` }, snapshot: { kind: 'none', capturedAt: 1 },
            body: name, authorIntent: 'open', clientMutationId: name } });
    const selected = await create('selected', reviews[0]!.id);
    const otherReview = await create('other-review', reviews[1]!.id);
    const privateRoot = await create('private-root');
    await create('newer-unselected', reviews[0]!.id);
    const reviewAccess = (await resolveReviewAccessInTx(db, { actorAccountId: reader.id, reviewId: reviews[0]!.id }))!;
    const list = (commentIds?: string[], includeHistory = false) => operations.list({ accountId: reader.id, reviewAccess,
        input: ReviewCommentListRequestV1Schema.parse({ reviewId: reviews[0]!.id, commentIds, includeHistory, limit: 1 }) });
    expect((await list()).items).toHaveLength(1);
    const page = await list([selected.comment.id, otherReview.comment.id, privateRoot.comment.id]);
    expect(page.items.map(comment => comment.id)).toEqual([selected.comment.id]);
    expect(page.cursor).toBeNull();
    expect((await list([])).items).toEqual([]);
    const ownerAccess = (await resolveReviewAccessInTx(db, { actorAccountId: owner.id, reviewId: reviews[0]!.id }))!;
    await operations.transition({ accountId: owner.id, actor: { kind: 'user', userId: owner.id }, reviewAccess: ownerAccess,
        input: { reviewId: reviews[0]!.id, commentId: selected.comment.id, toState: 'dismissed', expectedState: 'open',
            expectedServerRevision: 1, reason: 'Reviewed', clientMutationId: 'selection-dismiss' } });
    expect((await list([selected.comment.id])).items).toEqual([]);
    expect((await list([selected.comment.id], true)).items.map(comment => comment.id)).toEqual([selected.comment.id]);
});
