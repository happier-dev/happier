import { getActionSpec } from '@happier-dev/protocol/actions';
import { buildReviewCommentPlainMutationTransportInputV1, type ReviewCommentResourceCryptoV1 } from '@happier-dev/protocol/reviews/comments/content';
import { buildReviewCommentPublicationTransportRequestV1, openReviewCommentPublicationTransportResponseV1 } from '@happier-dev/protocol/reviews/comments/publicationTransport';
import { executeReviewCommentTransportV1, type ReviewCommentTransportRequestV1 } from '@happier-dev/protocol/reviews/comments/transport';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import type { ReviewCommentActionIdV1, ReviewCommentBulkTransitionRequestV1, ReviewCommentClaimPublicationDispatchRequestV1 } from '@happier-dev/protocol/reviews/comments/actions';
import type { ReviewCommentAttachEvidenceRequestV1, ReviewCommentCreateRequestV1, ReviewCommentEditRequestV1, ReviewCommentRedactRequestV1, ReviewCommentReplyRequestV1, ReviewCommentSetDispositionRequestV1, ReviewCommentTransitionRequestV1 } from '@happier-dev/protocol/reviews/comments/v1';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { getRandomBytes } from '@/platform/cryptoRandom';
import { fetchAccountEncryptionMode, type AccountEncryptionReadUsage } from '@/sync/api/account/apiAccountEncryptionMode';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { serverFetch, type ServerFetch } from '@/sync/http/client';
import { parseToken } from '@/utils/auth/parseToken';

export type ReviewCommentUiActionExecutor = (
    actionId: ReviewCommentActionIdV1,
    input: unknown,
    options?: Readonly<{ signal?: AbortSignal }>,
) => Promise<unknown>;

export type CreateReviewCommentsHttpActionExecutorParams = Readonly<{
    request?: ServerFetch;
    resolveEventStorageContext?: (usage: AccountEncryptionReadUsage) => Promise<ReviewCommentEventStorageContext>;
    randomBytes?: (length: number) => Uint8Array;
    resolveReviewResourceContext?: (reviewId: string, signal?: AbortSignal) => Promise<Readonly<{
        accountId: string; resource: ReviewCommentResourceCryptoV1;
    }>>;
}>;

export type ReviewCommentEventStorageContext =
    | Readonly<{ accountId: string; mode: 'plain' }>
    | Readonly<{ accountId: string; mode: 'e2ee'; material?: AccountScopedCryptoMaterial }>;

async function resolveDefaultEventStorageContext(usage: AccountEncryptionReadUsage): Promise<ReviewCommentEventStorageContext> {
    const credentials = await TokenStorage.getCredentials();
    if (!credentials) {
        throw new Error('review_comment_credentials_unavailable');
    }
    const accountId = parseToken(credentials.token);
    const mode = (await fetchAccountEncryptionMode(credentials, { usage })).mode;
    if (mode === 'plain') return { accountId, mode };
    try {
        return {
            accountId,
            mode: 'e2ee',
            material: resolveAccountScopedCryptoMaterialFromCredentials(credentials),
        };
    } catch {
        throw new Error('review_comment_encryption_material_unavailable');
    }
}

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
    const code = typeof parsed.errorCode === 'string' ? parsed.errorCode
        : typeof parsed.error === 'string' ? parsed.error : null;
    const message = typeof parsed.message === 'string' ? parsed.message : null;
    throw Object.assign(new Error(code ?? message ?? 'review_comment_request_failed'), {
        code: code ?? 'review_comment_request_failed',
    });
}

async function requestReviewCommentJson(
    request: ServerFetch,
    path: string,
    init?: RequestInit,
): Promise<unknown> {
    const response = await request(path, init, { includeAuth: true });
    return await readReviewCommentJsonResponse(response);
}

function requestReviewCommentTransport(request: ServerFetch, transport: ReviewCommentTransportRequestV1, signal?: AbortSignal): Promise<unknown> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(transport.query ?? {})) appendQueryValue(search, key, value);
    const suffix = search.toString();
    return requestReviewCommentJson(request, suffix ? `${transport.path}?${suffix}` : transport.path,
        { ...(transport.body === undefined ? { method: transport.method.toUpperCase() } : withJsonBody(transport.body)),
            ...(signal ? { signal } : {}) });
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

