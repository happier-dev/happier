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

async function readTitles(reviewIds: readonly string[], context: Context): Promise<ReadonlyMap<string, string>> {
    if (reviewIds.length === 0) return new Map();
    // Only the recipient opens sealed titles; a page needs one selected header
    // batch, while the Review document remains unopened until explicit demand.
    const result = await context.services.actions.execute('artifact.list', { artifactIds: [...reviewIds] }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(result)) throw new Error('Review title unavailable');
    return new Map(result.items.map(artifact => {
        const value = artifact.header.title;
        return [artifact.artifactId, typeof value === 'string' && value.trim() ? value : 'Review'] as const;
    }));
}
function title(reviewId: string, titles: ReadonlyMap<string, string>): string {
    const value = titles.get(reviewId);
    if (value === undefined) throw new Error('Review title unavailable');
    return value;
}
function attention(facts: Facts, subjectKind: Review['subjectKind'], titles: ReadonlyMap<string, string>): Extract<TriageReadAttentionResultV1, { kind: 'page' }>['items'][number] {
    return { localRef: reviewTriageLocalRefV1(facts.reviewId), reason: facts.reason, type: 'decision',
        title: title(facts.reviewId, titles), resolved: !facts.needsYou,
        // For active attention, a request takes precedence. Without one, a finding needs a decision.
        ...(facts.needsYou ? { reviewAttention: { requestedVerdict: facts.requestedVerdict, subjectKind } } : {}) };
}

/** The Review owner already intersected request eligibility with Artifact access. */
export async function readOneReviewAttentionV1(reviewId: string, context: Context) {
    const result = await context.services.actions.execute('review.get', { reviewId }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(result)) throw new Error('Review unavailable');
    return attention(result.human.needsYou, result.review.subjectKind, await readTitles([reviewId], context));
}

/** Finite pages reconnect through the existing lifecycle; no Review polling. */
export async function readReviewAttentionV1(input: TriageReadAttentionInputV1, context: Context): Promise<TriageReadAttentionResultV1> {
    const result = await context.services.actions.execute('reviews.list', { limit: MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
        ...(input.cursor ? { cursor: input.cursor.token } : {}) }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(result)) return { kind: 'failed', failure: unavailable };
    const titles = await readTitles(result.items.map(review => review.reviewId), context);
    return { kind: 'page', items: result.items.map(review => attention(review.needsYou, review.subjectKind, titles)),
        nextPage: result.cursor !== null, ...(result.cursor === null ? {} : { cursor: { v: 1, token: result.cursor } }) };
}

/**
 * The same Review fact as the Inbox byline: a request is the reader's requested review (said by Triage's one
 * involvement reason, as for every source); without one, a pending finding needs their decision.
 */
function viewer(facts: Facts): Extract<TriageGetResultV1, { kind: 'present' }>['viewer'] {
    if (facts.needsYou && facts.requestedVerdict) return { involvement: ['reviewRequested'] };
    return { involvement: [], sourceAttention: facts.needsYou
        ? { level: 'required', reasonId: facts.reason, reasonLabel: 'Needs your decision' } : { level: 'none' } };
}
function observation(review: Omit<Review, 'needsYou'>, facts: Facts, titles: ReadonlyMap<string, string>): Extract<TriageGetResultV1, { kind: 'present' }> {
    return { kind: 'present', localRef: reviewTriageLocalRefV1(review.reviewId),
        // The place is the Reviews list itself; the id only routes (a raw id is never a place).
        locator: { v: 1, displayPath: 'Reviews', routingToken: review.reviewId },
        snapshot: { v: 1, title: title(review.reviewId, titles), scopeLabel: 'Reviews', facts: [],
            state: { presentation: facts.needsYou ? 'active' : 'resolved', nativeLabel: facts.needsYou ? 'Needs you' : 'Reviewed' },
            createdAtMs: review.createdAt },
        viewer: viewer(facts), sourceUpdatedAtMs: review.updatedAt };
}
export async function getReviewV1(input: TriageGetInputV1, context: Context): Promise<TriageGetResultV1> {
    const result = await context.services.actions.execute('review.get', { reviewId: input.localRef.entryId }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(result)) return { kind: 'unresolved', localRef: input.localRef, failure: unavailable };
    return observation(result.review, result.human.needsYou, await readTitles([result.review.reviewId], context));
}
export async function scanReviewsV1(input: TriageScanInputV1, context: Context): Promise<TriageScanResultV1> {
    const result = await context.services.actions.execute('reviews.list', { limit: input.page.kind === 'initial' ? input.page.limit : MAX_TRIAGE_LIST_WINDOW_ROWS_V1,
        ...(input.page.kind === 'continuation' ? { cursor: input.page.continuation.token } : {}) }, { signal: context.signal });
    if (isPluginActionApprovalRequestCreated(result)) return { kind: 'failed', failure: unavailable };
    const titles = await readTitles(result.items.map(review => review.reviewId), context);
    const observations = result.items.map(review => observation(review, review.needsYou, titles));
    return result.cursor === null ? { kind: 'complete', observations, evidence: { kind: 'walkFinished' } }
        : { kind: 'page', observations, continuation: { v: 1, token: result.cursor }, evidence: { kind: 'partial', reason: 'pageLimit' } };
}
