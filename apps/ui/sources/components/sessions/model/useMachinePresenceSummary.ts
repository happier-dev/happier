import * as React from 'react';

import { getStorage } from '@/sync/domains/state/storage';
import { resolveServerScopedMachine } from '@/sync/store/domains/machines/resolveServerScopedMachine';
import { getMachineDisplayName, isMachineOnline, readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';
import { sessionListRuntimeClock } from '@/hooks/session/sessionListRuntimeClock';

import {
    resolveSessionMachineReachabilityState,
    type SessionMachineReachability,
} from './resolveSessionMachineReachability';

/**
 * What a pane header says about the machine a tab runs on ("~/happier on MacBook Pro", "MacBook Pro is
 * offline"): its name, its home folder for `~` paths, and whether it is reachable. Primitives only, so
 * a heartbeat that does not flip presence re-renders nothing, but reschedules the grace expiry.
 *
 * `reachability` is the existing session reachability vocabulary: `unknown` when the machine record
 * is not visible from here (a shared Session), which callers must not present as offline.
 */
export type MachinePresenceSummary = Readonly<{
    name: string | null;
    homeDir: string | null;
    reachability: SessionMachineReachability;
}>;

type MachinePresenceStorageState = Parameters<typeof resolveServerScopedMachine>[0];

export function useMachinePresenceSummary(
    serverId: string | null | undefined,
    machineId: string | null | undefined,
): MachinePresenceSummary {
    const store = getStorage();
    const cached = React.useRef<MachinePresenceSummary | null>(null);
    const readMachine = React.useCallback(() => machineId
        ? resolveServerScopedMachine(store.getState() as MachinePresenceStorageState, serverId, machineId) : null,
    [store, serverId, machineId]);
    const getSnapshot = React.useCallback((): MachinePresenceSummary => {
        const machine = readMachine();
        const name = machine ? getMachineDisplayName(machine).trim() || null : null;
        const homeDir = machine?.metadata?.homeDir?.trim() || null;
        const reachability = resolveSessionMachineReachabilityState({
            machineIsKnown: Boolean(machine), machineIsOnline: machine ? isMachineOnline(machine) : false,
        });
        const previous = cached.current;
        if (!previous || previous.name !== name || previous.homeDir !== homeDir || previous.reachability !== reachability) {
            cached.current = { name, homeDir, reachability };
        }
        return cached.current!;
    }, [readMachine]);
    const subscribe = React.useCallback((listener: () => void) => {
        const token = {};
        const refresh = () => {
            const machine = readMachine();
            const next = machine ? readMachineStatusNextRefreshAtMs(machine, Date.now()) : null;
            if (next === null) sessionListRuntimeClock.clearWake(token);
            else sessionListRuntimeClock.requestWake(token, next);
            listener();
        };
        const stopStore = store.subscribe(refresh);
        const stopClock = sessionListRuntimeClock.subscribe(refresh);
        refresh();
        return () => { stopStore(); stopClock(); sessionListRuntimeClock.clearWake(token); };
    }, [store, readMachine]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
