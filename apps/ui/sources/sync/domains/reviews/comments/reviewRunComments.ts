import { buildReviewTriageTransitionRequestV1 } from '@happier-dev/protocol/reviews/comments/triageTransition';
import { REVIEW_COMMENT_LIST_PAGE_LIMIT_MAX_V1, type ReviewCommentListResponseV1, type ReviewCommentGetResponseV1, type ReviewCommentTransitionResponseV1 } from '@happier-dev/protocol/reviews/comments/actions';
import type { ReviewCommentScopeV1, ReviewCommentV1 } from '@happier-dev/protocol/reviews/comments/v1';
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
 * SCM panels, native Reviews and retained run adapters consume these same windows and confirmed
 * writes. Different selectors can hold the same comment; its revision and pending decision agree.
 */
export type ReviewRunCommentsTarget = Readonly<{
    scope: ServerAccountScope;
    reviewId?: string;
    sessionId?: string;
    runId?: string;
    projectId?: string;
    workspace?: ReviewCommentScopeV1['workspace'];
    workspaceId?: string;
} & ({ reviewId: string } | { sessionId: string } | { projectId: string }
    | { workspace: NonNullable<ReviewCommentScopeV1['workspace']> } | { workspaceId: string })>;

/** The materializer's typed comment reference supplies native Review identity; old runs remain unbound. */
export function reviewRunCommentsTargetFromFindings(payload: Readonly<{
    runRef: Readonly<{ runId: string }>;
    findings: readonly Readonly<{ comment?: Readonly<{ reviewId?: string }> }>[];
}>): Readonly<{ runId: string; reviewId?: string }> {
    const reviewId = payload.findings.find(finding => finding.comment?.reviewId)?.comment?.reviewId;
    return { runId: payload.runRef.runId, ...(reviewId ? { reviewId } : {}) };
}

export type ReviewRunCommentsSnapshot = Readonly<{
    status: 'idle' | 'loading' | 'loaded' | 'failed';
    comments: readonly ReviewCommentV1[];
    cursor: string | null;
    loadingMore: boolean;
    loadMoreFailed: boolean;
    /** Decisions sent but not yet confirmed, by comment id; shown the moment they are made. */
    pending: Readonly<Record<string, ReviewTriageStatus>>;
}>;

type Entry = {
    target: ReviewRunCommentsTarget;
    snapshot: ReviewRunCommentsSnapshot;
    inFlight: Promise<void> | null;
    controller: AbortController | null;
    listeners: Set<() => void>;
};
type CommentWriteChain = { write: Promise<void>; pending: ReviewTriageStatus | undefined };

export const EMPTY_REVIEW_RUN_COMMENTS_SNAPSHOT: ReviewRunCommentsSnapshot = Object.freeze({ status: 'idle', comments: [], pending: {}, cursor: null, loadingMore: false, loadMoreFailed: false });
const entries = new Map<string, Entry>();
/** One write chain per canonical comment, even when different selectors hold it. */
const writeChains = new Map<string, CommentWriteChain>();
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

export function resolveReviewCommentExecutor(scope: ServerAccountScope, execute?: ReviewCommentUiActionExecutor): ReviewCommentUiActionExecutor {
    return execute ?? scopedExecutor(scope);
}

function queryOf(target: ReviewRunCommentsTarget) {
    return {
        ...(target.reviewId ? { reviewId: target.reviewId } : target.sessionId ? { sessionId: target.sessionId }
            : target.workspace ? { workspace: target.workspace } : { projectId: target.projectId, workspaceId: target.workspaceId }),
        ...(target.runId ? { runId: target.runId } : {}),
    };
}

function keyOf(target: ReviewRunCommentsTarget): string {
    return `${serverAccountScopeKeySuffix(target.scope)}\u0000${JSON.stringify(queryOf(target))}`;
}

function entryFor(target: ReviewRunCommentsTarget): Entry {
    const key = keyOf(target);
    let entry = entries.get(key);
    if (!entry) {
        entry = { target, snapshot: EMPTY_REVIEW_RUN_COMMENTS_SNAPSHOT, inFlight: null, controller: null, listeners: new Set() };
        entries.set(key, entry);
    }
    return entry;
}

