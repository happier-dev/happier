import * as React from 'react';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { sessionFollowGet, sessionFollowRemove, sessionFollowSet } from '@/sync/api/session/sessionFollowApi';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { subscribeHomeCredentialMutations } from '@/auth/storage/tokenStorage';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { isServerReachabilityNetworkAllowed, subscribeServerReachabilityNetworkAllowed } from '@/sync/runtime/connectivity/serverReachabilitySupervisorPool';
import { createAccountSessionFollowController, projectAccountSessionFollowPolicyEditor } from './accountSessionFollowController';
import { isSessionFollowAccountChangeRelevant } from './sessionFollowAccountChange';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';

/** Every personal Follow host shares this captured Account/Home lifetime. */
export function useAccountSessionFollowController(address: SessionAddress, enabled: boolean, onRetire?: () => void) {
    const { serverId, sessionId } = address;
    const actions = useMountedActionExecution(serverId);
    const executeRef = React.useRef(actions.execute);
    executeRef.current = actions.execute;
    const controller = React.useMemo(() => createAccountSessionFollowController({ serverId, sessionId }, {
        get: target => sessionFollowGet(target, (actionId, input) => executeRef.current(actionId, input)),
        set: (target, preferences) => sessionFollowSet(target, preferences, (actionId, input) => executeRef.current(actionId, input)),
        remove: target => sessionFollowRemove(target, (actionId, input) => executeRef.current(actionId, input)),
    }), [serverId, sessionId]);
    const state = React.useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
    const onRetireRef = React.useRef(onRetire);
    onRetireRef.current = onRetire;
    React.useEffect(() => {
        if (!enabled || !actions.ready) return;
        const lifetime = actions.binding;
        if (!lifetime?.isCurrent()) return;
        const retire = () => { controller.dispose(); onRetireRef.current?.(); };
        const retirement = lifetime.onRetire(retire);
        const credentials = subscribeHomeCredentialMutations(event => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, serverId)) retire();
        });
        controller.setOnline(isServerReachabilityNetworkAllowed());
        const connectivity = subscribeServerReachabilityNetworkAllowed(online => {
            const wasOffline = !controller.getSnapshot().online;
            controller.setOnline(online);
            if (online && wasOffline) void controller.refresh();
        });
        const sessionIds = new Set([sessionId]);
        const changes = subscribeHomeAccountChange(event => {
            if (areServerProfileIdentifiersEquivalent(event.serverId, serverId)
                && isSessionFollowAccountChangeRelevant(event, sessionIds)) void controller.refresh();
        }, { reconnect: { readNotCurrent: () => controller.getSnapshot().projection === null || controller.getSnapshot().error !== null } });
        void controller.refresh();
        return () => { retirement.dispose(); credentials(); connectivity(); changes(); };
    }, [actions.binding, actions.ready, controller, enabled, serverId, sessionId]);
    const policyEditor = React.useMemo(() => projectAccountSessionFollowPolicyEditor(state), [state]);
    return { controller, state, policyEditor };
}
