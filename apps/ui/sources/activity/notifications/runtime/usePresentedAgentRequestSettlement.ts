import * as React from 'react';
import { AppState, Platform } from 'react-native';

import { storage } from '@/sync/domains/state/storage';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { getActiveServerUrl, subscribeActiveServer } from '@/sync/domains/server/serverProfiles';
import { createServerUrlComparableKey } from '@/sync/domains/server/url/serverUrlCanonical';
import { loadExpoNotifications } from '@/utils/platform/loadExpoNotifications';

/** Reconciles OS presentation only; the CLI's completed request remains authoritative. */
export function usePresentedAgentRequestSettlement(): () => void {
    const reconcileRef = React.useRef<() => void>(() => {});
    const reconcile = React.useCallback(() => reconcileRef.current(), []);
    React.useEffect(() => {
        if (Platform.OS === 'web') return;
        let disposed = false;
        let dirty = false;
        let running: Promise<void> | null = null;
        let received: { remove(): void } | undefined;
        let presentedSessionIds = new Set<string>();

        const sweep = async () => {
            const notifications = await loadExpoNotifications();
            const presented = await notifications.getPresentedNotificationsAsync();
            if (disposed) return;
            // Only presented request notices create settlement work. A receipt,
            // local send, resume, or Account change refreshes this native inventory.
            presentedSessionIds = new Set(presented.flatMap((notification) => {
                const data = notification.request.content.data;
                return data && (data.kind === 'permission' || data.kind === 'user_action')
                    && typeof data.sessionId === 'string' ? [data.sessionId] : [];
            }));
            for (const notification of presented) {
                if (disposed) return;
                const data = notification.request.content.data;
                if (!data || (data.kind !== 'permission' && data.kind !== 'user_action')) continue;
                const { accountId, serverUrl, sessionId, requestId, occurrenceId } = data;
                if (typeof accountId !== 'string' || typeof serverUrl !== 'string'
                    || typeof sessionId !== 'string' || typeof requestId !== 'string'
                    || typeof occurrenceId !== 'string' || !occurrenceId) continue;
                // Read after the native await: an Account/Home may have changed
                // while inventory loaded. Missing or unloaded detail proves nothing.
                const scope = getActiveServerAccountScope();
                const serverKey = createServerUrlComparableKey(serverUrl);
                if (!scope || scope.accountId !== accountId
                    || !serverKey || serverKey !== createServerUrlComparableKey(getActiveServerUrl())) continue;
                const agentState = storage.getState().sessions[sessionId]?.agentState;
                const completed = agentState?.completedRequests?.[requestId];
                if (!completed || completed.occurrenceId !== occurrenceId) continue;
                if (agentState?.requests?.[requestId]?.occurrenceId === occurrenceId) continue;
                await notifications.dismissNotificationAsync(notification.request.identifier);
            }
        };
        const requestSweep = () => {
            dirty = true;
            if (running || disposed) return;
            running = (async () => {
                while (dirty && !disposed) {
                    dirty = false;
                    await sweep();
                }
            })().catch(() => {
                console.warn('[notifications] Settled request notification cleanup unavailable');
            }).finally(() => {
                running = null;
                if (dirty && !disposed) requestSweep();
            });
        };
        reconcileRef.current = requestSweep;
        const unsubscribe = storage.subscribe((state, previous) => {
            if (state.profileScope !== previous.profileScope
                || (state.sessions !== previous.sessions && [...presentedSessionIds].some((id) =>
                    state.sessions[id]?.agentState !== previous.sessions[id]?.agentState))) requestSweep();
        });
        const unsubscribeServer = subscribeActiveServer(requestSweep);
        const appState = AppState.addEventListener('change', (state) => { if (state === 'active') requestSweep(); });
        void loadExpoNotifications().then((notifications) => {
            if (!disposed) received = notifications.addNotificationReceivedListener(requestSweep);
        }).catch(() => {
            console.warn('[notifications] Request notification receipt cleanup unavailable');
        });
        requestSweep();
        return () => {
            disposed = true;
            reconcileRef.current = () => {};
            unsubscribe();
            unsubscribeServer();
            appState.remove();
            received?.remove();
        };
    }, []);
    return reconcile;
}
