import * as React from 'react';
import type { ReviewTriageStatus } from '@happier-dev/protocol/reviews/reviewTriageStatus';
import type { ReviewCommentUiActionExecutor } from '@/sync/domains/reviews/comments/api';

import { observeReviewCommentChanges } from '@/sync/domains/reviews/comments/commentChanges';
import {
    EMPTY_REVIEW_RUN_COMMENTS_SNAPSHOT,
    decideReviewRunFinding,
    ensureReviewRunComments,
    loadMoreReviewRunComments,
    loadReviewRunComments,
    markReviewRunCommentsFailed,
    readReviewRunComments,
    subscribeReviewRunComments,
    type ReviewRunCommentsSnapshot,
    type ReviewRunCommentsTarget,
} from '@/sync/domains/reviews/comments/reviewRunComments';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { fireAndForget } from '@/utils/system/fireAndForget';

export type ReviewCommentsModel = ReviewRunCommentsSnapshot & Readonly<{
    refresh: () => Promise<void>;
    loadMore: () => Promise<void>;
    decide: (commentId: string, decision: ReviewTriageStatus) => Promise<boolean>;
}>;

const EMPTY_REVIEW_COMMENTS_MODEL: ReviewCommentsModel = Object.freeze({
    ...EMPTY_REVIEW_RUN_COMMENTS_SNAPSHOT,
    refresh: () => Promise.resolve(),
    loadMore: () => Promise.resolve(),
    decide: () => Promise.resolve(false),
});

/** Each reviewer run's comment window and actions, in the order of `runIds`. */
export type ReviewRunsCommentsSnapshot = readonly ReviewCommentsModel[];

function useReviewCommentTargets(params: Readonly<{
    targets: readonly ReviewRunCommentsTarget[];
    enabled: boolean;
    refresh?: boolean;
    references?: Readonly<Record<string, readonly string[]>>;
    execute?: ReviewCommentUiActionExecutor;
}>): ReviewRunsCommentsSnapshot {
    const { targets, enabled, refresh, references, execute } = params;
    const actions = React.useMemo(() => targets.map(target => ({
        refresh: () => loadReviewRunComments({ ...target, execute }),
        loadMore: () => loadMoreReviewRunComments({ ...target, execute }),
        decide: (commentId: string, decision: ReviewTriageStatus) => decideReviewRunFinding({ ...target, execute, commentId, decision }),
    })), [execute, targets]);
    const cacheRef = React.useRef<Readonly<{
        sources: readonly ReviewRunCommentsSnapshot[];
        actions: typeof actions;
        models: ReviewRunsCommentsSnapshot;
    }>>({ sources: [], actions: [], models: [] });
    const subscribe = React.useCallback((listener: () => void) => {
        const unsubscribers = targets.map(target => subscribeReviewRunComments(target, listener));
        return () => { for (const unsubscribe of unsubscribers) unsubscribe(); };
    }, [targets]);
    const getSnapshot = React.useCallback(() => {
        const sources = targets.map(target => readReviewRunComments(target));
        const previous = cacheRef.current;
        const models = sources.map((source, index) => source === previous.sources[index] && actions[index] === previous.actions[index]
            ? previous.models[index]! : { ...source, ...actions[index]! });
        if (previous.models.length === models.length && previous.models.every((model, index) => model === models[index])) return previous.models;
        cacheRef.current = { sources, actions, models };
        return models;
    }, [actions, targets]);
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    React.useEffect(() => {
        if (!enabled) return;
        const releases = targets.map(target => observeReviewCommentChanges({ ...target, execute,
            readComments: () => readReviewRunComments(target).comments,
            reload: () => loadReviewRunComments({ ...target, execute }),
            onReadFailed: () => markReviewRunCommentsFailed(target),
        }));
        return () => { for (const release of releases) release(); };
    }, [enabled, execute, targets]);

    React.useEffect(() => {
        if (!enabled) return;
        const load = refresh ? loadReviewRunComments : ensureReviewRunComments;
        for (const target of targets) {
            fireAndForget(load({ ...target, execute, commentIds: target.runId ? references?.[target.runId] : undefined }).catch(() => undefined),
                { tag: 'useReviewRunsComments.load' });
        }
    }, [enabled, execute, references, refresh, targets]);
    return snapshot;
}

/** An opened SCM comment selector consumes the same window as native Reviews and run adapters. */
export function useReviewCommentsWindow(params: Readonly<{
    target: ReviewRunCommentsTarget | null;
    enabled: boolean;
    execute: ReviewCommentUiActionExecutor;
}>): ReviewCommentsModel {
    const { target, enabled, execute } = params;
    const targets = React.useMemo(() => target && enabled ? [target] : [], [enabled, target]);
    return useReviewCommentTargets({ targets, enabled, execute })[0] ?? EMPTY_REVIEW_COMMENTS_MODEL;
}

/**
 * The durable comments of a review's runs (one per reviewer), shared with every other surface.
 * The run pane reloads on open; transcript cards reuse the loaded windows.
 */
export function useReviewRunsComments(params: Readonly<{
    scope: ServerAccountScope | null;
    sessionId: string;
    runIds: readonly string[];
    reviewIdsByRunId?: Readonly<Record<string, string | undefined>>;
    commentIdsByRunId?: Readonly<Record<string, readonly string[]>>;
    enabled: boolean;
    refresh?: boolean;
}>): ReviewRunsCommentsSnapshot {
    const { sessionId, enabled, refresh } = params;
    const serverId = params.scope?.serverId ?? null;
    const accountId = params.scope?.accountId ?? null;
    const scope = React.useMemo(() => (serverId && accountId ? { serverId, accountId } : null), [accountId, serverId]);
    const runKey = params.runIds.join('\u0000');
    const runIds = React.useMemo(() => (runKey && scope ? runKey.split('\u0000') : []), [runKey, scope]);
    const referenceKey = JSON.stringify(params.commentIdsByRunId ?? {});
    const references = React.useMemo(() => JSON.parse(referenceKey) as Readonly<Record<string, readonly string[]>>, [referenceKey]);
    const reviewKey = JSON.stringify(params.reviewIdsByRunId ?? {});
    const reviewIds = React.useMemo(() => JSON.parse(reviewKey) as Readonly<Record<string, string>>, [reviewKey]);
    const targets = React.useMemo(() => scope ? runIds.map(runId => ({ scope, sessionId, runId,
        ...(reviewIds[runId] ? { reviewId: reviewIds[runId] } : {}) })) : [], [runIds, scope, sessionId, reviewIds]);
    return useReviewCommentTargets({ targets, references, enabled, refresh });
}

/** A native Review window, optionally restricted to one run, with the shared pager and decisions. */
export function useReviewComments(params: Readonly<{
    scope: ServerAccountScope | null;
    reviewId: string | null;
    runId?: string | null;
    enabled: boolean;
    refresh?: boolean;
}>): ReviewCommentsModel {
    const serverId = params.scope?.serverId ?? null;
    const accountId = params.scope?.accountId ?? null;
    const { reviewId, runId, enabled, refresh } = params;
    const target = React.useMemo<ReviewRunCommentsTarget | null>(() => serverId && accountId && reviewId
        ? { scope: { serverId, accountId }, reviewId, ...(runId ? { runId } : {}) } : null,
    [serverId, accountId, reviewId, runId]);
    const targets = React.useMemo(() => target ? [target] : [], [target]);
    const snapshots = useReviewCommentTargets({ targets, enabled, refresh });
    return snapshots[0] ?? EMPTY_REVIEW_COMMENTS_MODEL;
}
