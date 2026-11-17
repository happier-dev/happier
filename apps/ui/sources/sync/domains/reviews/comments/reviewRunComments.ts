import { buildReviewTriageTransitionRequestV1 } from '@happier-dev/protocol/reviews/comments/triageTransition';
import { REVIEW_COMMENT_LIST_PAGE_LIMIT_MAX_V1, type ReviewCommentListResponseV1, type ReviewCommentGetResponseV1, type ReviewCommentTransitionResponseV1 } from '@happier-dev/protocol/reviews/comments/actions';
import type { ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
import type { ReviewTriageStatus } from '@happier-dev/protocol/reviews/reviewTriageStatus';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { randomUUID } from '@/platform/randomUUID';
import { areServerAccountScopesEqual, serverAccountScopeKeySuffix, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';

import type { ReviewCommentUiActionExecutor } from './api';

/**
 * The durable `ReviewComment`s one review run materialized, shared by every surface that shows that
 * review (its transcript card, its run pane). A finding's decision lives only in its comment: this
 * module reads it with `reviews.comments.list` and writes it with `reviews.comments.transition`
 * (CAS), so a decision made in one place is the decision every other place shows.
 *
 * Every entry belongs to the exact Home and Account the review was opened under: reads and writes
 * go through the one Action front door bound to that Home with that Account expected, so a review
 * of another Home never reaches the focused one, and work captured under an Account that is no
 * longer the Home's is refused instead of sent as someone else.
 *
 * It is also where every confirmed ReviewComment write in the UI is announced
 * (`recordReviewCommentWrites`): the SCM review panel keeps its own list of the comments it shows,
 * and the two would otherwise drift apart until one of them reloads.
 */
export type ReviewRunCommentsTarget = Readonly<{
    scope: ServerAccountScope;
    sessionId: string;
    runId: string;
    reviewId?: string;
}>;

/** The materializer's typed comment reference supplies native Review identity; old runs remain unbound. */
export function reviewRunCommentsTargetFromFindings(payload: Readonly<{
    runRef: Readonly<{ runId: string }>;
    findings: readonly Readonly<{ comment?: Readonly<{ reviewId?: string }> }>[];
}>): Pick<ReviewRunCommentsTarget, 'runId' | 'reviewId'> {
    const reviewId = payload.findings.find(finding => finding.comment?.reviewId)?.comment?.reviewId;
    return { runId: payload.runRef.runId, ...(reviewId ? { reviewId } : {}) };
}

export type ReviewRunCommentsSnapshot = Readonly<{
    status: 'idle' | 'loading' | 'loaded' | 'failed';
    comments: readonly ReviewCommentV1[];
    /** Decisions sent but not yet confirmed, by comment id; shown the moment they are made. */
    pending: Readonly<Record<string, ReviewTriageStatus>>;
}>;

type Entry = {
    target: ReviewRunCommentsTarget;
    snapshot: ReviewRunCommentsSnapshot;
    inFlight: Promise<void> | null;
    /** Decisions for one comment are written one after another so each carries the latest revision. */
    writeChains: Map<string, Promise<void>>;
    listeners: Set<() => void>;
};

const EMPTY_SNAPSHOT: ReviewRunCommentsSnapshot = Object.freeze({ status: 'idle', comments: [], pending: {} });
const entries = new Map<string, Entry>();
const writeListeners = new Set<(comments: readonly ReviewCommentV1[], scope: ServerAccountScope) => void>();
let frontDoor: ReturnType<typeof createFrontDoorActionExecute> | null = null;

/** The review-comment Actions for one exact Home, refused unless that Home still signs in as the Account. */
function scopedExecutor(scope: ServerAccountScope): ReviewCommentUiActionExecutor {
    frontDoor ??= createFrontDoorActionExecute();
    const execute = frontDoor;
    return async (actionId, input, options) => {
        const result = await execute(actionId, input, {
            surface: 'ui',
            serverId: scope.serverId,
            expectedAccountId: scope.accountId,
            ...(options?.signal ? { signal: options.signal } : {}),
        });
        if (!result.ok) throw Object.assign(new Error(result.error), { code: result.errorCode });
        return result.result;
    };
}

function resolveExecutor(scope: ServerAccountScope, execute?: ReviewCommentUiActionExecutor): ReviewCommentUiActionExecutor {
    return execute ?? scopedExecutor(scope);
}

function keyOf(target: ReviewRunCommentsTarget): string {
    const resource = target.reviewId ? `review\u0000${target.reviewId}` : `session\u0000${target.sessionId}`;
    return `${serverAccountScopeKeySuffix(target.scope)}\u0000${resource}\u0000${target.runId}`;
}

function entryFor(target: ReviewRunCommentsTarget): Entry {
    const key = keyOf(target);
    let entry = entries.get(key);
    if (!entry) {
        entry = { target, snapshot: EMPTY_SNAPSHOT, inFlight: null, writeChains: new Map(), listeners: new Set() };
        entries.set(key, entry);
    }
    return entry;
}

function publish(entry: Entry, next: ReviewRunCommentsSnapshot): void {
    if (next === entry.snapshot) return;
    const previous = entry.snapshot;
    if (next.comments !== previous.comments) {
        const held = new Map(previous.comments.map(comment => [comment.id, comment]));
        const comments = next.comments.map(comment => {
            const current = held.get(comment.id);
            return current && sameStrictJsonValue(current, comment) ? current : comment;
        });
        next = { ...next, comments: comments.length === previous.comments.length
            && comments.every((comment, index) => comment === previous.comments[index]) ? previous.comments : comments };
    }
    if (next.pending !== previous.pending && sameStrictJsonValue(next.pending, previous.pending)) next = { ...next, pending: previous.pending };
    if (next.status === previous.status && next.comments === previous.comments && next.pending === previous.pending) return;
    entry.snapshot = next;
    for (const listener of entry.listeners) listener();
}

function upsert(entry: Entry, comment: ReviewCommentV1): void {
    const current = entry.snapshot.comments;
    const index = current.findIndex((item) => item.id === comment.id);
    if (index >= 0 && current[index] === comment) return;
    // An older echo never replaces a newer revision another surface already confirmed.
    if (index >= 0 && current[index]!.serverRevision > comment.serverRevision) return;
    const comments = index >= 0 ? current.map((item, i) => (i === index ? comment : item)) : [...current, comment];
    publish(entry, { ...entry.snapshot, comments });
}

/** Reconciles confirmed server revisions across loaded runs holding the same canonical comment. */
export function recordReviewCommentReads(comments: readonly ReviewCommentV1[], scope: ServerAccountScope): void {
    for (const comment of comments) {
        // A comment id is Home-local, even when both Homes sign in as the same Account.
        const holding: Entry[] = [];
        let latest = comment;
        for (const entry of entries.values()) {
            const { target } = entry;
            if (!areServerAccountScopesEqual(target.scope, scope) || entry.snapshot.status === 'idle') continue;
            if (target.reviewId ? target.reviewId !== comment.reviewId
                : comment.reviewId || target.sessionId !== comment.sessionId || target.scope.accountId !== comment.accountId) continue;
            if (target.runId !== comment.runId && !entry.snapshot.comments.some((held) => held.id === comment.id)) continue;
            holding.push(entry);
            const held = entry.snapshot.comments.find((item) => item.id === comment.id);
            if (held && held.serverRevision > latest.serverRevision) latest = held;
        }
        for (const entry of holding) upsert(entry, latest);
    }
}

/** Announces a confirmed write to loaded runs and other scoped comment surfaces. */
export function recordReviewCommentWrites(comments: readonly ReviewCommentV1[], scope: ServerAccountScope): void {
    if (comments.length === 0) return;
    recordReviewCommentReads(comments, scope);
    for (const listener of writeListeners) listener(comments, scope);
}

/** Every ReviewComment write any UI surface confirmed, so a surface keeping its own list can follow. */
export function subscribeReviewCommentWrites(scope: ServerAccountScope, listener: (comments: readonly ReviewCommentV1[]) => void): () => void {
    const scopedListener = (comments: readonly ReviewCommentV1[], writtenScope: ServerAccountScope) => {
        if (areServerAccountScopesEqual(scope, writtenScope)) listener(comments);
    };
    writeListeners.add(scopedListener);
    return () => {
        writeListeners.delete(scopedListener);
    };
}

function setPending(entry: Entry, commentId: string, decision: ReviewTriageStatus | null): void {
    const pending = { ...entry.snapshot.pending };
    if (decision) pending[commentId] = decision;
    else delete pending[commentId];
    publish(entry, { ...entry.snapshot, pending });
}

export function readReviewRunComments(target: ReviewRunCommentsTarget): ReviewRunCommentsSnapshot {
    return entries.get(keyOf(target))?.snapshot ?? EMPTY_SNAPSHOT;
}

export function subscribeReviewRunComments(target: ReviewRunCommentsTarget, listener: () => void): () => void {
    const entry = entryFor(target);
    entry.listeners.add(listener);
    return () => {
        entry.listeners.delete(listener);
    };
}

/**
 * Loads (or reloads) the run's comments. Concurrent callers share one request; the last known
 * comments stay visible while it runs.
 */
export function loadReviewRunComments(params: ReviewRunCommentsTarget & Readonly<{
    execute?: ReviewCommentUiActionExecutor;
    /** Materialization may reference a canonical comment first created by another review round. */
    commentIds?: readonly string[];
}>): Promise<void> {
    const entry = entryFor(params);
    if (entry.inFlight) return params.commentIds?.length
        ? entry.inFlight.then(() => ensureReviewRunComments(params))
        : entry.inFlight;
    const execute = resolveExecutor(params.scope, params.execute);
    const revisionsBeforeRead = new Map(entry.snapshot.comments.map((comment) => [comment.id, comment.serverRevision]));
    if (entry.snapshot.status === 'idle') publish(entry, { ...entry.snapshot, status: 'loading' });
    const run = (async () => {
        try {
            const comments: ReviewCommentV1[] = [];
            let cursor: string | undefined;
            do {
                const page = await execute('reviews.comments.list', {
                    ...(params.reviewId ? { reviewId: params.reviewId } : { sessionId: params.sessionId }),
                    runId: params.runId,
                    includeHistory: true,
                    // The card shows every finding of the run: read it in the fewest pages.
                    limit: REVIEW_COMMENT_LIST_PAGE_LIMIT_MAX_V1,
                    ...(cursor ? { cursor } : {}),
                }) as ReviewCommentListResponseV1;
                comments.push(...page.items);
                cursor = page.cursor ?? undefined;
            } while (cursor);
            // Native run lists are selected by canonical appearances, including reused earlier-round comments.
            // Only legacy unbound runs need their historical per-reference adapter.
            for (const commentId of new Set(params.reviewId ? [] : params.commentIds)) {
                if (comments.some((comment) => comment.id === commentId)) continue;
                const result = await execute('reviews.comments.get', { commentId, includeHistory: true }) as ReviewCommentGetResponseV1;
                if (result.comment.sessionId !== params.sessionId) throw new Error('review_comment_reference_scope_mismatch');
                comments.push(result.comment);
            }
            const latest = new Map(comments.map((comment) => [comment.id, comment]));
            for (const confirmed of entry.snapshot.comments) {
                const returned = latest.get(confirmed.id);
                if (returned ? confirmed.serverRevision > returned.serverRevision
                    : confirmed.serverRevision > (revisionsBeforeRead.get(confirmed.id) ?? 0)) {
                    latest.set(confirmed.id, confirmed);
                }
            }
            publish(entry, { ...entry.snapshot, status: 'loaded', comments: [...latest.values()] });
            // A canonical reference can be held by several reviewer runs. A confirmed read is
            // just as authoritative as a write response; no loaded copy may keep an older revision.
            recordReviewCommentReads(entry.snapshot.comments, params.scope);
        } catch (cause) {
            publish(entry, { ...entry.snapshot, status: entry.snapshot.status === 'loaded' ? 'loaded' : 'failed' });
            throw new Error('review_run_comments_unavailable', { cause });
        } finally {
            entry.inFlight = null;
        }
    })();
    entry.inFlight = run;
    return run;
}

/** Loads the run's comments unless they are already loaded or loading. */
export function ensureReviewRunComments(params: ReviewRunCommentsTarget & Readonly<{
    execute?: ReviewCommentUiActionExecutor;
    commentIds?: readonly string[];
}>): Promise<void> {
    const entry = entryFor(params);
    if (entry.inFlight) return loadReviewRunComments(params);
    if (entry.snapshot.status === 'loaded' && !params.commentIds?.some((id) => !entry.snapshot.comments.some((comment) => comment.id === id))) return Promise.resolve();
    return loadReviewRunComments(params);
}

/**
 * Records a finding's decision on its comment. Resolves `true` once the server confirms it; on a
 * conflict or failure the comments are reloaded (so the latest decision shows) and it resolves
 * `false`.
 */
export function decideReviewRunFinding(params: ReviewRunCommentsTarget & Readonly<{
    commentId: string;
    decision: ReviewTriageStatus;
    execute?: ReviewCommentUiActionExecutor;
}>): Promise<boolean> {
    const entry = entryFor(params);
    const execute = resolveExecutor(params.scope, params.execute);
    setPending(entry, params.commentId, params.decision);
    const previous = entry.writeChains.get(params.commentId) ?? Promise.resolve();
    let confirmed = false;
    const write = previous.then(async () => {
        const comment = entry.snapshot.comments.find((item) => item.id === params.commentId);
        try {
            if (!comment) throw new Error('review_comment_reference_unavailable');
            if (comment.reviewTriageStatus === params.decision) {
                confirmed = true;
                return;
            }
            const response = await execute('reviews.comments.transition', buildReviewTriageTransitionRequestV1({
                comment,
                decision: params.decision,
                clientMutationId: `review-finding-decision:${randomUUID()}`,
            })) as ReviewCommentTransitionResponseV1;
            upsert(entry, response.comment);
            recordReviewCommentWrites([response.comment], params.scope);
            confirmed = true;
        } catch {
            await loadReviewRunComments({ ...entry.target, execute }).catch(() => undefined);
        } finally {
            // A later decision for the same comment owns the pending value once it has been made.
            if (entry.snapshot.pending[params.commentId] === params.decision) setPending(entry, params.commentId, null);
        }
    });
    entry.writeChains.set(params.commentId, write);
    return write.then(() => confirmed);
}

/** Test seam: forget every run's comments. */
export function resetReviewRunCommentsForTests(): void {
    entries.clear();
    writeListeners.clear();
    frontDoor = null;
}
