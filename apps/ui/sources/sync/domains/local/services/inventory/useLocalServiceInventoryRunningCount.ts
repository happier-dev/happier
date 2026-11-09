import * as React from 'react';

import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { storage } from '@/sync/domains/state/storageStore';
import {
    createLocalServiceInventoryCountAcquisition,
    getLocalServiceInventoryRunningCount,
    observeLocalServiceInventorySummary,
    publishLocalServiceInventoryMachineSummary,
    type LocalServiceInventoryStoreKeyInput,
} from './sharedStore';

export type LocalServiceInventoryRunningCountInput = Readonly<{
    sessionId?: string;
    serverId: string;
    machineId: string | null;
    /** Controls the one-open read only. Held summaries remain passively observable. */
    enabled?: boolean;
}>;

function useInventorySummarySelection<T>(input: LocalServiceInventoryRunningCountInput, select: (count: number | null) => T): T {
    const { binding } = useServerCredentialAccountScopeBinding(input.serverId);
    const key = React.useMemo<LocalServiceInventoryStoreKeyInput | null>(() => (
        input.machineId && binding?.isCurrent() && binding.credentialKey
            ? { machineId: input.machineId, serverId: input.serverId, sessionId: input.sessionId,
                accountId: binding.accountId, credentialKey: binding.credentialKey } : null
    ), [binding, input.machineId, input.serverId, input.sessionId]);

    const subscribe = React.useCallback((listener: () => void) => {
        if (!key || !binding?.isCurrent()) return () => {};
        const receivedSummary = (): unknown => resolveServerScopedMachine(storage.getState(), key.serverId, key.machineId)?.daemonState?.localServices;
        let received = receivedSummary();
        if (received !== undefined) publishLocalServiceInventoryMachineSummary(key, received);
        const releaseSummary = observeLocalServiceInventorySummary(key, listener);
        const releaseMachine = storage.subscribe(() => {
            if (!binding.isCurrent()) return;
            const next = receivedSummary();
            if (next === received) return;
            received = next;
            publishLocalServiceInventoryMachineSummary(key, received);
        }, { machines: true, machineListByServerId: true, machineListStatusByServerId: true });
        const retirement = binding.onRetire(() => { releaseSummary(); releaseMachine(); listener(); });
        return () => { retirement.dispose(); releaseSummary(); releaseMachine(); };
    }, [binding, key]);

    const getSnapshot = React.useCallback(() => {
        if (!key || !binding?.isCurrent()) return select(null);
        return select(getLocalServiceInventoryRunningCount(key));
    }, [binding, key, select]);
    const selected = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

    const acquisitionRef = React.useRef<ReturnType<typeof createLocalServiceInventoryCountAcquisition> | null>(null);
    React.useEffect(() => () => {
        acquisitionRef.current?.dispose();
        acquisitionRef.current = null;
    }, [key]);
    React.useEffect(() => {
        if (!key || !input.sessionId || input.enabled === false || !binding?.isCurrent()) return;
        acquisitionRef.current ??= createLocalServiceInventoryCountAcquisition(key);
        void acquisitionRef.current.readOnce();
    }, [binding, input.enabled, input.sessionId, key]);
    return selected;
}

const selectCount = (count: number | null) => count;
const selectHasContent = (count: number | null) => count === null ? null : count > 0;

/** Mount at the Session model's address lifetime, outside reparented rail content. */
export function useLocalServiceInventoryRunningCount(input: LocalServiceInventoryRunningCountInput): number | null {
    return useInventorySummarySelection(input, selectCount);
}

/** Positive-to-positive changes notify count leaves without rendering the rail layout. */
export function useLocalServiceInventoryHasRunningServices(input: LocalServiceInventoryRunningCountInput): boolean | null {
    return useInventorySummarySelection(input, selectHasContent);
}
