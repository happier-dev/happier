import { getActionSpec } from '@happier-dev/protocol/actions';
import type {
    ReviewCommentActionIdV1,
    ReviewCommentAttachEvidenceRequestV1,
    ReviewCommentBulkTransitionRequestV1,
    ReviewCommentCreateRequestV1,
    ReviewCommentEditRequestV1,
    ReviewCommentGetRequestV1,
    ReviewCommentListRequestV1,
    ReviewCommentRedactRequestV1,
    ReviewCommentReplyRequestV1,
    ReviewCommentSetDispositionRequestV1,
    ReviewCommentTransitionRequestV1,
} from '@happier-dev/protocol';

import { serverFetch } from '@/sync/http/client';

export type ReviewCommentUiActionExecutor = (
    actionId: ReviewCommentActionIdV1,
    input: unknown,
) => Promise<unknown>;

export type CreateReviewCommentsHttpActionExecutorParams = Readonly<{
    request?: typeof serverFetch;
}>;

function appendQueryValue(query: URLSearchParams, key: string, value: unknown): void {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
        for (const item of value) {
            appendQueryValue(query, key, item);
        }
        return;
    }
    query.append(key, String(value));
}

function listPath(input: ReviewCommentListRequestV1): string {
    const query = new URLSearchParams();
    appendQueryValue(query, 'workspaceId', input.workspaceId);
    appendQueryValue(query, 'projectId', input.projectId);
    appendQueryValue(query, 'sessionId', input.sessionId);
    appendQueryValue(query, 'runId', input.runId);
    appendQueryValue(query, 'states', input.states);
    appendQueryValue(query, 'authorKind', input.authorKind);
    appendQueryValue(query, 'authorId', input.authorId);
    appendQueryValue(query, 'engineId', input.engineId);
    appendQueryValue(query, 'filePath', input.filePath);
    appendQueryValue(query, 'folderPath', input.folderPath);
    appendQueryValue(query, 'severity', input.severity);
    appendQueryValue(query, 'taxonomyIds', input.taxonomyIds);
    appendQueryValue(query, 'includeHistory', input.includeHistory);
    appendQueryValue(query, 'cursor', input.cursor);
    appendQueryValue(query, 'limit', input.limit);
    const suffix = query.toString();
    return suffix ? `/v1/reviews/comments?${suffix}` : '/v1/reviews/comments';
}

function withJsonBody(body: unknown): RequestInit {
    return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    };
}

function withoutField<TObject extends object, TKey extends keyof TObject>(
    input: TObject,
    key: TKey,
): Omit<TObject, TKey> {
    const { [key]: _omitted, ...rest } = input;
    return rest;
}

async function readReviewCommentJsonResponse(response: Response): Promise<unknown> {
    const payload = await response.json();
    if (response.ok) return payload;
    const parsed = typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : {};
    const code = typeof parsed.errorCode === 'string' ? parsed.errorCode : null;
    const message = typeof parsed.message === 'string' ? parsed.message : null;
    throw new Error(code ?? message ?? 'review_comment_request_failed');
}

async function requestReviewCommentJson(
    request: typeof serverFetch,
    path: string,
    init?: RequestInit,
): Promise<unknown> {
    const response = await request(path, init, { includeAuth: true });
    return await readReviewCommentJsonResponse(response);
}

function parseReviewCommentInput<TInput>(
    actionId: ReviewCommentActionIdV1,
    input: unknown,
): TInput {
    return getActionSpec(actionId).inputSchema.parse(input) as TInput;
}

function parseReviewCommentOutput(
    actionId: ReviewCommentActionIdV1,
    output: unknown,
): unknown {
    const outputSchema = getActionSpec(actionId).outputSchema;
    if (!outputSchema) {
        throw new Error('review_comment_output_schema_missing');
    }
    return outputSchema.parse(output);
}