async function sealReviewCommentMutationInput(params: Readonly<{
    actionId: Exclude<
        ReviewCommentActionIdV1,
        'reviews.comments.list' | 'reviews.comments.get' | 'reviews.comments.claimPublicationDispatch'
    >;
    input: Record<string, unknown>;
    context: Readonly<{ accountId: string; mode: 'plain' }>;
}>): Promise<Record<string, unknown>> {
    const context = params.context;
    const actor = { kind: 'user' as const, userId: context.accountId };
    return buildReviewCommentPlainMutationTransportInputV1({
        accountId: context.accountId,
        actor,
        actionId: params.actionId,
        input: params.input,
        mode: 'plain',
    });
}

export function createReviewCommentsHttpActionExecutor(
    params: CreateReviewCommentsHttpActionExecutorParams = {},
): ReviewCommentUiActionExecutor {
    const request = params.request ?? serverFetch;
    const resolveEventStorageContext = params.resolveEventStorageContext ?? resolveDefaultEventStorageContext;
    const randomBytes = params.randomBytes ?? getRandomBytes;
    const readResourceContext = async (reviewId: string, signal?: AbortSignal) => {
        if (!params.resolveReviewResourceContext) throw Object.assign(new Error('review_comment_encryption_material_unavailable'), {
            code: 'review_comment_encryption_material_unavailable',
        });
        const { accountId, resource } = await params.resolveReviewResourceContext(reviewId, signal);
        return { accountId, mode: resource.mode, material: null, resource };
    };
    return async (actionId, input, options) => {
        const logicalInput = parseReviewCommentInput<Record<string, unknown>>(actionId, input);
        if (actionId === 'reviews.comments.get' && typeof logicalInput.reviewId !== 'string') {
            return executeReviewCommentTransportV1({ actionId, input: logicalInput, randomBytes,
                resolveContext: async reviewId => {
                    if (reviewId) return readResourceContext(reviewId, options?.signal);
                    const storage = await resolveEventStorageContext('identity');
                    return { ...storage, material: storage.mode === 'plain' ? null : storage.material ?? null };
                },
                request: transport => {
                    options?.signal?.throwIfAborted();
                    return requestReviewCommentTransport(request, transport, options?.signal);
                },
            });
        }
        if (typeof logicalInput.reviewId === 'string' && actionId !== 'reviews.comments.claimPublicationDispatch') {
            const context = await readResourceContext(logicalInput.reviewId, options?.signal);
            return executeReviewCommentTransportV1({ actionId, input: logicalInput, context,
                actor: { kind: 'user', userId: context.accountId }, randomBytes,
                request: transport => requestReviewCommentTransport(request, transport, options?.signal),
            });
        }
        const storage = await resolveEventStorageContext('identity');
        const actionRequest: ServerFetch = async (path, init, requestOptions) => {
            const method = (init?.method ?? 'GET').toUpperCase();
            // Prepare carries structural data only. Admit private mutation and
            // publication bytes after their crypto, at the final request port.
            if (method !== 'GET' && method !== 'HEAD' && path !== '/v1/reviews/comments/mutations/prepare') {
                const current = await resolveEventStorageContext('fresh-authority');
                if (current.accountId !== storage.accountId || current.mode !== storage.mode) {
                    throw Object.assign(new Error('review_comment_encryption_mode_mismatch'), {
                        code: 'review_comment_encryption_mode_mismatch',
                    });
                }
            }
            options?.signal?.throwIfAborted();
            return request(path, options?.signal ? { ...init, signal: options.signal } : init, requestOptions);
        };
        const context = { ...storage, material: storage.mode === 'plain' ? null : storage.material ?? null };
        if (actionId === 'reviews.comments.claimPublicationDispatch') {
            const parsed = parseReviewCommentInput<ReviewCommentClaimPublicationDispatchRequestV1>(actionId, input);
            const transport = buildReviewCommentPublicationTransportRequestV1({ input: parsed, context, randomBytes });
            const output = await requestReviewCommentJson(
                actionRequest,
                '/v1/reviews/comments/publication/claim',
                withJsonBody(transport),
            );
            return openReviewCommentPublicationTransportResponseV1({ plan: parsed, context, response: output });
        }
        if (actionId === 'reviews.comments.list' || actionId === 'reviews.comments.get' || storage.mode === 'e2ee') {
            return executeReviewCommentTransportV1({
                actionId,
                input: parseReviewCommentInput<Record<string, unknown>>(actionId, input),
                context,
                actor: { kind: 'user', userId: storage.accountId },
                randomBytes,
                request: transport => requestReviewCommentTransport(actionRequest, transport),
            });
        }
        switch (actionId) {
            case 'reviews.comments.create': {
                const parsed = parseReviewCommentInput<ReviewCommentCreateRequestV1>(actionId, input);
                const sealed = await sealReviewCommentMutationInput({
                    actionId,
                    input: parsed,
                    context: storage,
                });
                const output = await requestReviewCommentJson(actionRequest, '/v1/reviews/comments', withJsonBody(sealed));
                return parseReviewCommentOutput(actionId, output);
            }
            case 'reviews.comments.edit': {
                const parsed = parseReviewCommentInput<ReviewCommentEditRequestV1>(actionId, input);
                const sealed = await sealReviewCommentMutationInput({ actionId, input: parsed, context: storage });
                const output = await requestReviewCommentJson(
                    actionRequest,
                    `/v1/reviews/comments/${encodeURIComponent(parsed.commentId)}`,
                    { ...withJsonBody(withoutField(sealed, 'commentId')), method: 'PATCH' },
                );
                return parseReviewCommentOutput(actionId, output);
            }
            case 'reviews.comments.transition': {
                const parsed = parseReviewCommentInput<ReviewCommentTransitionRequestV1>(actionId, input);
                const sealed = await sealReviewCommentMutationInput({ actionId, input: parsed, context: storage });
                const output = await requestReviewCommentJson(
                    actionRequest,
                    `/v1/reviews/comments/${encodeURIComponent(parsed.commentId)}/transition`,
                    withJsonBody(withoutField(sealed, 'commentId')),
                );
                return parseReviewCommentOutput(actionId, output);
            }
            case 'reviews.comments.reply': {
                const parsed = parseReviewCommentInput<ReviewCommentReplyRequestV1>(actionId, input);
                const sealed = await sealReviewCommentMutationInput({ actionId, input: parsed, context: storage });
                const output = await requestReviewCommentJson(
                    actionRequest,
                    `/v1/reviews/comments/${encodeURIComponent(parsed.parentCommentId)}/reply`,
                    withJsonBody(withoutField(sealed, 'parentCommentId')),
                );
                return parseReviewCommentOutput(actionId, output);
            }
            case 'reviews.comments.redact': {
                const parsed = parseReviewCommentInput<ReviewCommentRedactRequestV1>(actionId, input);
                const sealed = await sealReviewCommentMutationInput({ actionId, input: parsed, context: storage });
                const output = await requestReviewCommentJson(
                    actionRequest,
                    `/v1/reviews/comments/${encodeURIComponent(parsed.commentId)}/redact`,
                    withJsonBody(withoutField(sealed, 'commentId')),
                );
                return parseReviewCommentOutput(actionId, output);
            }
            case 'reviews.comments.setDisposition': {
                const parsed = parseReviewCommentInput<ReviewCommentSetDispositionRequestV1>(actionId, input);
                const sealed = await sealReviewCommentMutationInput({ actionId, input: parsed, context: storage });
                const output = await requestReviewCommentJson(
                    actionRequest,
                    `/v1/reviews/comments/${encodeURIComponent(parsed.commentId)}/disposition`,
                    withJsonBody(withoutField(sealed, 'commentId')),
                );
                return parseReviewCommentOutput(actionId, output);
            }
            case 'reviews.comments.attachEvidence': {
                const parsed = parseReviewCommentInput<ReviewCommentAttachEvidenceRequestV1>(actionId, input);
                const sealed = await sealReviewCommentMutationInput({ actionId, input: parsed, context: storage });
                const output = await requestReviewCommentJson(
                    actionRequest,
                    `/v1/reviews/comments/${encodeURIComponent(parsed.commentId)}/evidence`,
                    withJsonBody(withoutField(sealed, 'commentId')),
                );
                return parseReviewCommentOutput(actionId, output);
            }
            case 'reviews.comments.bulkTransition': {
                const parsed = parseReviewCommentInput<ReviewCommentBulkTransitionRequestV1>(actionId, input);
                const sealed = await sealReviewCommentMutationInput({ actionId, input: parsed, context: storage });
                const output = await requestReviewCommentJson(
                    actionRequest,
                    '/v1/reviews/comments/bulkTransition',
                    withJsonBody(sealed),
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
        options?: Parameters<ReviewCommentUiActionExecutor>[2];
    }>,
): Promise<unknown> {
    const input = parseReviewCommentInput<unknown>(params.actionId, params.input);
    const output = params.options
        ? await params.execute(params.actionId, input, params.options)
        : await params.execute(params.actionId, input);
    return parseReviewCommentOutput(params.actionId, output);
}
