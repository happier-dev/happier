import * as React from 'react';
import { AppState, Platform } from 'react-native';

import { storage } from '@/sync/domains/state/storage';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent, subscribeServerProfiles } from '@/sync/domains/server/serverProfiles';
import { subscribeAppliedActiveServer, subscribeAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { readSessionPresentationCompletedRequests } from '@/sync/domains/session/presentation/readSessionPresentationCompletedRequests';
import { loadExpoNotifications } from '@/utils/platform/loadExpoNotifications';
import { dismissSettledAgentRequestNotifications } from './agentRequestNotificationSettlement';

/** Native presentation follows proven full-Session completion; compact rows do not prove settlement. */
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
            const session = storage.getState().sessions[sessionId];
            if (!session?.serverId || !areServerProfileIdentifiersEquivalent(session.serverId, scope.serverId)) return null;
            const completed = readSessionPresentationCompletedRequests(session)?.[requestId];
            const turnId = completed && typeof completed === 'object' ? Reflect.get(completed, 'turnId') : null;
            if (typeof turnId !== 'string' || !turnId || session.agentState?.requests?.[requestId]?.turnId === turnId) return null;
            return { ...scope, sessionId, requestId, kind, turnId };
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
            // OS demand can change after subscription; inspect its current membership.
            if (state.profileScope !== previous.profileScope || [...presentedSessionIds].some(id =>
                state.sessions[id] !== previous.sessions[id])) requestSweep();
        }, { profileScope: true, sessions: true });
        const unsubscribeServer = subscribeAppliedActiveServer(requestSweep);
        const unsubscribeAvailability = subscribeAppliedActiveServerRuntimeAvailability(requestSweep);
        const unsubscribeProfiles = subscribeServerProfiles(requestSweep);
        const appState = AppState.addEventListener('change', state => { if (state === 'active') requestSweep(); });
        void loadExpoNotifications().then(notifications => {
            if (!disposed) received = notifications.addNotificationReceivedListener(requestSweep);
        }).catch(() => {
            console.warn('[notifications] Request notification receipt cleanup unavailable');
        });
        requestSweep();
        return () => {
            disposed = true;
            reconcileRef.current = () => {};
            unsubscribe(); unsubscribeServer(); unsubscribeAvailability(); unsubscribeProfiles();
            appState.remove(); received?.remove();
        };
    }, []);
    return reconcile;
}
