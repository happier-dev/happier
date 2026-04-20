import { computeMachinesSummary } from '@/components/sessions/guidance/gettingStartedModel';

import type {
    ConnectionHealth,
    ConnectionHealthMachineGroup,
    ConnectionSocketStatus,
} from './connectionHealthTypes';

type ConnectionEndpointStatus =
    | 'idle'
    | 'offline'
    | 'connecting'
    | 'online'
    | 'auth_failed'
    | 'shutting_down';
type ConnectionSyncErrorKind = 'auth' | 'config' | 'network' | 'server' | 'unknown';

export function resolveConnectionHealth(params: Readonly<{
    socketStatus: ConnectionSocketStatus;
    endpointStatus?: ConnectionEndpointStatus;
    hasSyncError?: boolean;
    syncErrorKind?: ConnectionSyncErrorKind;
    machineGroups: ReadonlyArray<ConnectionHealthMachineGroup>;
}>): ConnectionHealth {
    let hasUnknownReadyCount = false;
    let readyCount = 0;
    const machines = computeMachinesSummary(
        params.machineGroups.map((group) => ({
            machineCount: group.machineCount,
            onlineCount: group.onlineCount,
        })),
    );

    for (const group of params.machineGroups) {
        const onlineCount = group.onlineCount;
        const groupReadyCount = group.readyCount === undefined ? onlineCount : group.readyCount;
        if (onlineCount === null || groupReadyCount === null) {
            hasUnknownReadyCount = true;
            continue;
        }
        readyCount += groupReadyCount;
    }

    const hasUnknownMachines = machines.hasUnknownServers || hasUnknownReadyCount;

    if (params.endpointStatus === 'connecting' && params.socketStatus !== 'connected') {
        return {
            kind: 'connecting',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines,
            socketStatus: params.socketStatus,
        };
    }

    if (params.endpointStatus === 'auth_failed') {
        return {
            kind: 'auth_required',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines,
            socketStatus: params.socketStatus,
        };
    }

    if (params.endpointStatus === 'offline' || params.endpointStatus === 'shutting_down') {
        return {
            kind: 'server_unreachable',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines,
            socketStatus: params.socketStatus,
        };
    }

    if (params.syncErrorKind === 'auth') {
        return {
            kind: 'auth_required',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines,
            socketStatus: params.socketStatus,
        };
    }

    if (params.hasSyncError || params.socketStatus === 'error') {
        return {
            kind: 'server_error',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines,
            socketStatus: params.socketStatus,
        };
    }

    if (params.socketStatus === 'connecting') {
        return {
            kind: 'connecting',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines,
            socketStatus: params.socketStatus,
        };
    }

    if (params.socketStatus !== 'connected') {
        return {
            kind: 'server_unreachable',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines,
            socketStatus: params.socketStatus,
        };
    }

    if (machines.machineCount === 0 && machines.hasUnknownServers) {
        return {
            kind: 'connecting',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines,
            socketStatus: params.socketStatus,
        };
    }

    if (machines.machineCount === 0) {
        return {
            kind: 'no_machine',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines,
            socketStatus: params.socketStatus,
        };
    }

    if (machines.onlineCount === 0) {
        return {
            kind: 'machine_offline',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines,
            socketStatus: params.socketStatus,
        };
    }

    if (!hasUnknownMachines && readyCount < machines.onlineCount) {
        return {
            kind: 'machine_not_ready',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines,
            socketStatus: params.socketStatus,
        };
    }

    return {
        kind: 'healthy',
        machineCount: machines.machineCount,
        onlineCount: machines.onlineCount,
        hasUnknownMachines,
        socketStatus: params.socketStatus,
    };
}
