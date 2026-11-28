import { parse as parseClassic } from '../../zodRuntimePolicy.js';
import { readActionErrorCodeV1 } from '../../actions/actionErrorClassV1.js';
import { ActionExecuteFailureSchema, parseActionExecuteFailure, type ActionExecuteFailure } from '../../actions/actionExecutionResult.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import * as z from '../../zodRuntimePolicy.js';
import { deriveReviewCommentMutationCommitmentV1, type AccountScopedCryptoMaterial } from '../../crypto/accountScopedCipher.js';
import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import { ReviewCommentActionInputSchemasV1, ReviewCommentActionOutputSchemasV1, stringifyReviewCommentPrincipalCanonicalJsonV1, type ReviewCommentActionIdV1, } from './actions.js';
import { buildReviewCommentMutationEventEnvelopeV1, openReviewCommentSensitiveEnvelopeV1, openReviewCommentSensitiveMigrationSourceV1, reviewCommentMutationInputWithoutEventEnvelopeV1, sealReviewCommentSensitiveEnvelopeV1, StoredReviewCommentV1Schema, type ReviewCommentMutationActionIdV1, type ReviewCommentResourceCryptoV1, } from './content.js';
import { applyReviewCommentPreparedSensitiveMutationV1, projectReviewCommentStructuralMutationV1, ReviewCommentPrepareMutationRequestV1Schema, ReviewCommentPrepareMutationResponseV1Schema, ReviewCommentCommitMutationRequestV1Schema, ReviewCommentCommitMutationResponseV1Schema, ReviewCommentStoredSourceV1Schema, type ReviewCommentStoredSourceV1, } from './mutation.js';
import { canonicalReviewCommentListFilters, matchesReviewCommentListFilters } from './queries.js';
import type { ReviewCommentActorRefV1, ReviewCommentCreateRequestV1, ReviewCommentV1 } from './v1.js';
import type { ReviewCommentPrincipalHeaderV1 } from './actions.js';
import { reviewCommentFindingScopeV1 } from './findingIdentity.js';
export type ReviewCommentTransportRequestV1 = Readonly<{
    method: 'get' | 'post';
    path: string;
    body?: Record<string, unknown>;
    query?: Record<string, unknown>;
    /** Host-signed current intent is rebound to this keyed effect commitment, never accepted from action input. */
    contentCommitment?: string;
}>;
export type ReviewCommentTransportContextV1 = Readonly<{
    accountId: string;
    mode: 'plain' | 'e2ee';
    material: AccountScopedCryptoMaterial | null;
    resource?: ReviewCommentResourceCryptoV1;
}>;
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function assertContext(context: ReviewCommentTransportContextV1) {
    if (context.resource) {
        if (context.material || context.mode !== context.resource.mode) fail('review_comment_encryption_mode_mismatch');
        return;
    }
    if (context.mode === 'e2ee' && !context.material)
        fail('review_comment_encryption_material_unavailable');
    if (context.mode === 'plain' && context.material)
        fail('review_comment_encryption_mode_mismatch');
}
function assertInputContext(context: ReviewCommentTransportContextV1, reviewId: string | undefined) {
    assertContext(context);
    if (context.resource ? reviewId !== context.resource.reviewId : reviewId !== undefined)
        fail('review_comment_content_binding_mismatch');
}
const sourceSchema = z.union([ReviewCommentStoredSourceV1Schema, StoredReviewCommentV1Schema]);
function source(value: unknown): ReviewCommentStoredSourceV1 {
    const parsed = parseClassic(sourceSchema, value);
    return 'source' in parsed ? parsed : { structural: parsed.structural,
        source: { v: 1, layout: 'canonical_v1', envelope: parsed.sensitiveEnvelope } };
}
async function open(value: unknown, context: ReviewCommentTransportContextV1): Promise<ReviewCommentV1> {
    const record = source(value);
    if (context.resource ? record.structural.reviewId !== context.resource.reviewId
        : record.structural.reviewId !== undefined || record.structural.accountId !== context.accountId)
        fail('review_comment_content_binding_mismatch');
    const mode = record.source.layout === 'canonical_v1'
        ? record.source.envelope.t === 'plain' ? 'plain' : 'e2ee' : record.source.sourceMode;
    if (mode !== context.mode)
        fail('review_comment_encryption_mode_mismatch');
    if (context.resource && record.source.layout !== 'canonical_v1') fail('review_comment_encryption_mode_mismatch');
    const result = context.resource && record.source.layout === 'canonical_v1'
        ? openReviewCommentSensitiveEnvelopeV1({ structural: record.structural,
            envelope: { t: 'plain', v: await context.resource.open(record.source.envelope) }, mode: 'plain' })
        : await openReviewCommentSensitiveMigrationSourceV1({ ...record,
            ...(context.material ? { material: context.material } : {}) });
    if (result.status !== 'available')
        fail(`review_comment_${result.reason}`);
    return result.comment;
}
function digest(context: ReviewCommentTransportContextV1, purpose: 'effect' | 'create-equivalence' | 'list-filters', value: unknown) {
    if (context.resource) return context.resource.commitment(purpose, stringifyReviewCommentPrincipalCanonicalJsonV1(value));
    return deriveReviewCommentMutationCommitmentV1({ ...context, purpose,
        components: [stringifyReviewCommentPrincipalCanonicalJsonV1(value)] });
}
function sameFindingScope(left: Parameters<typeof reviewCommentFindingScopeV1>[0], right: Parameters<typeof reviewCommentFindingScopeV1>[0]) {
    const scope = reviewCommentFindingScopeV1(left);
    return scope !== null && JSON.stringify(scope) === JSON.stringify(reviewCommentFindingScopeV1(right));
}
export function buildReviewCommentCreateEquivalenceCommitmentV1(params: Readonly<{
    context: ReviewCommentTransportContextV1;
    actor: ReviewCommentActorRefV1;
    input: Record<string, unknown>;
}>): string {
    const { clientMutationId: _mutation, eventEnvelope: _event, snapshot, authorIntent, ...rest } = params.input;
    const { capturedAt: _capture, ...stableSnapshot } = parseClassic(z.record(z.string(), z.unknown()), snapshot);
    return digest(params.context, 'create-equivalence', { ...rest, snapshot: stableSnapshot,
        authorIntent: authorIntent ?? 'propose', actor: params.actor, storageMode: params.context.mode });
}
const cursorSchema = z.strictObject({ v: z.literal(1), filters: z.string(), serverCursor: z.string().check(z.minLength(1)) });
function encodeCursor(filters: string, serverCursor: string) {
    return `rc1.${encodeBase64(new TextEncoder().encode(JSON.stringify({ v: 1, filters, serverCursor })), 'base64url')}`;
}
function decodeCursor(cursor: string | undefined, filters: string): string | undefined {
    if (!cursor)
        return undefined;
    if (!cursor.startsWith('rc1.'))
        return cursor; // Existing server cursors contain no private client filter identity.
    try {
        const parsed = parseClassic(cursorSchema, JSON.parse(new TextDecoder().decode(decodeBase64(cursor.slice(4), 'base64url'))));
        if (parsed.filters !== filters)
            fail('review_comment_invalid_filter');
        return parsed.serverCursor;
    }
    catch {
        fail('review_comment_invalid_filter');
    }
}
/** One client owner for canonical record opening, private-filter paging, and encrypted mutation sealing. */
export async function executeReviewCommentTransportV1(params: Readonly<{
    input: Record<string, unknown>;
    request: (request: ReviewCommentTransportRequestV1) => Promise<unknown>;
    randomBytes: (length: number) => Uint8Array;
}> & (Readonly<{
    actionId: Exclude<ReviewCommentActionIdV1, 'reviews.comments.claimPublicationDispatch'>;
    context: ReviewCommentTransportContextV1;
    actor: ReviewCommentActorRefV1;
}> | Readonly<{
    actionId: 'reviews.comments.get';
    /** Resolve an ID-only read from its authorized stored binding, before opening private content. */
    resolveContext: (reviewId: string | undefined) => Promise<ReviewCommentTransportContextV1>;
}> | Readonly<{
    actionId: 'reviews.comments.list';
    /** Resolve an ID-only read from its authorized stored binding, before opening private content. */
    resolveContext: (reviewId: string | undefined) => Promise<ReviewCommentTransportContextV1>;
}>)): Promise<unknown> {
    const input = ReviewCommentActionInputSchemasV1[params.actionId].parse(params.input);
    const reviewId = 'reviewId' in input ? input.reviewId : undefined;
    if (!('resolveContext' in params)) {
        assertInputContext(params.context, reviewId);
    }
    if (params.actionId === 'reviews.comments.get') {
        const parsed = ReviewCommentActionInputSchemasV1['reviews.comments.get'].parse(input);
        const result = parseClassic(z.strictObject({ comment: sourceSchema }), await params.request({ method: 'get',
            path: `/v1/reviews/comments/${encodeURIComponent(parsed.commentId)}`, query: { stored: true, includeHistory: parsed.includeHistory,
                ...(parsed.reviewId ? { reviewId: parsed.reviewId } : {}) } }));
        const context = 'resolveContext' in params
            ? await params.resolveContext(parsed.reviewId ?? result.comment.structural.reviewId) : params.context;
        if ('resolveContext' in params) {
            assertContext(context);
            if (parsed.reviewId !== undefined && context.resource?.reviewId !== parsed.reviewId)
                fail('review_comment_content_binding_mismatch');
        }
        const comment = await open(result.comment, context);
        if (comment.id !== parsed.commentId)
            fail('review_comment_content_binding_mismatch');
        return ReviewCommentActionOutputSchemasV1[params.actionId].parse({ comment });
    }
    if (params.actionId === 'reviews.comments.list') {
        const parsed = ReviewCommentActionInputSchemasV1['reviews.comments.list'].parse(input);
        const context = 'resolveContext' in params ? await params.resolveContext(parsed.reviewId) : params.context;
        if ('resolveContext' in params) assertInputContext(context, parsed.reviewId);
        const { allPages, filePath: _file, folderPath: _folder, severity: _severity, taxonomyIds: _taxonomy, cursor: _cursor, ...publicFilters } = parsed;
        const filterKey = digest(context, 'list-filters', canonicalReviewCommentListFilters(parsed));
        let serverCursor = decodeCursor(parsed.cursor, filterKey);
        const items: ReviewCommentV1[] = [];
        do {
            const page = parseClassic(z.strictObject({ items: z.array(sourceSchema), cursor: z.nullable(z.string().check(z.minLength(1))) }), await params.request({ method: 'get', path: '/v1/reviews/comments', query: {
                    ...publicFilters, limit: parsed.limit, stored: true,
                    ...(parsed.commentIds !== undefined ? { commentIds: JSON.stringify(parsed.commentIds) } : {}),
                    ...(publicFilters.workspace ? { workspace: JSON.stringify(publicFilters.workspace) } : {}),
                    ...(serverCursor ? { cursor: serverCursor } : {}),
                } }));
            for (const record of page.items) {
                const recordContext = 'resolveContext' in params
                    ? await params.resolveContext(parsed.reviewId ?? record.structural.reviewId) : context;
                if ('resolveContext' in params) assertInputContext(recordContext, parsed.reviewId ?? record.structural.reviewId);
                const comment = await open(record, recordContext);
                if (matchesReviewCommentListFilters(comment, parsed))
                    items.push(comment);
            }
            if (page.cursor && page.cursor === serverCursor)
                fail('review_comment_invalid_filter');
            serverCursor = page.cursor ?? undefined;
        // Private filters may leave a page empty. Only an explicit all-pages Action asks for more.
        } while (serverCursor && allPages);
        return ReviewCommentActionOutputSchemasV1[params.actionId].parse({ items,
            cursor: serverCursor ? encodeCursor(filterKey, serverCursor) : null });
    }
    if (params.context.mode !== 'e2ee' && !params.context.resource)
        fail('review_comment_encryption_mode_mismatch');
    const mutationParams: MutationParams = { ...params, actionId: params.actionId };
    const state = prepareMutation(mutationParams);
    const sealed = await sealPreparedMutation(mutationParams, state, await params.request({ method: 'post',
        path: '/v1/reviews/comments/mutations/prepare', body: state.request, contentCommitment: state.contentCommitment }));
    return openCommittedMutation(mutationParams, state, sealed, await params.request({ method: 'post',
        path: '/v1/reviews/comments/mutations/commit', body: sealed.commit, contentCommitment: state.contentCommitment }));
}

