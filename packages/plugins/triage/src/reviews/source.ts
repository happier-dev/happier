import { isPluginActionApprovalRequestCreated, type PluginActionResultById } from '@happier-dev/plugin-sdk/actions';
import {
    MAX_TRIAGE_LIST_WINDOW_ROWS_V1, reviewTriageLocalRefV1,
    type TriageGetInputV1, type TriageGetResultV1, type TriageReadAttentionInputV1,
    type TriageReadAttentionResultV1, type TriageScanInputV1, type TriageScanResultV1,
} from '@happier-dev/triage-protocol/v1';
import type { TriageDataActionContext } from '../actions/dataContext.js';

type Context = Pick<TriageDataActionContext, 'signal'> & { services: Pick<TriageDataActionContext['services'], 'actions'> };
type Review = PluginActionResultById['reviews.list']['items'][number];
type Facts = Review['needsYou'];
const unavailable = { class: 'transient', code: 'review_unavailable' } as const;

export const REVIEW_DRAFT_V1 = { v: 1, keyStability: 'stable', binding: { purpose: 'reviews', source: 'accountData' },
    localInstanceKey: 'reviews', configuration: { v: 1, token: 'happier-reviews-v1' }, locator: { v: 1, displayLabel: 'Reviews' } } as const;
export const REVIEW_ACCOUNT_DATA_INSTANCE_V1 = { sourceInstanceId: 'f2494c84-85b6-4c0c-a99a-9a36765ed07e',
    configurationRowId: 'happier-reviews', draft: REVIEW_DRAFT_V1 } as const;

async function title(reviewId: string, context: Context): Promise<string> {
    // artifact.get is the recipient's existing local opener; ciphertext is never
    // copied into a server-readable attention projection.
    const result = await context.services.actions.execute('artifact.get', { artifactId: reviewId }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(result)) throw new Error('Review title unavailable');
    if (result.artifact === null) throw new Error('Review title unavailable');
    const value = result.artifact.header.title;
    return typeof value === 'string' && value.trim() ? value : 'Review';
}
async function attention(facts: Facts, subjectKind: Review['subjectKind'], context: Context): Promise<Extract<TriageReadAttentionResultV1, { kind: 'page' }>['items'][number]> {
    return { localRef: reviewTriageLocalRefV1(facts.reviewId), reason: facts.reason, type: 'decision',
        title: await title(facts.reviewId, context), resolved: !facts.needsYou,
        reviewAttention: { requestedVerdict: facts.requestedVerdict, subjectKind } };
}

/** The Review owner already intersected request eligibility with Artifact access. */
export async function readOneReviewAttentionV1(reviewId: string, context: Context) {
    const result = await context.services.actions.execute('review.get', { reviewId }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(result)) throw new Error('Review unavailable');
    return attention(result.human.needsYou, result.review.subjectKind, context);
}

/** Finite pages reconnect through the existing lifecycle; no Review polling. */
export async function readReviewAttentionV1(input: TriageReadAttentionInputV1, context: Context): Promise<TriageReadAttentionResultV1> {
    const result = await context.services.actions.execute('reviews.list', { limit: MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
        ...(input.cursor ? { cursor: input.cursor.token } : {}) }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(result)) return { kind: 'failed', failure: unavailable };
    return { kind: 'page', items: await Promise.all(result.items.map(review => attention(review.needsYou, review.subjectKind, context))),
        nextPage: result.cursor !== null, ...(result.cursor === null ? {} : { cursor: { v: 1, token: result.cursor } }) };
}

async function observation(review: Omit<Review, 'needsYou'>, facts: Facts, context: Context): Promise<Extract<TriageGetResultV1, { kind: 'present' }>> {
    return { kind: 'present', localRef: reviewTriageLocalRefV1(review.reviewId),
        locator: { v: 1, displayPath: review.reviewId, routingToken: review.reviewId },
        snapshot: { v: 1, title: await title(review.reviewId, context), scopeLabel: 'Reviews', facts: [],
            state: { presentation: facts.needsYou ? 'active' : 'resolved', nativeLabel: facts.needsYou ? 'Needs you' : 'Reviewed' },
            createdAtMs: review.createdAt },
        viewer: { involvement: [], sourceAttention: facts.needsYou
            ? { level: 'required', reasonId: facts.reason, reasonLabel: 'Review needs you' } : { level: 'none' } }, sourceUpdatedAtMs: review.updatedAt };
}
export async function getReviewV1(input: TriageGetInputV1, context: Context): Promise<TriageGetResultV1> {
    const result = await context.services.actions.execute('review.get', { reviewId: input.localRef.entryId }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(result)) return { kind: 'unresolved', localRef: input.localRef, failure: unavailable };
    return observation(result.review, result.human.needsYou, context);
}
export async function scanReviewsV1(input: TriageScanInputV1, context: Context): Promise<TriageScanResultV1> {
    const result = await context.services.actions.execute('reviews.list', { limit: input.page.kind === 'initial' ? input.page.limit : MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
        ...(input.page.kind === 'continuation' ? { cursor: input.page.continuation.token } : {}) }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(result)) return { kind: 'failed', failure: unavailable };
    const observations = await Promise.all(result.items.map(review => observation(review, review.needsYou, context)));
    return result.cursor === null ? { kind: 'complete', observations, evidence: { kind: 'walkFinished' } }
        : { kind: 'page', observations, continuation: { v: 1, token: result.cursor }, evidence: { kind: 'partial', reason: 'pageLimit' } };
}