function commentWriteKey(scope: ServerAccountScope, commentId: string): string {
    return `${serverAccountScopeKeySuffix(scope)}\u0000${commentId}`;
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
        const pending: Record<string, ReviewTriageStatus> = {};
        for (const comment of next.comments) {
            const decision = writeChains.get(commentWriteKey(entry.target.scope, comment.id))?.pending;
            if (decision) pending[comment.id] = decision;
        }
        next = { ...next, pending };
    }
    if (next.pending !== previous.pending && sameStrictJsonValue(next.pending, previous.pending)) next = { ...next, pending: previous.pending };
    if (next.status === previous.status && next.comments === previous.comments && next.pending === previous.pending
        && next.cursor === previous.cursor && next.loadingMore === previous.loadingMore && next.loadMoreFailed === previous.loadMoreFailed) return;
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
            const held = entry.snapshot.comments.find(item => item.id === comment.id);
            const matches = target.reviewId ? target.reviewId === comment.reviewId
                : target.sessionId ? target.sessionId === comment.sessionId
                : target.workspace ? sameStrictJsonValue(target.workspace, comment.workspace)
                : (!target.projectId || target.projectId === comment.projectId)
                    && (!target.workspaceId || target.workspaceId === comment.workspaceId);
            if (!held && !matches) continue;
            if (target.runId && target.runId !== comment.runId && !held) continue;
            holding.push(entry);
            if (held && held.serverRevision > latest.serverRevision) latest = held;
        }
        for (const entry of holding) upsert(entry, latest);
    }
}

/** Reconciles a confirmed write through the same windows that own reads and pending decisions. */
export function recordReviewCommentWrites(comments: readonly ReviewCommentV1[], scope: ServerAccountScope): void {
    recordReviewCommentReads(comments, scope);
}


function setPending(entry: Entry, commentId: string, decision: ReviewTriageStatus | null): void {
    writeChains.get(commentWriteKey(entry.target.scope, commentId))!.pending = decision ?? undefined;
    for (const held of entries.values()) {
        if (held !== entry && (!areServerAccountScopesEqual(held.target.scope, entry.target.scope)
            || !held.snapshot.comments.some(comment => comment.id === commentId))) continue;
        const pending = { ...held.snapshot.pending };
        if (decision) pending[commentId] = decision;
        else delete pending[commentId];
        publish(held, { ...held.snapshot, pending });
    }
}

export function readReviewRunComments(target: ReviewRunCommentsTarget): ReviewRunCommentsSnapshot {
    return entries.get(keyOf(target))?.snapshot ?? EMPTY_REVIEW_RUN_COMMENTS_SNAPSHOT;
}

/** A pushed read failed; retain the last good rows for the person's explicit refresh. */
export function markReviewRunCommentsFailed(target: ReviewRunCommentsTarget): void {
    const entry = entryFor(target);
    publish(entry, { ...entry.snapshot, status: 'failed' });
}

export function subscribeReviewRunComments(target: ReviewRunCommentsTarget, listener: () => void): () => void {
    const entry = entryFor(target);
    entry.listeners.add(listener);
    return () => {
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0) {
            entry.controller?.abort();
            entry.controller = null;
            entry.inFlight = null;
            // No placement observes changes while this window is closed. Its next demand refreshes
            // the retained rows rather than presenting a cached revision as current indefinitely.
            publish(entry, { ...entry.snapshot, status: 'idle', loadingMore: false });
        }
    };
}

/**
 * Loads (or reloads) the run's comments. Concurrent callers share one request; the last known
 * comments stay visible while it runs.
 */
type LoadParams = ReviewRunCommentsTarget & Readonly<{
    execute?: ReviewCommentUiActionExecutor;
    /** Materialization may reference a canonical comment first created by another review round. */
    commentIds?: readonly string[];
}>;

export function loadReviewRunComments(params: LoadParams): Promise<void> {
    return loadReviewRunCommentsPage(params);
}

