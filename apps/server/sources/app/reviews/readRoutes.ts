import { z } from 'zod/mini';
import { ReviewCommentOperationErrorCodeV1Schema } from '@happier-dev/protocol/reviews/comments/actions';
import {
    ReviewListRequestV1Schema, ReviewListResponseV1Schema,
    REVIEW_GET_CONTENT_ARTIFACT_QUERY_V1, ReviewGetHttpBodyV1Schema, ReviewGetResponseV1Schema,
    ReviewHistoryRequestV1Schema, ReviewHistoryResponseV1Schema,
} from '@happier-dev/protocol/reviews/reviewListV1';
import { ReviewHumanErrorCodeV1Schema, ReviewHumanErrorV1Schema } from '@happier-dev/protocol/reviews/reviewHumanV1';
import { TeamErrorCodeV1Schema, TeamErrorV1Schema, teamErrorHttpStatusV1 } from '@happier-dev/protocol/teams/errors';
import type { Fastify } from '@/app/api/types';
import { homeDomainActionPathForMethod } from '@/app/api/routes/actions/homeDomainActionRoute';
import { inReadSnapshot } from '@/storage/inTx';
import { readArtifactForCallerInTx } from '@/app/artifacts/artifactAccessService';
import { projectArtifactHttpRead } from '@/app/artifacts/artifactHttpRead';
import { listReviewsInTx, readAdmittedReviewDetailInTx, readReviewHistoryInTx } from './reviewListService';
import { resolveReviewAccessInTx } from './reviewAccess';
import { readAdmittedReviewHumanStateInTx } from './reviewHumanService';
import { reviewHumanErrorHttpStatus } from './reviewHumanRoutes';
import { ReviewCommentOperationError } from './comments/errors';

const ReadErrorSchema = z.union([
    z.strictObject({ error: ReviewCommentOperationErrorCodeV1Schema, message: z.optional(z.string()) }),
    ReviewHumanErrorV1Schema,
    TeamErrorV1Schema,
]);
const errorResponses = { 400: ReadErrorSchema, 403: ReadErrorSchema, 404: ReadErrorSchema,
    409: ReadErrorSchema, 503: ReadErrorSchema } as const;

type ReadErrorReply = { code(status: 400 | 403 | 404 | 409 | 503): {
    send(payload: { error: z.infer<typeof ReviewCommentOperationErrorCodeV1Schema> | z.infer<typeof ReviewHumanErrorCodeV1Schema> | z.infer<typeof TeamErrorCodeV1Schema>; message?: string }): unknown;
} };

function sendReadError(reply: ReadErrorReply, error: unknown) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'review_comment_invalid_filter') return reply.code(400).send({ error: code,
        ...(error instanceof ReviewCommentOperationError ? { message: error.message } : {}) });
    const human = ReviewHumanErrorCodeV1Schema.safeParse(code);
    if (human.success) {
        return reply.code(reviewHumanErrorHttpStatus(human.data)).send({ error: human.data });
    }
    const team = TeamErrorCodeV1Schema.safeParse(code);
    if (team.success) return reply.code(teamErrorHttpStatusV1(team.data)).send({ error: team.data });
    throw error;
}

/** The Artifact query owner authorizes metadata; transport supplies only the authenticated Account. */
export function registerReviewReadRoutes(app: Fastify) {
    app.post(homeDomainActionPathForMethod('reviews.list', 'POST'), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: { body: ReviewListRequestV1Schema, response: { 200: ReviewListResponseV1Schema, ...errorResponses } },
    }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ error: 'review_comment_invalid_request' });
        try {
            return reply.send(await inReadSnapshot(tx => listReviewsInTx(tx, {
                ...request.body, actorAccountId: request.userId,
            })));
        } catch (error) { sendReadError(reply, error); return reply; }
    });

    app.post(homeDomainActionPathForMethod('review.get', 'POST'), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: {
            body: ReviewGetHttpBodyV1Schema,
            querystring: z.object({ [REVIEW_GET_CONTENT_ARTIFACT_QUERY_V1]: z.optional(z.literal('true')) }),
            response: { 200: ReviewGetResponseV1Schema, ...errorResponses },
        },
    }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ error: 'review_invalid_request' });
        try {
            return reply.send(await inReadSnapshot(async tx => {
                const access = await resolveReviewAccessInTx(tx, { actorAccountId: request.userId, reviewId: request.body.reviewId, includeDetail: true });
                if (!access) throw Object.assign(new Error('review_not_found'), { code: 'review_not_found' });
                const review = await readAdmittedReviewDetailInTx(tx, access);
                const human = await readAdmittedReviewHumanStateInTx(tx, { actorAccountId: request.userId, access,
                    facts: { currentRoundOrdinal: review.currentRoundOrdinal, pendingDecisionCount: review.counts.needsDecision } });
                if (!request.query[REVIEW_GET_CONTENT_ARTIFACT_QUERY_V1]) return { review, human };
                const content = await readArtifactForCallerInTx(tx, { actorAccountId: request.userId, artifactId: access.reviewId });
                return { review, human, ...(content.ok ? { contentArtifact: projectArtifactHttpRead(content.artifact) } : {}) };
            }));
        } catch (error) { sendReadError(reply, error); return reply; }
    });

    app.post(homeDomainActionPathForMethod('review.history.list', 'POST'), {
        preHandler: app.authenticate,
        attachValidation: true,
        schema: { body: ReviewHistoryRequestV1Schema, response: { 200: ReviewHistoryResponseV1Schema, ...errorResponses } },
    }, async (request, reply) => {
        if (request.validationError) return reply.code(400).send({ error: 'review_comment_invalid_request' });
        try {
            return reply.send(await inReadSnapshot(tx => readReviewHistoryInTx(tx, {
                ...request.body, actorAccountId: request.userId,
            })));
        } catch (error) { sendReadError(reply, error); return reply; }
    });
}
