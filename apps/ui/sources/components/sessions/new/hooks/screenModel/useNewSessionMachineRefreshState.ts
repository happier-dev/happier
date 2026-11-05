import * as React from 'react';
import { shallow } from 'zustand/shallow';

import { CAPABILITIES_REQUEST_NEW_SESSION } from '@/capabilities/requests';
import { useNewSessionCapabilitiesPrefetch } from '@/components/sessions/new/hooks/useNewSessionCapabilitiesPrefetch';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { sync } from '@/sync/sync';
import { prefetchMachineCapabilities, prefetchMachineCapabilitiesIfStale } from '@/hooks/server/useMachineCapabilitiesCache';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import { useMachinePresenceSnapshot } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { useStableRecentPathsResolver, type RecentPathSessionsInput } from '@/utils/sessions/useStableRecentPathsForMachine';
import { resolveDaemonCapabilitiesCacheKeySalt } from '@/hooks/server/useDaemonScopedMachineCapabilitiesCache';
import { resolveNewSessionMachinePickerHistory } from '@/components/sessions/new/modules/newSessionPlacementSources';

type RecentMachinePath = Readonly<{
    machineId: string;
    path: string;
}>;

function buildMachineRefreshItemSignature(machine: Machine): string {
    const metadata = machine.metadata;
    return [
        machine.id,
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
    focused?: boolean;
    capabilityServerId: string;
    selectedMachineId: string | null;
    selectedMachine?: Machine | null;
    machines: ReadonlyArray<Machine>;
    recentMachinePaths: ReadonlyArray<RecentMachinePath>;
    sessions?: RecentPathSessionsInput;
    favoriteMachines: ReadonlyArray<string>;
    useEnhancedSessionWizard: boolean;
    refreshMachineEnvPresence: () => void;
}>): Readonly<{
    refreshMachineData: () => void;
    recentMachines: ReadonlyArray<Machine>;
    favoriteMachineItems: ReadonlyArray<Machine>;
    recentPaths: ReadonlyArray<string>;
    readRecentPaths: () => ReadonlyArray<string>;
}> {
    // Only the visible wizard prefetch consumes this reachability callback.
    // Manual refresh reads current facts at intent; a simple/hidden composer
    // has no consumer for fleet request receipts.
    const wizardPrefetchDemanded = params.useEnhancedSessionWizard && params.focused !== false;
    const { binding } = useServerCredentialAccountScopeBinding(params.capabilityServerId);
    const scope = binding?.isCurrent() ? binding.scope : null;
    const readMachines = React.useCallback(() => wizardPrefetchDemanded ? params.machines : [], [params.machines, wizardPrefetchDemanded]);
    const readReachability = React.useCallback((nowMs: number) => readMachines().map(machine => isMachineReachable(scope, machine, nowMs)), [readMachines, scope]);
    const presenceTargets = React.useMemo(() => wizardPrefetchDemanded
        ? [{ serverId: params.capabilityServerId, machineIds: params.machines.map(machine => machine.id) }] : [],
    [params.capabilityServerId, params.machines, wizardPrefetchDemanded]);
    const reachability = useMachinePresenceSnapshot(readMachines, readReachability, presenceTargets, shallow);
    const machineReachable = React.useCallback(
        (machine: Machine) => isMachineReachable(scope, machine),
        [scope, reachability],
    );
    const manualRefreshLifetime = React.useMemo(() => ({ controller: new AbortController() }), [params.capabilityServerId, params.selectedMachineId, params.focused]);
    React.useEffect(() => {
        if (params.focused === false) { manualRefreshLifetime.controller.abort(); return; }
        if (manualRefreshLifetime.controller.signal.aborted) manualRefreshLifetime.controller = new AbortController();
        const controller = manualRefreshLifetime.controller;
        return () => controller.abort();
    }, [manualRefreshLifetime, params.focused]);
    const refreshMachineData = React.useCallback(() => {
        if (manualRefreshLifetime.controller.signal.aborted) return;
        fireAndForget(sync.refreshMachinesThrottled({ staleMs: 0, force: true }), { tag: 'NewSessionScreenModel.refreshMachinesThrottled.manual' });
        params.refreshMachineEnvPresence();

        if (params.selectedMachineId) {
            const selectedMachine = params.selectedMachine === undefined
                ? params.machines.find((machine) => machine.id === params.selectedMachineId) ?? null : params.selectedMachine;
            fireAndForget(prefetchMachineCapabilities({
                machineId: params.selectedMachineId,
                serverId: params.capabilityServerId,
                cacheKeySalt: resolveDaemonCapabilitiesCacheKeySalt(selectedMachine, params.capabilityServerId),
                signal: manualRefreshLifetime.controller.signal,
                request: { ...CAPABILITIES_REQUEST_NEW_SESSION, bypassCache: true },
            }), { tag: 'NewSessionScreenModel.prefetchMachineCapabilities' });
        }
    }, [params.capabilityServerId, params.machines, params.refreshMachineEnvPresence, params.selectedMachineId, params.selectedMachine, manualRefreshLifetime]);

    const { recentMachines: rawRecentMachines, favoriteMachineItems: rawFavoriteMachineItems } = React.useMemo(
        () => resolveNewSessionMachinePickerHistory({ machines: params.machines,
            recentMachinePaths: params.recentMachinePaths, favoriteMachineIds: params.favoriteMachines }),
        [params.machines, params.recentMachinePaths, params.favoriteMachines],
    );
    const recentMachinesSignature = React.useMemo(
        () => buildMachineRefreshListSignature(rawRecentMachines),
        [rawRecentMachines],
    );
    const recentMachines = useStableValueBySignature(rawRecentMachines, recentMachinesSignature);

    const favoriteMachineItemsSignature = React.useMemo(
        () => buildMachineRefreshListSignature(rawFavoriteMachineItems),
        [rawFavoriteMachineItems],
    );
    const favoriteMachineItems = useStableValueBySignature(rawFavoriteMachineItems, favoriteMachineItemsSignature);

    useNewSessionCapabilitiesPrefetch({
        enabled: wizardPrefetchDemanded,
        serverId: params.capabilityServerId,
        machines: params.machines,
        favoriteMachineItems,
        recentMachines,
        selectedMachineId: params.selectedMachineId,
        isMachineOnline: machineReachable,
        staleMs: 2 * 60 * 1000,
        request: CAPABILITIES_REQUEST_NEW_SESSION,
        prefetchMachineCapabilitiesIfStale,
    });

    const resolveRecentPaths = useStableRecentPathsResolver({
        recentMachinePaths: params.recentMachinePaths,
        sessions: params.sessions,
        cacheScopeKey: params.capabilityServerId,
    });
    const readRecentPaths = React.useCallback(() => resolveRecentPaths(params.selectedMachineId),
        [params.selectedMachineId, resolveRecentPaths]);
    const recentPaths = React.useMemo(readRecentPaths, [readRecentPaths]);

    return {
        refreshMachineData,
        recentMachines,
        favoriteMachineItems,
        recentPaths,
        readRecentPaths,
    };
}
