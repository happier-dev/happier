import * as React from 'react';
import { AppState, Platform } from 'react-native';

import { storage } from '@/sync/domains/state/storage';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { subscribeActiveServer } from '@/sync/domains/server/serverProfiles';
import { loadExpoNotifications } from '@/utils/platform/loadExpoNotifications';
import { dismissSettledAgentRequestNotifications } from './agentRequestNotificationSettlement';

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

        const sweep = () => dismissSettledAgentRequestNotifications((notice) => {
            // Read the active scope and completed state after the native inventory await.
            const scope = getActiveServerAccountScope();
            if (disposed || !scope) return null;
            const { sessionId, requestId, kind } = notice;
            const agentState = storage.getState().sessions[sessionId]?.agentState;
            const occurrenceId = agentState?.completedRequests?.[requestId]?.occurrenceId;
            if (typeof occurrenceId !== 'string' || !occurrenceId
                || agentState?.requests?.[requestId]?.occurrenceId === occurrenceId) return null;
            return { ...scope, sessionId, requestId, kind, occurrenceId };
        }, (sessionIds) => {
            if (!disposed) presentedSessionIds = sessionIds;
        });
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
