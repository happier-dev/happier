import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { ReviewListResponseV1Schema } from '@happier-dev/protocol/reviews/reviewListV1';
import { createAccountServerActionDeps } from '../../../../cli/src/api/accountServerActionDeps';
import { auth } from '@/app/auth/auth';
import { enableAuthentication } from '@/app/api/utils/enableAuthentication';
import { enableSchemaValidation } from '@/app/api/utils/enableSchemaValidation';
import type { Fastify as AppFastify } from '@/app/api/types';
import { db } from '@/storage/db';
import { createDatabaseIntegrationHarness } from '@/testkit/databaseIntegrationHarness';
import { registerReviewReadRoutes } from './readRoutes';

describe('Review read Actions through authenticated HTTP', () => {
    let harness: Awaited<ReturnType<typeof createDatabaseIntegrationHarness>>;
    let app: AppFastify;
    let origin: string;
    beforeAll(async () => {
        harness = await createDatabaseIntegrationHarness({ tempDirPrefix: 'happier-review-read-actions-', initAuth: true });
        app = Fastify().withTypeProvider<ZodTypeProvider>();
        enableSchemaValidation(app);
        enableAuthentication(app);
        registerReviewReadRoutes(app);
        await app.listen({ port: 0, host: '127.0.0.1' });
        const address = app.server.address();
        if (!address || typeof address === 'string') throw new Error('Expected HTTP listener');
        origin = `http://127.0.0.1:${address.port}`;
    }, 180_000);
    afterAll(async () => { await app?.close(); await harness?.close(); });

    it('reads persisted findings beyond one page and only the current requested-person verdict', async () => {
        const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
        const reviewId = randomUUID();
        await db.artifact.create({ data: { id: reviewId, accountId: owner.id,
            header: new Uint8Array(), body: new Uint8Array(), dataEncryptionKey: new Uint8Array(),
            reviewMetadata: { create: { subjectKind: 'repository', sourceKind: 'workflow', state: 'completed',
                currentRoundOrdinal: 2, startedAt: new Date(1000), finishedAt: new Date(2000) } } } });
        // Persisted boundary fixtures: this read must count roots, independently of body paging and appearances.
        const findings = Array.from({ length: 51 }, (_, index) => {
            const id = randomUUID();
            return { id, accountId: owner.id, reviewId, findingIdentity: `finding-${index}`,
                threadId: id, state: 'open', reviewTriageStatus: index === 50 ? null : 'reject',
                flagsJson: '{}', anchorJson: '{}', snapshotEnvelopeJson: '{}', bodyEnvelopeJson: '{}',
                bodyVersion: 1, authorJson: '{}', editsJson: '[]', dispositionsJson: '{}', transitionsJson: '[]',
                serverRevision: 1, createdAt: BigInt(index), updatedAt: BigInt(index) };
        });
        await db.reviewComment.createMany({ data: findings });
        const pending = findings[50]!;
        await db.reviewCommentAppearance.createMany({ data: ['first', 'second'].map(reviewerId => ({
            reviewId, commentId: pending.id, roundOrdinal: 2, runId: 'review-run', reviewerId, sourceKey: reviewerId,
        })) });
        await db.reviewRequestedReviewer.create({ data: { reviewId, roundOrdinal: 2,
            principalKey: `account:${owner.id}`, principal: { kind: 'account', accountId: owner.id }, required: true,
            eligibleAccounts: { create: { accountId: owner.id } } } });
        await db.reviewVerdict.create({ data: { reviewId, roundOrdinal: 1, accountId: owner.id, verdict: 'approve' } });
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const executor = createActionExecutor(createAccountServerActionDeps({ token, serverId: origin, serverHttpBaseUrl: origin }));
        const read = () => executor.execute('review.get', { reviewId },
            { surface: 'cli', authority: 'present_user', serverId: origin, bypassApprovals: true });
        expect(await read()).toMatchObject({ ok: true, result: {
            review: { state: 'completed', currentRoundOrdinal: 2, counts: { total: 51, needsDecision: 1 } },
            human: { roundOrdinal: 2, requests: [{ required: true, roundOrdinal: 2 }],
                verdicts: [{ roundOrdinal: 1, verdict: 'approve' }], needsYou: { requestedVerdict: true, needsYou: true } },
        } });
        await db.reviewVerdict.create({ data: { reviewId, roundOrdinal: 2, accountId: owner.id, verdict: 'request_changes' } });
        await db.reviewComment.update({ where: { id: pending.id }, data: { reviewTriageStatus: 'reject' } });
        expect(await read()).toMatchObject({ ok: true, result: {
            review: { state: 'completed', counts: { total: 51, needsDecision: 0 } },
            human: { verdicts: [{ roundOrdinal: 1, verdict: 'approve' }, { roundOrdinal: 2, verdict: 'request_changes' }],
                needsYou: { requestedVerdict: false, needsYou: false } },
        } });
    });

    it.each(['plain', 'e2ee'] as const)('reads only the caller’s demanded metadata page and authorized history (%s)', async encryptionMode => {
        const owner = await db.account.create({ data: { encryptionMode } });
        const outsider = await db.account.create({ data: { encryptionMode } });
        const workflowId = randomUUID();
        const make = async (accountId: string, sequence: number) => {
            const id = randomUUID();
            const at = new Date(sequence * 1000);
            await db.artifact.create({ data: { id, accountId, header: new Uint8Array(), body: new Uint8Array(),
                dataEncryptionKey: new Uint8Array(), createdAt: at, updatedAt: at } });
            await db.reviewMetadata.create({ data: { artifactId: id, workflowId, subjectKind: 'repository',
                sourceKind: 'workflow', state: 'completed', currentRoundOrdinal: 1, startedAt: at } });
            return id;
        };
        const previous = await make(owner.id, 1);
        const current = await make(owner.id, 2);
        const hidden = await make(outsider.id, 3);
        const token = await auth.createToken(owner.id, undefined, { kind: 'account', authority: 'present_user' });
        const executor = createActionExecutor(createAccountServerActionDeps({ token, serverId: origin, serverHttpBaseUrl: origin }));
        const context = { surface: 'cli', authority: 'present_user', serverId: origin, bypassApprovals: true } as const;
        const first = await executor.execute('reviews.list', { limit: 1, workflowId }, context);
        expect(first, JSON.stringify(first)).toMatchObject({ ok: true, result: { items: [{ reviewId: current, counts: { total: 0, needsDecision: 0 } }], cursor: expect.any(String) } });
        if (!first.ok) throw new Error('Expected owner read');
        const page = ReviewListResponseV1Schema.parse(first.result);
        expect(page.items).toHaveLength(1);
        const second = await executor.execute('reviews.list', { limit: 1, workflowId, cursor: page.cursor }, context);
        expect(second).toMatchObject({ ok: true, result: { items: [{ reviewId: previous }], cursor: null } });
        expect(await executor.execute('review.history.list', { workflowId, reviewId: current }, context))
            .toMatchObject({ ok: true, result: { previousReviewId: previous, items: [] } });
        expect(await executor.execute('review.history.list', { workflowId, reviewId: hidden }, context))
            .toMatchObject({ ok: true, result: { previousReviewId: null, items: [] } });
        const unauthenticated = await app.inject({ method: 'POST', url: '/v1/reviews/list', payload: { limit: 1 } });
        expect(unauthenticated.statusCode).toBe(401);
        const invalid = await app.inject({ method: 'POST', url: '/v1/reviews/list', headers: { authorization: `Bearer ${token}` },
            payload: { limit: 1, actorAccountId: outsider.id } });
        expect(invalid.statusCode).toBe(400);
        expect(invalid.json()).toEqual({ error: 'review_comment_invalid_request' });
    });
});