/** Explicit continuation reads one candidate page, retaining its cursor on failure. */
export function loadMoreReviewRunComments(params: LoadParams): Promise<void> {
    const entry = entryFor(params);
    if (entry.inFlight) return entry.inFlight;
    return entry.snapshot.cursor ? loadReviewRunCommentsPage(params, entry.snapshot.cursor) : Promise.resolve();
}

function loadReviewRunCommentsPage(params: LoadParams, cursor?: string): Promise<void> {
    const entry = entryFor(params);
    if (entry.inFlight) return params.commentIds?.length
        ? entry.inFlight.then(() => ensureReviewRunComments(params))
        : entry.inFlight;
    const execute = resolveReviewCommentExecutor(params.scope, params.execute);
    const controller = new AbortController();
    entry.controller = controller;
    const revisionsBeforeRead = new Map(entry.snapshot.comments.map((comment) => [comment.id, comment.serverRevision]));
    if (entry.snapshot.status === 'idle' || entry.snapshot.status === 'failed') publish(entry, { ...entry.snapshot, status: 'loading' });
    if (cursor) publish(entry, { ...entry.snapshot, loadingMore: true, loadMoreFailed: false });
    const run = (async () => {
        try {
            const page = await execute('reviews.comments.list', {
                ...queryOf(params),
                includeHistory: true,
                limit: REVIEW_COMMENT_LIST_PAGE_LIMIT_MAX_V1,
                ...(cursor ? { cursor } : {}),
            }, { signal: controller.signal }) as ReviewCommentListResponseV1;
            if (controller.signal.aborted) return;
            const comments = cursor ? [...entry.snapshot.comments, ...page.items] : [...page.items];
            // Native run lists are selected by canonical appearances, including reused earlier-round comments.
            // Only legacy unbound runs need their historical per-reference adapter.
            for (const commentId of new Set(params.reviewId ? [] : params.commentIds)) {
                if (comments.some((comment) => comment.id === commentId)) continue;
                const result = await execute('reviews.comments.get', { commentId, includeHistory: true }, { signal: controller.signal }) as ReviewCommentGetResponseV1;
                if (controller.signal.aborted) return;
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
            publish(entry, { ...entry.snapshot, status: 'loaded', comments: [...latest.values()],
                cursor: page.cursor ?? null, loadingMore: false, loadMoreFailed: false });
            // A canonical reference can be held by several reviewer runs. A confirmed read is
            // just as authoritative as a write response; no loaded copy may keep an older revision.
            recordReviewCommentReads(entry.snapshot.comments, params.scope);
        } catch (cause) {
            if (controller.signal.aborted) return;
            publish(entry, { ...entry.snapshot, status: cursor ? entry.snapshot.status : 'failed',
                loadingMore: false, loadMoreFailed: Boolean(cursor) });
            throw new Error('review_run_comments_unavailable', { cause });
        } finally {
            if (entry.controller === controller) {
                entry.controller = null;
                entry.inFlight = null;
            }
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
    if (entry.snapshot.status === 'loaded' && (params.reviewId || !params.commentIds?.some((id) => !entry.snapshot.comments.some((comment) => comment.id === id)))) return Promise.resolve();
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
    const execute = resolveReviewCommentExecutor(params.scope, params.execute);
    const writeKey = commentWriteKey(params.scope, params.commentId);
    const previous = writeChains.get(writeKey)?.write ?? Promise.resolve();
    const chain: CommentWriteChain = { write: previous, pending: params.decision };
    writeChains.set(writeKey, chain);
    setPending(entry, params.commentId, params.decision);
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
            if (writeChains.get(writeKey) === chain) setPending(entry, params.commentId, null);
        }
    });
    chain.write = write;
    return write.then(() => confirmed);
}

/** Test seam: forget every run's comments. */
export function resetReviewRunCommentsForTests(): void {
    for (const entry of entries.values()) entry.controller?.abort();
    entries.clear();
    writeChains.clear();
    frontDoor = null;
}