export function createReviewCommentsHttpActionExecutor(
    params: CreateReviewCommentsHttpActionExecutorParams = {},
): ReviewCommentUiActionExecutor {
    const request = params.request ?? serverFetch;
    return async (actionId, input) => {
        switch (actionId) {
            case 'reviews.comments.list': {
                const parsed = parseReviewCommentInput<ReviewCommentListRequestV1>(actionId, input);
                const output = await requestReviewCommentJson(request, listPath(parsed), { method: 'GET' });
                return parseReviewCommentOutput(actionId, output);
            }
            case 'reviews.comments.get': {
                const parsed = parseReviewCommentInput<ReviewCommentGetRequestV1>(actionId, input);
                const query = new URLSearchParams({ includeHistory: String(parsed.includeHistory) });
                const output = await requestReviewCommentJson(
                    request,
                    `/v1/reviews/comments/${encodeURIComponent(parsed.commentId)}?${query.toString()}`,
                    { method: 'GET' },
                );
                return parseReviewCommentOutput(actionId, output);
            }
            case 'reviews.comments.create': {
                const parsed = parseReviewCommentInput<ReviewCommentCreateRequestV1>(actionId, input);
                const output = await requestReviewCommentJson(request, '/v1/reviews/comments', withJsonBody(parsed));
                return parseReviewCommentOutput(actionId, output);
            }
            case 'reviews.comments.edit': {
                const parsed = parseReviewCommentInput<ReviewCommentEditRequestV1>(actionId, input);
                const output = await requestReviewCommentJson(
                    request,
                    `/v1/reviews/comments/${encodeURIComponent(parsed.commentId)}`,
                    { ...withJsonBody(withoutField(parsed, 'commentId')), method: 'PATCH' },
                );
                return parseReviewCommentOutput(actionId, output);
            }
            case 'reviews.comments.transition': {
                const parsed = parseReviewCommentInput<ReviewCommentTransitionRequestV1>(actionId, input);
                const output = await requestReviewCommentJson(
                    request,
                    `/v1/reviews/comments/${encodeURIComponent(parsed.commentId)}/transition`,
                    withJsonBody(withoutField(parsed, 'commentId')),
                );
                return parseReviewCommentOutput(actionId, output);
            }
            case 'reviews.comments.reply': {
                const parsed = parseReviewCommentInput<ReviewCommentReplyRequestV1>(actionId, input);
                const output = await requestReviewCommentJson(
                    request,
                    `/v1/reviews/comments/${encodeURIComponent(parsed.parentCommentId)}/reply`,
                    withJsonBody(withoutField(parsed, 'parentCommentId')),
                );
                return parseReviewCommentOutput(actionId, output);
            }
            case 'reviews.comments.redact': {
                const parsed = parseReviewCommentInput<ReviewCommentRedactRequestV1>(actionId, input);
                const output = await requestReviewCommentJson(
                    request,
                    `/v1/reviews/comments/${encodeURIComponent(parsed.commentId)}/redact`,
                    withJsonBody(withoutField(parsed, 'commentId')),
                );
                return parseReviewCommentOutput(actionId, output);
            }
            case 'reviews.comments.setDisposition': {
                const parsed = parseReviewCommentInput<ReviewCommentSetDispositionRequestV1>(actionId, input);
                const output = await requestReviewCommentJson(
                    request,
                    `/v1/reviews/comments/${encodeURIComponent(parsed.commentId)}/disposition`,
                    withJsonBody(withoutField(parsed, 'commentId')),
                );
                return parseReviewCommentOutput(actionId, output);
            }
            case 'reviews.comments.attachEvidence': {
                const parsed = parseReviewCommentInput<ReviewCommentAttachEvidenceRequestV1>(actionId, input);
                const output = await requestReviewCommentJson(
                    request,
                    `/v1/reviews/comments/${encodeURIComponent(parsed.commentId)}/evidence`,
                    withJsonBody(withoutField(parsed, 'commentId')),
                );
                return parseReviewCommentOutput(actionId, output);
            }
            case 'reviews.comments.bulkTransition': {
                const parsed = parseReviewCommentInput<ReviewCommentBulkTransitionRequestV1>(actionId, input);
                const output = await requestReviewCommentJson(
                    request,
                    '/v1/reviews/comments/bulkTransition',
                    withJsonBody(parsed),
                );
                return parseReviewCommentOutput(actionId, output);
            }
        }
    };
}

export async function executeReviewCommentProtocolAction<TActionId extends ReviewCommentActionIdV1>(
    params: Readonly<{
        execute: ReviewCommentUiActionExecutor;
        actionId: TActionId;
        input: unknown;
    }>,
): Promise<unknown> {
    const input = parseReviewCommentInput<unknown>(params.actionId, params.input);
    const output = await params.execute(params.actionId, input);
    return parseReviewCommentOutput(params.actionId, output);
}
