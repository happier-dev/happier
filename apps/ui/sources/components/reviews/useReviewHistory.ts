import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useActiveServerAccountScopeLifetime } from '@/sync/store/hooks';
import { getReviewHistorySnapshot, reviewHistoryKey, subscribeReviewHistory } from '@/sync/store/domains/reviews/history';
import { observeReviewHistory, refreshReviewHistory } from '@/sync/engine/reviews/history';

const noop = () => {};
/** An opened workflow Review demands factual history; direct Reviews make no history request. */
export function useReviewHistory(input: Readonly<{ workflowId: string | null | undefined; reviewId: string }>,
    options?: Readonly<{ scope?: ServerAccountScope; enabled?: boolean }>) {
    const activeLifetime = useActiveServerAccountScopeLifetime();
    const { binding } = useServerCredentialAccountScopeBinding(options?.scope?.serverId ?? null);
    const lifetime = options?.scope
        ? binding?.accountId === options.scope.accountId ? binding : null
        : activeLifetime;
    const presented = useLayoutPresentationActive();
    const request = React.useMemo(() => input.workflowId && input.reviewId
        ? { workflowId: input.workflowId, reviewId: input.reviewId } : null, [input.workflowId, input.reviewId]);
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
