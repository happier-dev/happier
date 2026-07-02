import * as React from 'react';

import { CAPABILITIES_REQUEST_NEW_SESSION } from '@/capabilities/requests';
import { useNewSessionCapabilitiesPrefetch } from '@/components/sessions/new/hooks/useNewSessionCapabilitiesPrefetch';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { sync } from '@/sync/sync';
import { prefetchMachineCapabilities, prefetchMachineCapabilitiesIfStale } from '@/hooks/server/useMachineCapabilitiesCache';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { useStableRecentPathsForMachine } from '@/utils/sessions/useStableRecentPathsForMachine';
import { resolveDaemonCapabilitiesCacheKeySalt } from '@/hooks/server/useDaemonScopedMachineCapabilitiesCache';

type RecentMachinePath = Readonly<{
    machineId: string;
    path: string;
}>;

function buildMachineRefreshItemSignature(machine: Machine): string {
    const metadata = machine.metadata;
    return [
        machine.id,
        String(machine.active === true),
        String(machine.revokedAt ?? ''),
        String(machine.replacedByMachineId ?? ''),
        String(machine.daemonStateVersion ?? ''),
        String(metadata?.displayName ?? ''),
        String(metadata?.host ?? ''),
        String(metadata?.homeDir ?? ''),
        String(metadata?.platform ?? ''),
    ].join('|');
}

function buildMachineRefreshListSignature(machines: ReadonlyArray<Machine>): string {
    return machines.map(buildMachineRefreshItemSignature).join('\n');
}

function useStableValueBySignature<Value>(value: Value, signature: string): Value {
    const stableRef = React.useRef<Readonly<{ signature: string; value: Value }> | null>(null);
    if (!stableRef.current || stableRef.current.signature !== signature) {
        stableRef.current = { signature, value };
    }
    return stableRef.current.value;
}

export function useNewSessionMachineRefreshState(params: Readonly<{
    capabilityServerId: string;
    selectedMachineId: string | null;
    machines: ReadonlyArray<Machine>;
    recentMachinePaths: ReadonlyArray<RecentMachinePath>;
    sessions?: ReadonlyArray<Session | string> | null | undefined;
    favoriteMachines: ReadonlyArray<string>;
    useEnhancedSessionWizard: boolean;
    refreshMachineEnvPresence: () => void;
}>): Readonly<{
    refreshMachineData: () => void;
    recentMachines: ReadonlyArray<Machine>;
    favoriteMachineItems: ReadonlyArray<Machine>;
    recentPaths: ReadonlyArray<string>;
}> {
    const refreshMachineData = React.useCallback(() => {
        fireAndForget(sync.refreshMachinesThrottled({ staleMs: 0, force: true }), { tag: 'NewSessionScreenModel.refreshMachinesThrottled.manual' });
        params.refreshMachineEnvPresence();

        if (params.selectedMachineId) {
            const selectedMachine = params.machines.find((machine) => machine.id === params.selectedMachineId) ?? null;
            fireAndForget(prefetchMachineCapabilities({
                machineId: params.selectedMachineId,
                serverId: params.capabilityServerId,
                cacheKeySalt: resolveDaemonCapabilitiesCacheKeySalt(selectedMachine),
                request: { ...CAPABILITIES_REQUEST_NEW_SESSION, bypassCache: true },
            }), { tag: 'NewSessionScreenModel.prefetchMachineCapabilities' });
        }
    }, [params.capabilityServerId, params.machines, params.refreshMachineEnvPresence, params.selectedMachineId]);

    const rawRecentMachines = React.useMemo(() => {
        if (params.machines.length === 0) return [];
        if (params.recentMachinePaths.length === 0) return [];

        const byId = new Map(params.machines.map((machine) => [machine.id, machine] as const));
        const seen = new Set<string>();
        const result: Machine[] = [];
        for (const entry of params.recentMachinePaths) {
            if (seen.has(entry.machineId)) continue;
            const machine = byId.get(entry.machineId);
            if (!machine) continue;
            seen.add(entry.machineId);
            result.push(machine);
        }
        return result;
    }, [params.machines, params.recentMachinePaths]);
    const recentMachinesSignature = React.useMemo(
        () => buildMachineRefreshListSignature(rawRecentMachines),
        [rawRecentMachines],
    );
    const recentMachines = useStableValueBySignature(rawRecentMachines, recentMachinesSignature);

    const rawFavoriteMachineItems = React.useMemo(() => {
        return params.machines.filter((machine) => params.favoriteMachines.includes(machine.id));
    }, [params.favoriteMachines, params.machines]);
    const favoriteMachineItemsSignature = React.useMemo(
        () => buildMachineRefreshListSignature(rawFavoriteMachineItems),
        [rawFavoriteMachineItems],
    );
    const favoriteMachineItems = useStableValueBySignature(rawFavoriteMachineItems, favoriteMachineItemsSignature);

    useNewSessionCapabilitiesPrefetch({
        enabled: params.useEnhancedSessionWizard,
        serverId: params.capabilityServerId,
        machines: params.machines,
        favoriteMachineItems,
        recentMachines,
        selectedMachineId: params.selectedMachineId,
        isMachineOnline,
        staleMs: 2 * 60 * 1000,
        request: CAPABILITIES_REQUEST_NEW_SESSION,
        prefetchMachineCapabilitiesIfStale,
    });

    const recentPaths = useStableRecentPathsForMachine({
        machineId: params.selectedMachineId,
        recentMachinePaths: params.recentMachinePaths,
        sessions: params.sessions,
        cacheScopeKey: params.capabilityServerId,
    });

    return {
        refreshMachineData,
        recentMachines,
        favoriteMachineItems,
        recentPaths,
    };
}
