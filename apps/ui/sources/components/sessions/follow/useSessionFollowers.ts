import * as React from 'react';
import type { SessionFollowActionOutputV1 } from '@happier-dev/protocol/sessions/follow/actions';

import { listSessionFollowers } from '@/sync/api/session/sessionFollowSourcesApi';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { isSessionFollowAccountChangeRelevant } from './sessionFollowAccountChange';

type FollowersState = Readonly<{
    key: string;
    projection: SessionFollowActionOutputV1['follow.list'] | null;
    loading: boolean;
    error: string | null;
}>;

/** People reads authoritative reverse relations, never a graph assembled from loaded rows. */
export function useSessionFollowers(address: SessionAddress, enabled: boolean) {
    const { binding, resolution } = useServerCredentialAccountScopeBinding(enabled ? address.serverId : null);
    const key = JSON.stringify([address.serverId, address.sessionId, binding?.accountId, binding?.revision]);
    const [state, setState] = React.useState<FollowersState>({ key: '', projection: null, loading: false, error: null });
    const refreshRef = React.useRef<() => void>(() => {});
    const refresh = React.useCallback(() => refreshRef.current(), []);
    React.useEffect(() => {
        if (!enabled || !binding?.isCurrent()) return;
        const abort = new AbortController();
        const isCurrent = () => !abort.signal.aborted && binding.isCurrent();
        const sessionIds = new Set([address.sessionId]);
        let running = false;
        let dirty = false;
        const retirement = binding.onRetire(() => {
            abort.abort();
            setState({ key, projection: null, loading: false, error: 'action_account_scope_changed' });
        });
        // Follow's list owner keeps the useful read and folds overlapping wakes into one trailing read.
        const read = () => {
            if (!isCurrent()) return;
            if (running) { dirty = true; return; }
            running = true;
            void (async () => {
                try {
                    do {
                        dirty = false;
                        setState(current => ({ key, projection: current.key === key ? current.projection : null, loading: true, error: null }));
                        try {
                            const result = await listSessionFollowers({ serverId: binding.serverId, sessionId: address.sessionId }, abort.signal, binding.accountId);
                            if (!isCurrent()) return;
                            if (result.kind === 'ok') setState({ key, projection: result.value, loading: false, error: null });
                            else setState(current => ({ key,
                                projection: result.error === 'unavailable' && current.key === key ? current.projection : null,
                                loading: false, error: result.error }));
                        } catch {
                            if (isCurrent()) setState(current => ({ ...current, loading: false, error: 'unavailable' }));
                        }
                    } while (dirty && isCurrent());
                } finally { running = false; }
            })();
        };
        refreshRef.current = read;
        const unsubscribe = subscribeHomeAccountChange(event => {
            if (isCurrent() && areServerProfileIdentifiersEquivalent(event.serverId, binding.serverId)
                && isSessionFollowAccountChangeRelevant(event, sessionIds)) read();
        }, { reconnect: 'refresh' });
        read();
        return () => { abort.abort(); retirement.dispose(); unsubscribe(); refreshRef.current = () => {}; };
    }, [enabled, binding, key, address.sessionId]);
    const visible = enabled && binding?.isCurrent() && state.key === key ? state : null;
    return {
        projection: visible?.projection ?? null,
        loading: enabled && (resolution.kind === 'resolving' || Boolean(binding?.isCurrent() && (!visible || visible.loading))),
        error: visible?.error ?? (enabled && resolution.kind !== 'bound' && resolution.kind !== 'resolving' ? 'unavailable' : null),
        refresh,
    };
}
