import * as React from 'react';
import type { ReviewHistoryRequestV1, ReviewHistoryResponseV1, ReviewSeenBeforeRequestV1, ReviewSeenBeforeResponseV1,
    ReviewWorkflowHistoryResponseV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { getReviewHistorySnapshot, reviewHistoryKey, subscribeReviewHistory, type ReviewHistorySnapshot } from '@/sync/store/domains/reviews/history';
import { observeReviewHistory, refreshReviewHistory } from '@/sync/engine/reviews/history';

const noop = () => {};
type WorkflowHistoryInput = Readonly<{ workflowId: string | null | undefined; reviewId: string }>;
type HistoryOptions = Readonly<{ scope?: ServerAccountScope | null; enabled?: boolean }>;
type HistoryResult<TData> = Omit<ReviewHistorySnapshot, 'data'> & Readonly<{
    data: TData | null; scope: ServerAccountScope | null; refresh: () => Promise<void>;
}>;

/** Workflow activity and an opened finding share one demanded history lifecycle. */
export function useReviewHistory(input: WorkflowHistoryInput, options?: HistoryOptions): HistoryResult<ReviewWorkflowHistoryResponseV1>;
export function useReviewHistory(input: ReviewSeenBeforeRequestV1, options?: HistoryOptions): HistoryResult<ReviewSeenBeforeResponseV1>;
export function useReviewHistory(input: WorkflowHistoryInput | ReviewSeenBeforeRequestV1,
    options?: HistoryOptions): HistoryResult<ReviewHistoryResponseV1> {
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const { binding } = useServerCredentialAccountScopeBinding(options?.scope?.serverId ?? null);
    const lifetime = options?.scope === undefined ? activeLifetime
        : options.scope && binding?.accountId === options.scope.accountId ? binding : null;
    const presented = useLayoutPresentationActive();
    const workflowId = 'workflowId' in input ? input.workflowId : null;
    const findingIdentity = 'findingIdentity' in input ? input.findingIdentity : null;
    const request = React.useMemo<ReviewHistoryRequestV1 | null>(() => input.reviewId
        ? workflowId ? { workflowId, reviewId: input.reviewId }
            : findingIdentity ? { reviewId: input.reviewId, findingIdentity } : null
        : null, [workflowId, input.reviewId, findingIdentity]);
    const enabled = options?.enabled !== false && presented && request !== null;
    const key = lifetime && request ? reviewHistoryKey(lifetime.scope, request) : '';
    const subscribe = React.useCallback((listener: () => void) => enabled && key
        ? subscribeReviewHistory(key, listener) : noop, [enabled, key]);
    const getSnapshot = React.useCallback(() => getReviewHistorySnapshot(key), [key]);
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    React.useEffect(() => {
        if (!enabled || !request || !lifetime?.isCurrent()) return;
        return observeReviewHistory(lifetime.scope, request);
    }, [enabled, lifetime, request]);
    const refresh = React.useCallback(async () => {
        if (enabled && request && lifetime?.isCurrent()) await refreshReviewHistory(lifetime.scope, request);
    }, [enabled, lifetime, request]);
    return { ...snapshot, scope: lifetime?.scope ?? null, refresh };
}
