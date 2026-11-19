import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { getReviewDetailSnapshot, reviewDetailKey, subscribeReviewDetail } from '@/sync/store/domains/reviews/detail';
import { observeReviewDetail, refreshReviewDetail } from '@/sync/engine/reviews/detail';

const noop = () => {};
/** The opened Review demands metadata; its Artifact and comments retain their existing owners. */
export function useReviewDetail(reviewId: string, options?: Readonly<{ scope?: ServerAccountScope | null; enabled?: boolean }>) {
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const { binding } = useServerCredentialAccountScopeBinding(options?.scope?.serverId ?? null);
    const lifetime = options?.scope === undefined ? activeLifetime
        : options.scope && binding?.accountId === options.scope.accountId ? binding : null;
    const presented = useLayoutPresentationActive();
    const enabled = options?.enabled !== false && presented && reviewId.length > 0;
    const key = lifetime ? reviewDetailKey(lifetime.scope, reviewId) : '';
    const subscribe = React.useCallback((listener: () => void) => enabled && key
        ? subscribeReviewDetail(key, listener) : noop, [enabled, key]);
    const getSnapshot = React.useCallback(() => getReviewDetailSnapshot(key), [key]);
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    React.useEffect(() => {
        if (!enabled || !lifetime?.isCurrent()) return;
        return observeReviewDetail(lifetime.scope, reviewId);
    }, [enabled, lifetime, reviewId]);
    const refresh = React.useCallback(async () => {
        if (enabled && lifetime?.isCurrent()) await refreshReviewDetail(lifetime.scope, reviewId);
    }, [enabled, lifetime, reviewId]);
    return { ...snapshot, scope: lifetime?.scope ?? null, refresh };
}
