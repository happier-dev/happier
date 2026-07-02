import {
    executeReviewCommentProtocolAction,
    type ReviewCommentUiActionExecutor,
} from './api';

export type CreateReviewCommentsActionsParams = Readonly<{
    execute: ReviewCommentUiActionExecutor;
}>;

export function createReviewCommentsActions(params: CreateReviewCommentsActionsParams) {
    return Object.freeze({
        list: async (input: unknown) => await executeReviewCommentProtocolAction({
            execute: params.execute,
            actionId: 'reviews.comments.list',
            input,
        }),
        create: async (input: unknown) => await executeReviewCommentProtocolAction({
            execute: params.execute,
            actionId: 'reviews.comments.create',
            input,
        }),
        get: async (input: unknown) => await executeReviewCommentProtocolAction({
            execute: params.execute,
            actionId: 'reviews.comments.get',
            input,
        }),
        transition: async (input: unknown) => await executeReviewCommentProtocolAction({
            execute: params.execute,
            actionId: 'reviews.comments.transition',
            input,
        }),
        edit: async (input: unknown) => await executeReviewCommentProtocolAction({
            execute: params.execute,
            actionId: 'reviews.comments.edit',
            input,
        }),
        reply: async (input: unknown) => await executeReviewCommentProtocolAction({
            execute: params.execute,
            actionId: 'reviews.comments.reply',
            input,
        }),
        redact: async (input: unknown) => await executeReviewCommentProtocolAction({
            execute: params.execute,
            actionId: 'reviews.comments.redact',
            input,
        }),
        setDisposition: async (input: unknown) => await executeReviewCommentProtocolAction({
            execute: params.execute,
            actionId: 'reviews.comments.setDisposition',
            input,
        }),
        attachEvidence: async (input: unknown) => await executeReviewCommentProtocolAction({
            execute: params.execute,
            actionId: 'reviews.comments.attachEvidence',
            input,
        }),
        bulkTransition: async (input: unknown) => await executeReviewCommentProtocolAction({
            execute: params.execute,
            actionId: 'reviews.comments.bulkTransition',
            input,
        }),
    });
}
