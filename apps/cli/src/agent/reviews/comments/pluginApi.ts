import {
    ReviewCommentActionInputSchemasV1,
    ReviewCommentActionOutputSchemasV1,
    type ReviewCommentActorRefV1,
    type ReviewCommentPrincipalHeaderV1,
    type ReviewCommentActionIdV1,
} from '@happier-dev/protocol';
import type {
    PluginReviewCommentResolveSnapshotRequestV1,
    PluginReviewCommentResolveSnapshotResultV1,
    PluginReviewCommentsServiceV1,
} from '@happier-dev/plugin-sdk';

export type ReviewCommentActionExecutionOptions = Readonly<{
    signal?: AbortSignal;
    principal?: ReviewCommentPrincipalHeaderV1;
}>;

export type ReviewCommentActionExecutor = (
    actionId: ReviewCommentActionIdV1,
    input: unknown,
    options?: ReviewCommentActionExecutionOptions,
) => Promise<unknown>;

export type CreatePluginReviewCommentsServiceParams = Readonly<{
    execute: ReviewCommentActionExecutor;
    principal?: ReviewCommentPrincipalHeaderV1;
    principalActor?: ReviewCommentActorRefV1;
    resolveSnapshot?: (
        request: PluginReviewCommentResolveSnapshotRequestV1,
        options?: Readonly<{ signal?: AbortSignal }>,
    ) => Promise<PluginReviewCommentResolveSnapshotResultV1> | PluginReviewCommentResolveSnapshotResultV1;
}>;

function withPrincipalOptions(
    principal: ReviewCommentPrincipalHeaderV1 | null,
    options: Readonly<{ signal?: AbortSignal }> | undefined,
): ReviewCommentActionExecutionOptions | undefined {
    if (!principal) {
        return options;
    }
    return {
        ...(options?.signal ? { signal: options.signal } : {}),
        principal,
    };
}

function resolvePrincipal(params: CreatePluginReviewCommentsServiceParams): ReviewCommentPrincipalHeaderV1 | null {
    if (params.principal) {
        return params.principal;
    }
    if (!params.principalActor) {
        return null;
    }
    return {
        actor: params.principalActor,
        grants: [],
    };
}

async function executeReviewCommentAction<TActionId extends ReviewCommentActionIdV1>(
    params: Readonly<{
        execute: ReviewCommentActionExecutor;
        actionId: TActionId;
        input: unknown;
        options?: ReviewCommentActionExecutionOptions;
    }>,
): Promise<unknown> {
    const input = ReviewCommentActionInputSchemasV1[params.actionId].parse(params.input);
    const output = await params.execute(params.actionId, input, params.options);
    return ReviewCommentActionOutputSchemasV1[params.actionId].parse(output);
}

export function createPluginReviewCommentsService(
    params: CreatePluginReviewCommentsServiceParams,
): PluginReviewCommentsServiceV1 {
    const principal = resolvePrincipal(params);
    const service: PluginReviewCommentsServiceV1 = {
        create: async (request, options) => await executeReviewCommentAction({
            execute: params.execute,
            actionId: 'reviews.comments.create',
            input: request,
            options: withPrincipalOptions(principal, options),
        }) as ReturnType<PluginReviewCommentsServiceV1['create']> extends Promise<infer TResult> ? TResult : never,
        list: async (request, options) => await executeReviewCommentAction({
            execute: params.execute,
            actionId: 'reviews.comments.list',
            input: request,
            options: withPrincipalOptions(principal, options),
        }) as ReturnType<PluginReviewCommentsServiceV1['list']> extends Promise<infer TResult> ? TResult : never,
        get: async (request, options) => await executeReviewCommentAction({
            execute: params.execute,
            actionId: 'reviews.comments.get',
            input: request,
            options: withPrincipalOptions(principal, options),
        }) as ReturnType<PluginReviewCommentsServiceV1['get']> extends Promise<infer TResult> ? TResult : never,
        transition: async (request, options) => await executeReviewCommentAction({
            execute: params.execute,
            actionId: 'reviews.comments.transition',
            input: request,
            options: withPrincipalOptions(principal, options),
        }) as ReturnType<PluginReviewCommentsServiceV1['transition']> extends Promise<infer TResult> ? TResult : never,
        edit: async (request, options) => await executeReviewCommentAction({
            execute: params.execute,
            actionId: 'reviews.comments.edit',
            input: request,
            options: withPrincipalOptions(principal, options),
        }) as ReturnType<PluginReviewCommentsServiceV1['edit']> extends Promise<infer TResult> ? TResult : never,
        reply: async (request, options) => await executeReviewCommentAction({
            execute: params.execute,
            actionId: 'reviews.comments.reply',
            input: request,
            options: withPrincipalOptions(principal, options),
        }) as ReturnType<PluginReviewCommentsServiceV1['reply']> extends Promise<infer TResult> ? TResult : never,
        redact: async (request, options) => await executeReviewCommentAction({
            execute: params.execute,
            actionId: 'reviews.comments.redact',
            input: request,
            options: withPrincipalOptions(principal, options),
        }) as ReturnType<PluginReviewCommentsServiceV1['redact']> extends Promise<infer TResult> ? TResult : never,
        setDisposition: async (request, options) => await executeReviewCommentAction({
            execute: params.execute,
            actionId: 'reviews.comments.setDisposition',
            input: request,
            options: withPrincipalOptions(principal, options),
        }) as ReturnType<PluginReviewCommentsServiceV1['setDisposition']> extends Promise<infer TResult> ? TResult : never,
        attachEvidence: async (request, options) => await executeReviewCommentAction({
            execute: params.execute,
            actionId: 'reviews.comments.attachEvidence',
            input: request,
            options: withPrincipalOptions(principal, options),
        }) as ReturnType<PluginReviewCommentsServiceV1['attachEvidence']> extends Promise<infer TResult> ? TResult : never,
        bulkTransition: async (request, options) => await executeReviewCommentAction({
            execute: params.execute,
            actionId: 'reviews.comments.bulkTransition',
            input: request,
            options: withPrincipalOptions(principal, options),
        }) as ReturnType<PluginReviewCommentsServiceV1['bulkTransition']> extends Promise<infer TResult> ? TResult : never,
        resolveSnapshot: async (request, options) => {
            if (!params.resolveSnapshot) return null;
            return await params.resolveSnapshot(request, options);
        },
    };
    return Object.freeze(service);
}
