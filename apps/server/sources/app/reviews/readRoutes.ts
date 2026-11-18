import { z } from 'zod/mini';
import { ReviewCommentOperationErrorCodeV1Schema } from '@happier-dev/protocol/reviews/comments/actions';
import {
    ReviewListRequestV1Schema, ReviewListResponseV1Schema,
    ReviewHistoryRequestV1Schema, ReviewHistoryResponseV1Schema,
} from '@happier-dev/protocol/reviews/reviewListV1';
import { TeamErrorCodeV1Schema, TeamErrorV1Schema, teamErrorHttpStatusV1 } from '@happier-dev/protocol/teams/errors';
import type { Fastify } from '@/app/api/types';
import { homeDomainActionPathForMethod } from '@/app/api/routes/actions/homeDomainActionRoute';
import { inReadSnapshot } from '@/storage/inTx';
import { listReviewsInTx, readReviewHistoryInTx } from './reviewListService';

const ReadErrorSchema = z.union([
    z.strictObject({ error: ReviewCommentOperationErrorCodeV1Schema }),
    TeamErrorV1Schema,
]);
const errorResponses = { 400: ReadErrorSchema, 403: ReadErrorSchema, 404: ReadErrorSchema,
    409: ReadErrorSchema, 503: ReadErrorSchema } as const;

type ReadErrorReply = { code(status: 400 | 403 | 404 | 409 | 503): {
    send(payload: { error: z.infer<typeof ReviewCommentOperationErrorCodeV1Schema> | z.infer<typeof TeamErrorCodeV1Schema> }): unknown;
} };

function sendReadError(reply: ReadErrorReply, error: unknown) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === 'review_comment_invalid_filter') return reply.code(400).send({ error: code });
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
        } catch (error) { return sendReadError(reply, error); }
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
        } catch (error) { return sendReadError(reply, error); }
    });
}
