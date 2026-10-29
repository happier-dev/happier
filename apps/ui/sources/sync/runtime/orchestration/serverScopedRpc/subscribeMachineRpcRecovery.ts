import { apiSocket, type SyncSocketState } from '@/sync/api/session/apiSocket';
import { subscribeMachineRequestRecovery } from '@/sync/domains/machines/reachability/machineReachability';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { subscribeHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';

/** Existing authenticated Home/Machine reconnect wakes, held only while the caller has demand. */
export function subscribeMachineRpcRecovery(input: Readonly<{
    machineId: string;
    serverId?: string | null;
    expectedAccountId?: string | null;
}>, recover: (revalidate?: boolean) => void): () => void {
    const matchesHome = (serverId: string) => areServerProfileIdentifiersEquivalent(
        input.serverId ?? getActiveServerSnapshot().serverId, serverId,
    );
    const matchesAccount = (accountId: string) => !input.expectedAccountId || input.expectedAccountId === accountId;
    let subscribed = true;
    let previousStatus: SyncSocketState['connectionStatus'] | null = null;
    const detachFocused = apiSocket.onStatusChange(status => {
        const previous = previousStatus;
        previousStatus = status;
        // The subscription immediately reports current state. New demand owns its
        // initial read; only a later observed connection transition is recovery.
        if (status !== 'connected' || previous === null || previous === 'connected') return;
        // The connection owner clears failed reachability after publishing status.
        void Promise.resolve().then(() => {
            if (!subscribed) return;
            const scope = apiSocket.getMachineRequestScope();
            if (scope && matchesHome(scope.serverId) && matchesAccount(scope.accountId)) recover(true);
        });
    });
    const detachConcurrent = subscribeHomeAccountChange(event => {
        if (event.source !== 'connected' || !matchesHome(event.serverId)) return;
        const focusedScope = apiSocket.getMachineRequestScope();
        // Sync also publishes the focused reconnect as a Home wake. The focused
        // status transition already owns it while that transport is connected.
        if (previousStatus === 'connected' && focusedScope
            && areServerProfileIdentifiersEquivalent(focusedScope.serverId, event.serverId)
            && matchesAccount(focusedScope.accountId)) return;
        recover(true);
    });
    const detachMachine = subscribeMachineRequestRecovery((scope, machineId) => {
        if (machineId === input.machineId && matchesHome(scope.serverId) && matchesAccount(scope.accountId)) recover();
    });
    return () => { subscribed = false; detachFocused(); detachConcurrent(); detachMachine(); };
}
