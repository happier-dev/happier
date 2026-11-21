import * as React from 'react';
import type { ReviewListRequestV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { getReviewListSnapshot, reviewListKey, subscribeReviewList } from '@/sync/store/domains/reviews/list';
import { loadMoreReviews, observeReviewList, refreshReviewList } from '@/sync/engine/reviews/list';

const noop = () => {};
/**
 * Shared collection binding; callers own their query and explicit continuation control. The list reads the active
 * Home's Account unless the caller names the exact Account it was opened for (a Team page).
 */
export function useReviewList(input: ReviewListRequestV1, options?: Readonly<{ enabled?: boolean; scope?: ServerAccountScope | null }>) {
    const active = useActiveServerAccountScopeLifetime();
    const explicit = options?.scope;
    const scope = explicit !== undefined ? explicit : active?.scope ?? null;
    const isCurrent = React.useCallback(() => explicit !== undefined ? explicit !== null : active?.isCurrent() === true,
        [active, explicit]);
    const presented = useLayoutPresentationActive();
    const enabled = options?.enabled !== false && presented;
    const key = scope ? reviewListKey(scope, input) : '';
    // The schema-normalized key holds a stable request (and scope) even if the caller constructs them inline.
    const request = React.useMemo(() => input, [key]);
    const target = React.useMemo(() => scope, [key]);
    const subscribe = React.useCallback((listener: () => void) => enabled && key
        ? subscribeReviewList(key, listener) : noop, [enabled, key]);
    const getSnapshot = React.useCallback(() => getReviewListSnapshot(key), [key]);
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    React.useEffect(() => {
        if (!enabled || !target || !isCurrent()) return;
        return observeReviewList(target, request);
    }, [enabled, isCurrent, request, target]);
    const refresh = React.useCallback(async () => {
        if (enabled && target && isCurrent()) await refreshReviewList(target, request);
    }, [enabled, isCurrent, request, target]);
    const loadMore = React.useCallback(async () => {
        if (enabled && target && isCurrent()) await loadMoreReviews(target, request);
    }, [enabled, isCurrent, request, target]);
    return { ...snapshot, scope: target, refresh, loadMore };
}
