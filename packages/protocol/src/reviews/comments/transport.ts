import { parse as parseClassic } from 'zod';
import * as z from 'zod/mini';
import { deriveReviewCommentMutationCommitmentV1, type AccountScopedCryptoMaterial } from '../../crypto/accountScopedCipher.js';
import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import { ReviewCommentActionInputSchemasV1, ReviewCommentActionOutputSchemasV1, stringifyReviewCommentPrincipalCanonicalJsonV1, type ReviewCommentActionIdV1, } from './actions.js';
import { buildReviewCommentMutationEventEnvelopeV1, openReviewCommentSensitiveMigrationSourceV1, reviewCommentMutationInputWithoutEventEnvelopeV1, sealReviewCommentSensitiveEnvelopeV1, StoredReviewCommentV1Schema, type ReviewCommentMutationActionIdV1, } from './content.js';
import { applyReviewCommentPreparedSensitiveMutationV1, projectReviewCommentStructuralMutationV1, ReviewCommentPrepareMutationRequestV1Schema, ReviewCommentPrepareMutationResponseV1Schema, ReviewCommentCommitMutationRequestV1Schema, ReviewCommentCommitMutationResponseV1Schema, ReviewCommentStoredSourceV1Schema, type ReviewCommentStoredSourceV1, } from './mutation.js';
import { canonicalReviewCommentListFilters, matchesReviewCommentListFilters } from './queries.js';
import type { ReviewCommentActorRefV1, ReviewCommentV1 } from './v1.js';
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
}>;
function fail(code: string): never { throw Object.assign(new Error(code), { code }); }
function assertContext(context: ReviewCommentTransportContextV1) {
    if (context.mode === 'e2ee' && !context.material)
        fail('review_comment_encryption_material_unavailable');
    if (context.mode === 'plain' && context.material)
        fail('review_comment_encryption_mode_mismatch');
}
const sourceSchema = z.union([ReviewCommentStoredSourceV1Schema, StoredReviewCommentV1Schema]);
function source(value: unknown): ReviewCommentStoredSourceV1 {
    const parsed = parseClassic(sourceSchema, value);
    return 'source' in parsed ? parsed : { structural: parsed.structural,
        source: { v: 1, layout: 'canonical_v1', envelope: parsed.sensitiveEnvelope } };
}
async function open(value: unknown, context: ReviewCommentTransportContextV1): Promise<ReviewCommentV1> {
    const record = source(value);
    if (record.structural.accountId !== context.accountId)
        fail('review_comment_content_binding_mismatch');
    const mode = record.source.layout === 'canonical_v1'
        ? record.source.envelope.t === 'plain' ? 'plain' : 'e2ee' : record.source.sourceMode;
    if (mode !== context.mode)
        fail('review_comment_encryption_mode_mismatch');
    const result = await openReviewCommentSensitiveMigrationSourceV1({ ...record,
        ...(context.material ? { material: context.material } : {}) });
    if (result.status !== 'available')
        fail(`review_comment_${result.reason}`);
    return result.comment;
}
function digest(context: ReviewCommentTransportContextV1, purpose: 'effect' | 'create-equivalence' | 'list-filters', value: unknown) {
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
    actionId: Exclude<ReviewCommentActionIdV1, 'reviews.comments.claimPublicationDispatch'>;
    input: Record<string, unknown>;
    context: ReviewCommentTransportContextV1;
    actor: ReviewCommentActorRefV1;
    request: (request: ReviewCommentTransportRequestV1) => Promise<unknown>;
    randomBytes: (length: number) => Uint8Array;
}>): Promise<unknown> {
    assertContext(params.context);
    const input = ReviewCommentActionInputSchemasV1[params.actionId].parse(params.input);
    if (params.actionId === 'reviews.comments.get') {
        const parsed = ReviewCommentActionInputSchemasV1['reviews.comments.get'].parse(input);
        const result = parseClassic(z.strictObject({ comment: sourceSchema }), await params.request({ method: 'get',
            path: `/v1/reviews/comments/${encodeURIComponent(parsed.commentId)}`, query: { stored: true, includeHistory: parsed.includeHistory } }));
        const comment = await open(result.comment, params.context);
        if (comment.id !== parsed.commentId)
            fail('review_comment_content_binding_mismatch');
        return ReviewCommentActionOutputSchemasV1[params.actionId].parse({ comment });
    }
    if (params.actionId === 'reviews.comments.list') {
        const parsed = ReviewCommentActionInputSchemasV1['reviews.comments.list'].parse(input);
        const { allPages, filePath: _file, folderPath: _folder, severity: _severity, taxonomyIds: _taxonomy, cursor: _cursor, ...publicFilters } = parsed;
        const filterKey = digest(params.context, 'list-filters', canonicalReviewCommentListFilters(parsed));
        let serverCursor = decodeCursor(parsed.cursor, filterKey);
        const items: ReviewCommentV1[] = [];
        do {
            const page = parseClassic(z.strictObject({ items: z.array(sourceSchema), cursor: z.nullable(z.string().check(z.minLength(1))) }), await params.request({ method: 'get', path: '/v1/reviews/comments', query: {
                    ...publicFilters, limit: allPages ? parsed.limit : parsed.limit - items.length, stored: true,
                    ...(publicFilters.workspace ? { workspace: JSON.stringify(publicFilters.workspace) } : {}),
                    ...(serverCursor ? { cursor: serverCursor } : {}),
                } }));
            for (const record of page.items) {
                const comment = await open(record, params.context);
                if (matchesReviewCommentListFilters(comment, parsed))
                    items.push(comment);
            }
            if (page.cursor && page.cursor === serverCursor)
                fail('review_comment_invalid_filter');
            serverCursor = page.cursor ?? undefined;
        } while (serverCursor && (allPages || items.length < parsed.limit));
        return ReviewCommentActionOutputSchemasV1[params.actionId].parse({ items,
            cursor: serverCursor ? encodeCursor(filterKey, serverCursor) : null });
    }
    if (params.context.mode !== 'e2ee')
        fail('review_comment_encryption_mode_mismatch');
    const actionId: ReviewCommentMutationActionIdV1 = params.actionId;
    const logicalInput = reviewCommentMutationInputWithoutEventEnvelopeV1(params.input);
    const mutation = projectReviewCommentStructuralMutationV1(actionId, logicalInput);
    const contentCommitment = digest(params.context, 'effect', logicalInput);
    const request = ReviewCommentPrepareMutationRequestV1Schema.parse({ v: 1, mutation, contentCommitment,
        ...(actionId === 'reviews.comments.create' ? { createRequestFingerprint: buildReviewCommentCreateEquivalenceCommitmentV1({
                context: params.context, actor: params.actor, input: logicalInput
            }) } : {}) });
    const prepared = ReviewCommentPrepareMutationResponseV1Schema.parse(await params.request({ method: 'post',
        path: '/v1/reviews/comments/mutations/prepare', body: request, contentCommitment }));
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
        if (record.structural.accountId !== params.context.accountId
            || (!semanticReplay && record.structural.projectId !== mutation.input.projectId)
            || record.structural.workspace?.machineId !== mutation.input.workspace?.machineId
            || record.structural.workspace?.path !== mutation.input.workspace?.path)
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
        records.push({ commentId: record.structural.id,
            sensitiveEnvelope: sealReviewCommentSensitiveEnvelopeV1({ structural: record.structural, sensitive,
                mode: 'e2ee', material: params.context.material!, randomBytes: params.randomBytes }),
            eventEnvelope: buildReviewCommentMutationEventEnvelopeV1({ accountId: params.context.accountId,
                actor: params.actor, actionId, input: logicalInput, mode: 'e2ee', material: params.context.material!, randomBytes: params.randomBytes }),
        });
    }
    const commit = ReviewCommentCommitMutationRequestV1Schema.parse({ v: 1, receipt: prepared.receipt, records });
    const result = ReviewCommentCommitMutationResponseV1Schema.parse(await params.request({ method: 'post',
        path: '/v1/reviews/comments/mutations/commit', body: commit, contentCommitment }));
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