type MutationParams = Readonly<{
    actionId: ReviewCommentMutationActionIdV1;
    input: Record<string, unknown>;
    context: ReviewCommentTransportContextV1;
    actor: ReviewCommentActorRefV1;
    randomBytes: (length: number) => Uint8Array;
}>;
function prepareMutation(params: MutationParams) {
    const { actionId } = params;
    const logicalInput = reviewCommentMutationInputWithoutEventEnvelopeV1(params.input);
    const mutation = projectReviewCommentStructuralMutationV1(actionId, logicalInput);
    const contentCommitment = digest(params.context, 'effect', logicalInput);
    const request = ReviewCommentPrepareMutationRequestV1Schema.parse({ v: 1, mutation, contentCommitment,
        ...(actionId === 'reviews.comments.create' ? { createRequestFingerprint: buildReviewCommentCreateEquivalenceCommitmentV1({
                context: params.context, actor: params.actor, input: logicalInput
            }) } : {}) });
    return { actionId, logicalInput, mutation, contentCommitment, request };
}
async function sealPreparedMutation(params: MutationParams, state: ReturnType<typeof prepareMutation>, response: unknown) {
    const { actionId, logicalInput, mutation, request } = state;
    const prepared = ReviewCommentPrepareMutationResponseV1Schema.parse(response);
    if (stringifyReviewCommentPrincipalCanonicalJsonV1(prepared.request) !== stringifyReviewCommentPrincipalCanonicalJsonV1(request)) {
        fail('review_comment_content_binding_mismatch');
    }
    let parent: ReviewCommentV1 | undefined;
    const records = [];
    for (const record of prepared.records) {
        const semanticReplay = prepared.replayed && mutation.actionId === 'reviews.comments.create'
            && sameFindingScope(record.structural, { ...mutation.input,
                sessionId: params.actor.kind === 'workflow' && mutation.input.sessionId === undefined
                    ? record.structural.sessionId : mutation.input.sessionId });
        if ((params.context.resource ? record.structural.reviewId !== params.context.resource.reviewId
            : record.structural.reviewId !== undefined || record.structural.accountId !== params.context.accountId)
            || (!params.context.resource && ((!semanticReplay && record.structural.projectId !== mutation.input.projectId)
                || record.structural.workspace?.machineId !== mutation.input.workspace?.machineId
                || record.structural.workspace?.path !== mutation.input.workspace?.path)))
            fail('review_comment_content_binding_mismatch');
        const previous = record.previous ? await open(record.previous, params.context) : undefined;
        if (mutation.actionId !== 'reviews.comments.create') {
            const targetId = mutation.actionId === 'reviews.comments.reply' ? mutation.input.parentCommentId
                : mutation.actionId === 'reviews.comments.bulkTransition' ? record.structural.id : mutation.input.commentId;
            const revision = mutation.actionId === 'reviews.comments.reply' ? mutation.input.expectedParentServerRevision
                : mutation.actionId === 'reviews.comments.bulkTransition' ? mutation.input.expectedServerRevisions[targetId] : mutation.input.expectedServerRevision;
            if (!previous || previous.id !== targetId || previous.serverRevision !== revision
                || (mutation.actionId === 'reviews.comments.bulkTransition' && !mutation.input.commentIds.includes(targetId))
                || (mutation.actionId === 'reviews.comments.reply'
                    ? record.structural.parentCommentId !== previous.id || record.structural.threadId !== previous.threadId
                    : record.structural.id !== previous.id)
                || (mutation.actionId === 'reviews.comments.edit' && previous.bodyVersion !== mutation.input.expectedBodyVersion)
                || ((mutation.actionId === 'reviews.comments.transition' || mutation.actionId === 'reviews.comments.bulkTransition')
                    && previous.state !== mutation.input.expectedState))
                fail('review_comment_content_binding_mismatch');
        }
        if (actionId === 'reviews.comments.reply')
            parent = previous;
        if (!record.event)
            continue; // Equivalent-create replay uses the existing bound ciphertext, not a resealed event.
        const sensitive = applyReviewCommentPreparedSensitiveMutationV1({ mutation, input: logicalInput, prepared: record, previous });
        const resource = params.context.resource;
        const plainSensitive = resource ? sealReviewCommentSensitiveEnvelopeV1({ structural: record.structural, sensitive, mode: 'plain' }) : null;
        const plainEvent = resource ? buildReviewCommentMutationEventEnvelopeV1({ accountId: params.context.accountId,
            actor: params.actor, actionId, input: logicalInput, event: record.event, mode: 'plain' }) : null;
        records.push({ commentId: record.structural.id,
            sensitiveEnvelope: resource && plainSensitive?.t === 'plain' ? await resource.seal(plainSensitive.v)
                : sealReviewCommentSensitiveEnvelopeV1({ structural: record.structural, sensitive,
                    ...(params.context.mode === 'plain' ? { mode: 'plain' as const }
                        : { mode: 'e2ee' as const, material: params.context.material!, randomBytes: params.randomBytes }) }),
            eventEnvelope: resource && plainEvent?.t === 'plain' ? await resource.seal(plainEvent.v)
                : buildReviewCommentMutationEventEnvelopeV1({ accountId: params.context.accountId,
                    actor: params.actor, actionId, input: logicalInput,
                    ...(params.context.mode === 'plain' ? { mode: 'plain' as const }
                        : { mode: 'e2ee' as const, material: params.context.material!, randomBytes: params.randomBytes }) }),
        });
    }
    const commit = ReviewCommentCommitMutationRequestV1Schema.parse({ v: 1, receipt: prepared.receipt, records });
    return { prepared, commit, parent };
}
async function openCommittedMutation(params: MutationParams, state: ReturnType<typeof prepareMutation>,
    sealed: Awaited<ReturnType<typeof sealPreparedMutation>>, response: unknown) {
    const { actionId, mutation } = state;
    const { prepared, parent } = sealed;
    const result = ReviewCommentCommitMutationResponseV1Schema.parse(response);
    const createReplay = actionId === 'reviews.comments.create' && result.replayed;
    const returnedIds = new Set(result.comments.map((record) => record.structural.id));
    if (returnedIds.size !== result.comments.length)
        fail('review_comment_content_binding_mismatch');
    if (mutation.actionId === 'reviews.comments.bulkTransition') {
        const requestedIds = new Set(mutation.input.commentIds);
        const failedIds = new Set(result.failed.map((failure) => failure.commentId));
        if (failedIds.size !== result.failed.length || result.failed.some((failure) => !requestedIds.has(failure.commentId))
            || prepared.records.some((record) => !returnedIds.has(record.structural.id) && !failedIds.has(record.structural.id))) {
            fail('review_comment_content_binding_mismatch');
        }
    }
    else if (result.comments.length !== prepared.records.length)
        fail('review_comment_content_binding_mismatch');
    const comments = await Promise.all(result.comments.map(async (stored) => {
        const comment = await open(stored, params.context);
        if (createReplay) {
            const expected = prepared.records[0]?.structural;
            if (!expected || (!sameFindingScope(comment, expected) && (comment.projectId !== expected.projectId
                || comment.workspace?.machineId !== expected.workspace?.machineId || comment.workspace?.path !== expected.workspace?.path
                || comment.workspaceId !== expected.workspaceId || comment.sessionId !== expected.sessionId
                || comment.findingIdentity !== expected.findingIdentity)))
                fail('review_comment_content_binding_mismatch');
            return comment;
        }
        const expected = prepared.records.find((record) => record.structural.id === comment.id)?.structural;
        if (!expected || stringifyReviewCommentPrincipalCanonicalJsonV1(expected) !== stringifyReviewCommentPrincipalCanonicalJsonV1(stored.structural))
            fail('review_comment_content_binding_mismatch');
        return comment;
    }));
    const output = actionId === 'reviews.comments.bulkTransition'
        ? { updated: comments, failed: result.failed, bulkActionId: result.bulkActionId }
        : actionId === 'reviews.comments.reply' ? { comment: comments[0], parent }
            : { comment: comments[0], ...(actionId === 'reviews.comments.create' ? { replayed: result.replayed } : {}) };
    return ReviewCommentActionOutputSchemasV1[actionId].parse(output);
}

