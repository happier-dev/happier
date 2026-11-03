import * as React from 'react';
import { Platform } from 'react-native';

import { useLocalSearchParams } from '@/components/appShell/workspace/destinationRoute';
import { storage } from '@/sync/domains/state/storageStore';
import type { StorageState } from '@/sync/store/types';
import { isMachineVisibleForSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { useMachineListForServerSelection, useServerScopedMachine } from '@/sync/store/hooks';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { areServerProfileIdentifiersEquivalent, getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { setActiveServerAndSwitch } from '@/sync/domains/server/activeServerSwitch';
import { resolveRoutineServerSelectionScope } from '@/sync/domains/server/selection/serverSelectionScope';
import { sync } from '@/sync/sync';
import { isDesktopHost } from '@/utils/platform/desktopHost';
import { useMachinePresenceSummary } from '@/components/sessions/model/useMachinePresenceSummary';
import { getMachineSentenceName, resolveMachineDisplayNames } from '@/utils/sessions/machineDisplayNames';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { useManagedEnrolledMachine } from '@/components/settings/machines/managed/ManagedMachineSections';

/** The Home that lists this machine: the focused Home first, else the first Home that has it. */
export function resolveMachineServerIdFromList(params: Readonly<{
    activeServerId: string;
    machineId: string | undefined;
    machineListByServerId: Readonly<Record<string, readonly Pick<Machine, 'id'>[] | null | undefined>>;
}>): string {
    const machineId = String(params.machineId ?? '').trim();
    if (!machineId) return '';
    const activeServerMachines = params.machineListByServerId[params.activeServerId];
    if (Array.isArray(activeServerMachines) && activeServerMachines.some((machine) => machine.id === machineId)) {
        return params.activeServerId;
    }
    for (const [serverId, machines] of Object.entries(params.machineListByServerId)) {
        if (Array.isArray(machines) && machines.some((machine) => machine.id === machineId)) return serverId;
    }
    return '';
}

/**
 * The page's Home and on-screen name, read as strings from the machine inventory: another
 * Machine's daemon publication (each live resource sample) replaces the inventory lists but not
 * these facts, so the page stays quiet.
 */
function useMachinePageNaming(input: Readonly<{ activeServerId: string; requestedServerId: string; machineId: string; language: string }>): Readonly<{
    serverId: string;
    /** The same name the lists show, told apart when another machine shares it; `null` while the Home does not list it. */
    listedName: string | null;
    managedName: string | undefined;
}> {
    const { activeServerId, requestedServerId, machineId, language } = input;
    const selectServerId = React.useMemo(() => {
        let lastLists: StorageState['machineListByServerId'] | undefined;
        let serverId = '';
        return (state: StorageState) => {
            const lists = state.machineListByServerId ?? {};
            if (lists === lastLists) return serverId;
            lastLists = lists;
            const visible = Object.fromEntries(Object.entries(lists).map(([key, machines]) => [key,
                Array.isArray(machines) ? machines.filter(isMachineVisibleForSelection) : machines]));
            serverId = resolveMachineServerIdFromList({ activeServerId, machineId, machineListByServerId: visible });
            return serverId;
        };
    }, [activeServerId, machineId]);
    const listedServerId = storage(selectServerId);
    const serverId = requestedServerId || listedServerId || activeServerId;
    const managedName = useManagedEnrolledMachine({ serverId, enrolledMachineId: machineId || undefined }).machine?.launch.name;
    const listedName = useMachineListForServerSelection(serverId, React.useCallback((machines: readonly Machine[]) => (
        machines.some((candidate) => candidate.id === machineId) ? resolveMachineDisplayNames(machines.map(candidate =>
            candidate.id === machineId ? { ...candidate, managedName } : candidate)).get(machineId) ?? null : null
    // `language`: names re-derive in the active locale.
    ), [machineId, language, managedName]));
    return { serverId, listedName, managedName };
}

export type MachinePageTarget = Readonly<{
    machineId: string;
    /** The `serverId` the route names, when it names one. */
    requestedServerId: string;
    /** The Home the page reads the machine from. */
    serverId: string;
    activeServerId: string;
    machine: Machine | null;
    machineName: string;
    /** The name inside page sentences: "this machine" while the machine's details are locked or loading. */
    machineSentenceName: string;
    online: boolean | null;
    /** The page is focusing the Home its link names. */
    isServerSwitching: boolean;
    /** The machine list is being read because the machine is not known yet. */
    isHydratingMachine: boolean;
    /** The focused Home is the one the route names, so machine RPCs reach the right daemon. */
    switchReady: boolean;
}>;

/**
 * The machine a Machines page (or one of its sub-pages) is about, from the route: which Home it
 * belongs to, focusing that Home when the link names another, and reading the machine list once
 * when the machine is not known yet. Every page of one machine resolves it the same way.
 */
export function useMachinePageTarget(): MachinePageTarget {
    const language = usePreferredLanguage();
    const params = useLocalSearchParams<{ id: string; serverId?: string }>();
    const machineId = typeof params.id === 'string' ? params.id : '';
    const activeServerId = getActiveServerId();
    const requestedServerId = typeof params.serverId === 'string' ? params.serverId.trim() : '';
    const naming = useMachinePageNaming({ activeServerId, requestedServerId, machineId, language });
    const serverId = naming.serverId;
    // The Home that lists the machine owns its row, whether or not that Home is the focused one.
    const machine = useServerScopedMachine(serverId, machineId);
    const presence = useMachinePresenceSummary(serverId, machineId);
    const [isServerSwitching, setIsServerSwitching] = React.useState(false);
    const [isHydratingMachine, setIsHydratingMachine] = React.useState(() => Boolean(machineId) && !machine);
    const hydrationRequestedRef = React.useRef(false);

    React.useEffect(() => {
        if (!requestedServerId) return;
        if (areServerProfileIdentifiersEquivalent(getActiveServerId(), requestedServerId)) return;
        let cancelled = false;
        setIsServerSwitching(true);
        fireAndForget((async () => {
            try {
                await setActiveServerAndSwitch({
                    serverId: requestedServerId,
                    scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()),
                });
                await sync.refreshMachinesThrottled({ staleMs: 0, force: true });
            } finally {
                if (!cancelled) setIsServerSwitching(false);
            }
        })(), { tag: 'MachinePage.switchServer' });
        return () => {
            cancelled = true;
        };
    }, [requestedServerId]);

    React.useEffect(() => {
        if (!machineId) return;
        if (machine) {
            hydrationRequestedRef.current = false;
            if (isHydratingMachine) setIsHydratingMachine(false);
            return;
        }
        if (hydrationRequestedRef.current) return;
        hydrationRequestedRef.current = true;
        let cancelled = false;
        setIsHydratingMachine(true);
        fireAndForget((async () => {
            try {
                await sync.refreshMachines();
            } finally {
                if (!cancelled) setIsHydratingMachine(false);
            }
        })(), { tag: 'MachinePage.hydrateMachine' });
        return () => {
            cancelled = true;
        };
    }, [isHydratingMachine, machine, machineId]);

    const machineName = React.useMemo(() => {
        if (!machine) return t('machine.unknownMachine');
        // The same name the lists show, told apart when another machine shares it; a machine its Home
        // does not list (yet) is named on its own.
        return naming.listedName ?? resolveMachineDisplayNames([{ ...machine, managedName: naming.managedName }]).get(machine.id) ?? t('machine.unknownMachine');
    }, [language, machine, naming.listedName, naming.managedName]);
    const machineSentenceName = React.useMemo(() => getMachineSentenceName(machine && { ...machine, managedName: naming.managedName }, machineName),
        [language, machine, machineName, naming.managedName]);
    const online = presence.reachability === 'unknown' ? null : presence.reachability === 'reachable';
    const switchReady = Boolean(machineId) && !isServerSwitching
        && (!requestedServerId || areServerProfileIdentifiersEquivalent(requestedServerId, activeServerId));

    return React.useMemo(() => ({
        machineId,
        requestedServerId,
        serverId,
        activeServerId,
        machine,
        machineName,
        machineSentenceName,
        online,
        isServerSwitching,
        isHydratingMachine,
        switchReady,
    }), [activeServerId, isHydratingMachine, isServerSwitching, machine, machineId, machineName, machineSentenceName,
        online, requestedServerId, serverId, switchReady]);
}
