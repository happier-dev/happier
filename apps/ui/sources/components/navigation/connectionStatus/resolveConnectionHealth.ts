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

export function resolveConnectionHealth(params: Readonly<{
    socketStatus: ConnectionSocketStatus;
    endpointStatus?: ConnectionEndpointStatus;
    hasSyncError?: boolean;
    machineGroups: ReadonlyArray<ConnectionHealthMachineGroup>;
}>): ConnectionHealth {
    const machines = computeMachinesSummary(
        params.machineGroups.map((group) => ({
            machineCount: group.machineCount,
            onlineCount: group.onlineCount,
        })),
    );

    if (params.endpointStatus === 'connecting' && params.socketStatus !== 'connected') {
        return {
            kind: 'connecting',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines: machines.hasUnknownServers,
            socketStatus: params.socketStatus,
        };
    }

    if (params.endpointStatus === 'auth_failed') {
        return {
            kind: 'auth_required',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines: machines.hasUnknownServers,
            socketStatus: params.socketStatus,
        };
    }

    if (params.endpointStatus === 'offline' || params.endpointStatus === 'shutting_down') {
        return {
            kind: 'server_unreachable',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines: machines.hasUnknownServers,
            socketStatus: params.socketStatus,
        };
    }

    if (params.hasSyncError || params.socketStatus === 'error') {
        return {
            kind: 'server_error',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines: machines.hasUnknownServers,
            socketStatus: params.socketStatus,
        };
    }

    if (params.socketStatus === 'connecting') {
        return {
            kind: 'connecting',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines: machines.hasUnknownServers,
            socketStatus: params.socketStatus,
        };
    }

    if (params.socketStatus !== 'connected') {
        return {
            kind: 'server_unreachable',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines: machines.hasUnknownServers,
            socketStatus: params.socketStatus,
        };
    }

    if (machines.machineCount === 0 && machines.hasUnknownServers) {
        return {
            kind: 'connecting',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines: machines.hasUnknownServers,
            socketStatus: params.socketStatus,
        };
    }

    if (machines.machineCount === 0) {
        return {
            kind: 'no_machine',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines: machines.hasUnknownServers,
            socketStatus: params.socketStatus,
        };
    }

    if (machines.onlineCount === 0) {
        return {
            kind: 'machine_offline',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines: machines.hasUnknownServers,
            socketStatus: params.socketStatus,
        };
    }

    return {
        kind: 'healthy',
        machineCount: machines.machineCount,
        onlineCount: machines.onlineCount,
        hasUnknownMachines: machines.hasUnknownServers,
        socketStatus: params.socketStatus,
    };
}