/** Batch envelopes carry the existing individually authorized mutation requests. */
export const ReviewCommentMutationBatchRequestV1Schema = z.strictObject({ items: z.array(z.strictObject({
    input: z.unknown(), principalHeader: z.optional(z.string()),
})) });
export const ReviewCommentPrepareMutationBatchResponseV1Schema = lazyZodSchema(() => z.strictObject({ items: z.array(z.union([
    z.strictObject({ ok: z.literal(true), value: ReviewCommentPrepareMutationResponseV1Schema }), ActionExecuteFailureSchema,
])) }));
export const ReviewCommentCommitMutationBatchResponseV1Schema = lazyZodSchema(() => z.strictObject({ items: z.array(z.union([
    z.strictObject({ ok: z.literal(true), value: ReviewCommentCommitMutationResponseV1Schema }), ActionExecuteFailureSchema,
])) }));
export type ReviewCommentCreateBatchTransportResultV1 = Readonly<
    { ok: true; comment: ReviewCommentV1; replayed: boolean }
    | (Pick<ActionExecuteFailure, 'ok' | 'errorCode'> & Partial<Omit<ActionExecuteFailure, 'ok' | 'errorCode'>>)
>;
export type ReviewCommentCreateBatchItemV1 = Readonly<{
    input: ReviewCommentCreateRequestV1;
    principal?: ReviewCommentPrincipalHeaderV1;
}>;
export type ReviewCommentCreateBatchExecutorV1 = (
    items: readonly ReviewCommentCreateBatchItemV1[],
    options?: Readonly<{ signal?: AbortSignal; serverId?: string | null }>,
) => Promise<readonly ReviewCommentCreateBatchTransportResultV1[]>;
function mutationFailure(error: unknown): ReviewCommentCreateBatchTransportResultV1 {
    return parseActionExecuteFailure(error)
        ?? { ok: false, errorCode: readActionErrorCodeV1(error) ?? 'review_comment_request_failed' };
}
export async function executeReviewCommentCreateBatchTransportV1(params: Readonly<{
    items: readonly Readonly<{ input: Record<string, unknown>; context: ReviewCommentTransportContextV1; actor: ReviewCommentActorRefV1 }>[];
    randomBytes: (length: number) => Uint8Array;
    request: (request: Readonly<{ path: string; items: readonly (ReviewCommentTransportRequestV1 & { itemIndex: number })[] }>) => Promise<unknown>;
}>): Promise<readonly ReviewCommentCreateBatchTransportResultV1[]> {
    const results: ReviewCommentCreateBatchTransportResultV1[] = [];
    const pending: Array<{ index: number; params: MutationParams; state: ReturnType<typeof prepareMutation> }> = [];
    for (const [index, item] of params.items.entries()) {
        try {
            const input = ReviewCommentActionInputSchemasV1['reviews.comments.create'].parse(item.input);
            assertInputContext(item.context, input.reviewId);
            const mutationParams = { ...item, input, actionId: 'reviews.comments.create' as const, randomBytes: params.randomBytes };
            pending.push({ index, params: mutationParams, state: prepareMutation(mutationParams) });
        } catch (error) { results[index] = mutationFailure(error); }
    }
    if (!pending.length) return results;
    const prepared = parseClassic(ReviewCommentPrepareMutationBatchResponseV1Schema, await params.request({
        path: '/v1/reviews/comments/mutations/prepareBatch', items: pending.map(({ state, index }) => ({ itemIndex: index, method: 'post',
            path: '/v1/reviews/comments/mutations/prepare', body: state.request, contentCommitment: state.contentCommitment })),
    }));
    if (prepared.items.length !== pending.length) fail('review_comment_content_binding_mismatch');
    const commits: Array<typeof pending[number] & { sealed: Awaited<ReturnType<typeof sealPreparedMutation>> }> = [];
    for (const [offset, item] of pending.entries()) {
        const response = prepared.items[offset]!;
        if (!response.ok) { results[item.index] = response; continue; }
        try { commits.push({ ...item, sealed: await sealPreparedMutation(item.params, item.state, response.value) }); }
        catch (error) { results[item.index] = mutationFailure(error); }
    }
    if (!commits.length) return results;
    const committed = parseClassic(ReviewCommentCommitMutationBatchResponseV1Schema, await params.request({
        path: '/v1/reviews/comments/mutations/commitBatch', items: commits.map(({ state, sealed, index }) => ({ itemIndex: index, method: 'post',
            path: '/v1/reviews/comments/mutations/commit', body: sealed.commit, contentCommitment: state.contentCommitment })),
    }));
    if (committed.items.length !== commits.length) fail('review_comment_content_binding_mismatch');
    for (const [offset, item] of commits.entries()) {
        const response = committed.items[offset]!;
        if (!response.ok) { results[item.index] = response; continue; }
        try {
            const output = ReviewCommentActionOutputSchemasV1['reviews.comments.create'].parse(
                await openCommittedMutation(item.params, item.state, item.sealed, response.value));
            results[item.index] = { ok: true, comment: output.comment, replayed: output.replayed ?? false };
        } catch (error) { results[item.index] = mutationFailure(error); }
    }
    return results;
}
