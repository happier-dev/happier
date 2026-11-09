import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useActiveSelectionMachineGroups } from '@/components/settings/machines/hooks/useActiveSelectionMachineGroups';
import { listServerProfiles } from '@/sync/domains/server/serverProfiles';
import { selectSyncErrorForServer } from '@/sync/runtime/connectivity/syncErrorScope';
import {
    getStorage,
    useMachineListStatusByServerId,
    useMachineListStatusForServer,
    useEndpointConnectivity,
    useSocketStatus,
    useSyncError,
    useActiveMachineFacts,
    useMachineListByServerId,
} from '@/sync/domains/state/storage';
import {
    getAppliedActiveServerSnapshot,
    isAppliedActiveServerRuntimeAvailable,
    subscribeAppliedActiveServer,
    subscribeAppliedActiveServerRuntimeAvailability,
} from '@/sync/runtime/orchestration/connectionManager';
import { useHomeViewSelectionSettings } from '@/hooks/server/useHomeViewSelectionSettings';
import { resolveMachineReachability, type MachineReachabilityScope } from '@/sync/domains/machines/reachability/machineReachability';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceSnapshot } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { resolveServerScopedMachines } from '@/sync/domains/machines/resolveServerScopedMachines';
import { isMachineVisibleForSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { captureServerProfileScopeResolver } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

import { resolveConnectionHealthPresentation } from './connectionHealthPresentation';
import { resolveConnectionHealth } from './resolveConnectionHealth';

function isMachineReadyForConnectionHealth(machine: Readonly<{ daemonState?: unknown }>): boolean {
    const daemonState = machine.daemonState;
    if (!daemonState || typeof daemonState !== 'object') {
        return true;
    }
    const status = (daemonState as { status?: unknown }).status;
    if (typeof status !== 'string') {
        return true;
    }
    return status === 'running';
}

function resolveObservedMachinePresence(machines: readonly Machine[], scope: MachineReachabilityScope | null | undefined, nowMs: number) {
    const onlineMachines: Machine[] = [];
    let unknownCount = 0;
    for (const machine of machines) {
        const reachability = resolveMachineReachability(scope, machine, nowMs);
        if (reachability === 'reachable') onlineMachines.push(machine);
        else if (reachability === 'unknown') unknownCount += 1;
    }
    return { onlineMachines, unknownCount };
}

export function useConnectionHealth() {
    const { theme } = useUnistyles();
    const socketStatus = useSocketStatus();
    const endpointConnectivity = useEndpointConnectivity();
    const syncError = useSyncError();
    const allMachines = useActiveMachineFacts();
    const machineListByServerId = useMachineListByServerId();
    const machineListStatusByServerId = useMachineListStatusByServerId();
    const {
        serverSelectionGroups,
        serverSelectionActiveTargetKind,
        serverSelectionActiveTargetId,
    } = useHomeViewSelectionSettings();

    const activeServerSnapshot = useActiveServerSnapshot();
    const serverProfiles = React.useMemo(() => {
        try {
            return listServerProfiles().slice();
        } catch {
            return [];
        }
    }, [activeServerSnapshot.generation]);

    const activeSelectionMachineGroups = useActiveSelectionMachineGroups({
        activeServerSnapshot,
        allMachines,
        serverProfiles,
        machineListByServerId,
        machineListStatusByServerId,
        settings: {
            serverSelectionGroups,
            serverSelectionActiveTargetKind,
            serverSelectionActiveTargetId,
        },
    });
    const reachabilityRevision = useMachineReachabilityRevision();
    const presenceNowMs = useMachinePresenceNowMs(activeSelectionMachineGroups.visibleMachineGroups.flatMap(group => group.machines));
    const activeSyncError = React.useMemo(() => {
        return selectSyncErrorForServer(syncError, activeServerSnapshot.serverId);
    }, [activeServerSnapshot.serverId, syncError]);

    const primaryMachineLabel = React.useMemo(() => {
        const byId = new Map<string, (typeof activeSelectionMachineGroups.visibleMachineGroups)[number]['machines'][number]>();
        for (const group of activeSelectionMachineGroups.visibleMachineGroups) {
            if (group.status === 'loading' || group.status === 'signedOut') continue;
            for (const machine of group.machines) {
                if (machine.revokedAt) continue;
                byId.set(machine.id, machine);
            }
        }
        if (byId.size !== 1) return null;
        const machine = [...byId.values()][0] ?? null;
        const metadata = machine?.metadata && typeof machine.metadata === 'object' ? machine.metadata as { displayName?: unknown; host?: unknown } : null;
        const displayName = typeof metadata?.displayName === 'string' ? metadata.displayName.trim() : '';
        if (displayName) return displayName;
        const host = typeof metadata?.host === 'string' ? metadata.host.trim() : '';
        if (host) return host;
        return machine?.id ?? null;
    }, [activeSelectionMachineGroups.visibleMachineGroups]);

    const health = React.useMemo(() => {
        return resolveConnectionHealth({
            socketStatus: socketStatus.status,
            endpointStatus: endpointConnectivity.status,
            endpointReason: endpointConnectivity.reason,
            hasSyncError: Boolean(activeSyncError),
            syncErrorKind: activeSyncError?.kind,
            machineGroups: activeSelectionMachineGroups.visibleMachineGroups.map((group) => {
                if (group.status === 'loading' || group.status === 'signedOut') {
                    return {
                        machineCount: null,
                        onlineCount: null,
                        status: group.status,
                    };
                }

                const visibleMachines = group.machines.filter((machine) => !machine.revokedAt);
                const scope = group.accountScope;
                const { onlineMachines, unknownCount } = resolveObservedMachinePresence(visibleMachines, scope, presenceNowMs);
                return {
                    machineCount: visibleMachines.length,
                    onlineCount: onlineMachines.length,
                    unknownCount,
                    readyCount: onlineMachines.filter((machine) => isMachineSelectableForFleet(scope, machine, presenceNowMs) && isMachineReadyForConnectionHealth(machine)).length,
                    status: group.status,
                };
            }),
        });
    }, [
        activeSelectionMachineGroups.visibleMachineGroups,
        reachabilityRevision,
        presenceNowMs,
        activeSyncError,
        endpointConnectivity.reason,
        endpointConnectivity.status,
        socketStatus.status,
    ]);

    const presentation = React.useMemo(() => {
        return resolveConnectionHealthPresentation(health, {
            connected: theme.colors.status.connected,
            connecting: theme.colors.status.connecting,
            actionRequired: theme.colors.status.actionRequired,
            disconnected: theme.colors.status.disconnected,
            error: theme.colors.status.error,
            default: theme.colors.status.default,
        });
    }, [health, theme.colors.status]);

    return {
        ...health,
        ...presentation,
        primaryMachineLabel,
        endpointStatus: endpointConnectivity.status,
    };
}

type AppliedHomeMachineFacts = Readonly<{
    machineCount: number;
    onlineCount: number;
    unknownCount: number;
    readyCount: number;
    primaryMachineLabel: string | null;
}>;

function areAppliedHomeMachineFactsEqual(left: AppliedHomeMachineFacts, right: AppliedHomeMachineFacts): boolean {
    return left.machineCount === right.machineCount && left.onlineCount === right.onlineCount
        && left.unknownCount === right.unknownCount && left.readyCount === right.readyCount
        && left.primaryMachineLabel === right.primaryMachineLabel;
}

function readPrimaryMachineLabel(machine: Machine | undefined): string | null {
    const metadata = machine?.metadata && typeof machine.metadata === 'object'
        ? machine.metadata as { displayName?: unknown; host?: unknown }
        : null;
    const displayName = typeof metadata?.displayName === 'string' ? metadata.displayName.trim() : '';
    if (displayName) return displayName;
    const host = typeof metadata?.host === 'string' ? metadata.host.trim() : '';
    return host || machine?.id || null;
}

/**
 * What the always-mounted health chrome shows of the applied Home's Machines: counts and one name.
 * A daemon heartbeat rewrites the Machine row (activity time, daemon state) without changing any of
 * them, so the facts are projected once per source change and republished only when one differs.
 */
function useAppliedHomeMachineFacts(serverId: string, accountScope: ServerAccountScope | null): AppliedHomeMachineFacts {
    const readMachines = React.useCallback((): readonly Machine[] => {
        const state = getStorage().getState();
        const machines = resolveServerScopedMachines<Machine>({
            serverId,
            activeServerId: serverId,
            get activeMachines() { return Object.values(state.machines); },
            machineListByServerId: state.machineListByServerId,
            machineListStatusByServerId: state.machineListStatusByServerId,
        }, captureServerProfileScopeResolver());
        return (machines ?? []).filter(isMachineVisibleForSelection);
    }, [serverId]);
    const published = React.useRef<AppliedHomeMachineFacts | null>(null);
    const readSnapshot = React.useCallback((nowMs: number): AppliedHomeMachineFacts => {
        const visible = readMachines().filter(machine => !machine.revokedAt);
        const { onlineMachines, unknownCount } = resolveObservedMachinePresence(visible, accountScope, nowMs);
        const next: AppliedHomeMachineFacts = {
            machineCount: visible.length,
            onlineCount: onlineMachines.length,
            unknownCount,
            readyCount: onlineMachines.filter(machine => isMachineSelectableForFleet(accountScope, machine, nowMs)
                && isMachineReadyForConnectionHealth(machine)).length,
            primaryMachineLabel: visible.length === 1 ? readPrimaryMachineLabel(visible[0]) : null,
        };
        if (published.current === null || !areAppliedHomeMachineFactsEqual(published.current, next)) published.current = next;
        return published.current;
    }, [accountScope, readMachines]);
    const targets = React.useMemo(() => [{ serverId }], [serverId]);
    return useMachinePresenceSnapshot(readMachines, readSnapshot, targets);
}

/**
 * Active-Home-only health for always-mounted shell chrome. Unlike the
 * selection-wide hook above, this does not derive health from staged focus or
 * Home-view selection settings; it reads the applied Home's scoped projection.
 */
export function useActiveHomeConnectionHealth() {
    const { theme } = useUnistyles();
    const socketStatus = useSocketStatus();
    const endpointConnectivity = useEndpointConnectivity();
    const syncError = useSyncError();
    const subscribeAppliedServer = React.useCallback(
        (listener: () => void) => subscribeAppliedActiveServer(() => listener()),
        [],
    );
    const appliedServerSnapshot = React.useSyncExternalStore(
        subscribeAppliedServer,
        getAppliedActiveServerSnapshot,
        getAppliedActiveServerSnapshot,
    );
    const appliedServerId = appliedServerSnapshot.serverId;
    const { binding } = useServerCredentialAccountScopeBinding(appliedServerId);
    const accountScope = binding?.isCurrent() ? binding.scope : null;
    const machineFacts = useAppliedHomeMachineFacts(appliedServerId, accountScope);
    const machineListStatus = useMachineListStatusForServer(appliedServerId);
    const subscribeAppliedRuntime = React.useCallback(
        (listener: () => void) => subscribeAppliedActiveServerRuntimeAvailability(() => listener()),
        [],
    );
    const appliedServerRuntimeAvailable = React.useSyncExternalStore(
        subscribeAppliedRuntime,
        isAppliedActiveServerRuntimeAvailable,
        isAppliedActiveServerRuntimeAvailable,
    );
    const isAppliedHomeTransitioning = !appliedServerRuntimeAvailable;
    const activeSyncError = React.useMemo(() => (
        selectSyncErrorForServer(syncError, appliedServerId)
    ), [appliedServerId, syncError]);

    const health = React.useMemo(() => resolveConnectionHealth({
        // Socket and endpoint status are singleton transport projections. The
        // connection manager's runtime-availability fact is the authority for
        // whether they can be attributed to the applied Home.
        socketStatus: isAppliedHomeTransitioning ? 'connecting' : socketStatus.status,
        endpointStatus: isAppliedHomeTransitioning ? 'connecting' : endpointConnectivity.status,
        endpointReason: isAppliedHomeTransitioning ? null : endpointConnectivity.reason,
        hasSyncError: Boolean(activeSyncError),
        syncErrorKind: activeSyncError?.kind,
        machineGroups: [{
            ...(machineListStatus === 'loading' || machineListStatus === 'signedOut'
                ? {
                    machineCount: null,
                    onlineCount: null,
                }
                : {
                    machineCount: machineFacts.machineCount,
                    onlineCount: machineFacts.onlineCount,
                    unknownCount: machineFacts.unknownCount,
                    readyCount: machineFacts.readyCount,
                }),
            status: machineListStatus,
        }],
    }), [
        activeSyncError,
        endpointConnectivity.reason,
        endpointConnectivity.status,
        isAppliedHomeTransitioning,
        machineListStatus,
        machineFacts,
        socketStatus.status,
    ]);
    const presentation = React.useMemo(() => resolveConnectionHealthPresentation(health, {
        connected: theme.colors.status.connected,
        connecting: theme.colors.status.connecting,
        actionRequired: theme.colors.status.actionRequired,
        disconnected: theme.colors.status.disconnected,
        error: theme.colors.status.error,
        default: theme.colors.status.default,
    }), [health, theme.colors.status]);

    return {
        ...health,
        ...presentation,
        primaryMachineLabel: machineFacts.primaryMachineLabel,
        endpointStatus: isAppliedHomeTransitioning ? 'connecting' : endpointConnectivity.status,
        nextRetryAt: isAppliedHomeTransitioning ? null : endpointConnectivity.nextRetryAt,
    };
}
