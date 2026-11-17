import * as React from 'react';

import {
    ensureReviewRunComments,
    loadReviewRunComments,
    readReviewRunComments,
    subscribeReviewRunComments,
    type ReviewRunCommentsSnapshot,
} from '@/sync/domains/reviews/comments/reviewRunComments';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { fireAndForget } from '@/utils/system/fireAndForget';

/** Each reviewer run's comment snapshot, in the order of `runIds`. */
export type ReviewRunsCommentsSnapshot = readonly ReviewRunCommentsSnapshot[];

/**
 * The durable comments of a review's runs (one per reviewer), shared with every other surface
 * showing the same runs. The run pane (`refresh: true`) reloads them when it opens; transcript cards
 * reuse what is loaded. The result keeps its identity until one of the runs' snapshots changes.
 */
export function useReviewRunsComments(params: Readonly<{
    /** The exact Home and Account the review is open under; `null` while it resolves (nothing loads). */
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
    const scope = React.useMemo(
        () => (serverId && accountId ? { serverId, accountId } : null),
        [accountId, serverId],
    );
    const runKey = params.runIds.join('\u0000');
    const runIds = React.useMemo(() => (runKey && scope ? runKey.split('\u0000') : []), [runKey, scope]);
    const referenceKey = JSON.stringify(params.commentIdsByRunId ?? {});
    const references = React.useMemo(() => JSON.parse(referenceKey) as Readonly<Record<string, readonly string[]>>, [referenceKey]);
    const reviewKey = JSON.stringify(params.reviewIdsByRunId ?? {});
    const reviewIds = React.useMemo(() => JSON.parse(reviewKey) as Readonly<Record<string, string>>, [reviewKey]);
    const targets = React.useMemo(() => scope ? runIds.map(runId => ({ scope, sessionId, runId,
        ...(reviewIds[runId] ? { reviewId: reviewIds[runId] } : {}) })) : [], [runIds, scope, sessionId, reviewIds]);
    const cacheRef = React.useRef<ReviewRunsCommentsSnapshot>([]);
    const subscribe = React.useCallback((listener: () => void) => {
        const unsubscribers = targets.map(target => subscribeReviewRunComments(target, listener));
        return () => {
            for (const unsubscribe of unsubscribers) unsubscribe();
        };
    }, [targets]);
    const getSnapshot = React.useCallback(() => {
        const next = targets.map(target => readReviewRunComments(target));
        const previous = cacheRef.current;
        if (previous.length === next.length && previous.every((snapshot, index) => snapshot === next[index])) return previous;
        cacheRef.current = next;
        return next;
    }, [targets]);
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    React.useEffect(() => {
        if (!enabled || !scope) return;
        const load = refresh ? loadReviewRunComments : ensureReviewRunComments;
        for (const target of targets) {
            fireAndForget(load({ ...target, commentIds: references[target.runId] }).catch(() => undefined), { tag: 'useReviewRunsComments.load' });
        }
    }, [enabled, references, refresh, scope, targets]);

    return snapshot;
}
