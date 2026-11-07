import * as React from 'react';
import { AppState, Platform } from 'react-native';

import { storage } from '@/sync/domains/state/storage';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent, subscribeServerProfiles } from '@/sync/domains/server/serverProfiles';
import { subscribeAppliedActiveServer, subscribeAppliedActiveServerRuntimeAvailability } from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { readSessionPresentationCompletedRequests } from '@/sync/domains/session/presentation/readSessionPresentationCompletedRequests';
import { loadExpoNotifications } from '@/utils/platform/loadExpoNotifications';
import { resolveNotificationSavedHome } from '../resolveNotificationSavedHome';

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
        const sweep = async () => {
            const notifications = await loadExpoNotifications();
            const presented = await notifications.getPresentedNotificationsAsync();
            if (disposed) return;
            // OS inventory is demand, never a journal or a second request authority.
            presentedSessionIds = new Set(presented.flatMap(notification => {
                const data = notification.request.content.data;
                return data && (data.kind === 'permission' || data.kind === 'user_action')
                    && typeof data.sessionId === 'string' ? [data.sessionId] : [];
            }));
            for (const notification of presented) {
                if (disposed) return;
                const data = notification.request.content.data;
                if (!data || (data.kind !== 'permission' && data.kind !== 'user_action')) continue;
                const { accountId, serverUrl, sessionId, requestId, turnId } = data;
                if (typeof accountId !== 'string' || typeof serverUrl !== 'string'
                    || typeof sessionId !== 'string' || typeof requestId !== 'string'
                    || typeof turnId !== 'string' || !turnId) continue;
                const home = resolveNotificationSavedHome({ serverId: typeof data.serverId === 'string' ? data.serverId : undefined, serverUrl });
                const scope = getActiveServerAccountScope();
                if (!home || !scope || scope.accountId !== accountId
                    || !areServerProfileIdentifiersEquivalent(home.id, scope.serverId)) continue;
                const session = storage.getState().sessions[sessionId];
                if (!session?.serverId || !areServerProfileIdentifiersEquivalent(session.serverId, home.id)) continue;
                const completed = readSessionPresentationCompletedRequests(session)?.[requestId];
                if (!completed || typeof completed !== 'object' || Reflect.get(completed, 'turnId') !== turnId) continue;
                if (session.agentState?.requests?.[requestId]?.turnId === turnId) continue;
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
