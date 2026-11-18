import { ReviewHumanGetInputV1Schema, ReviewReviewersSetInputV1Schema, ReviewVerdictSubmitInputV1Schema } from '@happier-dev/protocol/reviews/reviewHumanV1';
import { z } from 'zod/mini';
import type { Fastify } from '@/app/api/types';
import { inReadSnapshot, inTx } from '@/storage/inTx';
import { resolveReviewAccessInTx } from './reviewAccess';
import { readAdmittedReviewHumanStateInTx, setAdmittedReviewersInTx, submitAdmittedReviewVerdictInTx } from './reviewHumanService';

function statusFor(code: string): 400 | 403 | 404 | 409 | 503 {
    if (code === 'review_access_forbidden' || code === 'present_user_required') return 403;
    if (code === 'review_not_found' || code === 'review_reviewer_not_requested') return 404;
    if (code === 'review_verdict_revision_mismatch') return 409;
    return 400;
}

function sendError(reply: { code(status: number): { send(body: { error: string }): unknown } }, error: unknown) {
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'review_invalid_request';
    return reply.code(statusFor(code)).send({ error: code });
}

export function registerReviewHumanRoutes(app: Fastify) {
    const params = z.strictObject({ reviewId: z.string() });
    app.get('/v1/reviews/:reviewId/human', { preHandler: app.authenticate, attachValidation: true, schema: { params } }, async (request, reply) => {
        const parsed = ReviewHumanGetInputV1Schema.safeParse({ reviewId: request.params.reviewId });
        if (!parsed.success) return reply.code(400).send({ error: 'review_invalid_request' });
        try {
            return reply.send(await inReadSnapshot(async tx => {
                const access = await resolveReviewAccessInTx(tx, { actorAccountId: request.userId, reviewId: parsed.data.reviewId });
                if (!access) throw Object.assign(new Error('review_not_found'), { code: 'review_not_found' });
                return readAdmittedReviewHumanStateInTx(tx, { actorAccountId: request.userId, access });
            }));
        } catch (error) { return sendError(reply, error); }
    });
    app.post('/v1/reviews/:reviewId/reviewers', { preHandler: app.authenticate, attachValidation: true, schema: { params } }, async (request, reply) => {
        const parsed = ReviewReviewersSetInputV1Schema.safeParse({ ...request.body, reviewId: request.params.reviewId });
        if (!parsed.success) return reply.code(400).send({ error: 'review_invalid_request' });
        try {
            return reply.send(await inTx(async tx => {
                const access = await resolveReviewAccessInTx(tx, { actorAccountId: request.userId, reviewId: parsed.data.reviewId });
                if (!access) throw Object.assign(new Error('review_not_found'), { code: 'review_not_found' });
                return setAdmittedReviewersInTx(tx, { actorAccountId: request.userId, access, request: parsed.data });
            }));
        } catch (error) { return sendError(reply, error); }
    });
    app.post('/v1/reviews/:reviewId/verdicts', { preHandler: app.authenticate, attachValidation: true, schema: { params } }, async (request, reply) => {
        if (request.authAuthority !== 'present_user') return reply.code(403).send({ error: 'present_user_required' });
        const parsed = ReviewVerdictSubmitInputV1Schema.safeParse({ ...request.body, reviewId: request.params.reviewId });
        if (!parsed.success) return reply.code(400).send({ error: 'review_invalid_request' });
        try {
            return reply.send(await inTx(async tx => {
                const access = await resolveReviewAccessInTx(tx, { actorAccountId: request.userId, reviewId: parsed.data.reviewId });
                if (!access) throw Object.assign(new Error('review_not_found'), { code: 'review_not_found' });
                return submitAdmittedReviewVerdictInTx(tx, { actorAccountId: request.userId, access, request: parsed.data });
            }));
        } catch (error) { return sendError(reply, error); }
    });
}
