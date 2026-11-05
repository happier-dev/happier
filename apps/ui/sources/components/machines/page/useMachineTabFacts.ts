import * as React from 'react';

import { resolveServerScopedMachine } from '@/sync/domains/machines/resolveServerScopedMachine';
import { storage } from '@/sync/domains/state/storageStore';

/**
 * The few machine facts a tab body reads besides its own data: whether the person only uses this
 * machine (Use sees totals and rules; Manage controls the Machine), its
 * home folder (so paths read `~/…`), its platform and when it was last seen.
 */
export function useMachineTabFacts(serverId: string, machineId: string): Readonly<{
    recipient: boolean;
    homeDir: string | undefined;
    platform: string | undefined;
    /** When the machine was last seen (an offline machine's "as of"). */
    lastSeenAt: number | null;
}> {
    const recipient = storage(React.useCallback((state: ReturnType<typeof storage.getState>) => {
        const machine = resolveServerScopedMachine(state, serverId, machineId);
        return machine ? machine.isShared !== false && machine.access?.role !== 'manage' : false;
    }, [machineId, serverId]));
    const homeDir = storage(React.useCallback((state: ReturnType<typeof storage.getState>) =>
        resolveServerScopedMachine(state, serverId, machineId)?.metadata?.homeDir || undefined, [machineId, serverId]));
    const platform = storage(React.useCallback((state: ReturnType<typeof storage.getState>) =>
        resolveServerScopedMachine(state, serverId, machineId)?.metadata?.platform || undefined, [machineId, serverId]));
    const lastSeenAt = storage(React.useCallback((state: ReturnType<typeof storage.getState>) => {
        const activeAt = resolveServerScopedMachine(state, serverId, machineId)?.activeAt;
        return typeof activeAt === 'number' && activeAt > 0 ? activeAt : null;
    }, [machineId, serverId]));
    return React.useMemo(() => ({ recipient, homeDir, platform, lastSeenAt }), [homeDir, lastSeenAt, platform, recipient]);
}
