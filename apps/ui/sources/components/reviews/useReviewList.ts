import * as React from 'react';
import type { ReviewListRequestV1 } from '@happier-dev/protocol/reviews/reviewListV1';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { getReviewListSnapshot, reviewListKey, subscribeReviewList } from '@/sync/store/domains/reviews/list';
import { loadMoreReviews, observeReviewList, refreshReviewList } from '@/sync/engine/reviews/list';

const noop = () => {};
/** Shared collection binding; callers own their query and explicit continuation control. */
export function useReviewList(input: ReviewListRequestV1, options?: Readonly<{ enabled?: boolean }>) {
    const lifetime = useActiveServerAccountScopeLifetime();
    const presented = useLayoutPresentationActive();
    const enabled = options?.enabled !== false && presented;
    const key = lifetime ? reviewListKey(lifetime.scope, input) : '';
    // The schema-normalized key holds a stable request even if the caller constructs one inline.
    const request = React.useMemo(() => input, [key]);
    const subscribe = React.useCallback((listener: () => void) => enabled && key
        ? subscribeReviewList(key, listener) : noop, [enabled, key]);
    const getSnapshot = React.useCallback(() => getReviewListSnapshot(key), [key]);
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    React.useEffect(() => {
        if (!enabled || !lifetime?.isCurrent()) return;
        return observeReviewList(lifetime.scope, request);
    }, [enabled, lifetime, request]);
    const refresh = React.useCallback(async () => {
        if (enabled && lifetime?.isCurrent()) await refreshReviewList(lifetime.scope, request);
    }, [enabled, lifetime, request]);
    const loadMore = React.useCallback(async () => {
        if (enabled && lifetime?.isCurrent()) await loadMoreReviews(lifetime.scope, request);
    }, [enabled, lifetime, request]);
    return { ...snapshot, scope: lifetime?.scope ?? null, refresh, loadMore };
}
