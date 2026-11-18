import { computeMachinesSummary } from '@/components/sessions/guidance/computeMachinesSummary';
import { presentSocketStatus } from '@/sync/api/session/socketStatusPresentation';

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
type ConnectionEndpointReason = 'server_restarting' | string | null;

export function resolveConnectionHealth(input: Readonly<{
    /** `paused`: the applied socket's intentional visibility pause, presented as reconnecting until it settles. */
    socketStatus: ConnectionSocketStatus | 'paused';
    endpointStatus?: ConnectionEndpointStatus;
    endpointReason?: ConnectionEndpointReason;
    hasSyncError?: boolean;
    syncErrorKind?: ConnectionSyncErrorKind;
    machineGroups: ReadonlyArray<ConnectionHealthMachineGroup>;
}>): ConnectionHealth {
    const params = { ...input, socketStatus: input.socketStatus === 'idle' ? input.socketStatus : presentSocketStatus(input.socketStatus) };
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

    const hasUnknownMachines = machines.hasUnknownServers || hasUnknownReadyCount
        || params.machineGroups.some(group => (group.unknownCount ?? 0) > 0);

    if (
        params.endpointReason === 'server_restarting'
        && (params.endpointStatus === 'offline' || params.endpointStatus === 'connecting')
    ) {
        return {
            kind: 'server_restarting',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines,
            socketStatus: params.socketStatus,
        };
    }

    if ((params.endpointStatus === 'connecting' || params.endpointStatus === 'idle') && params.socketStatus !== 'connected') {
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

    if (params.syncErrorKind === 'auth' || params.machineGroups.some((group) => group.status === 'signedOut')) {
        return {
            kind: 'auth_required',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines,
            socketStatus: params.socketStatus,
        };
    }

    // A background sync failure is not a transport verdict. Current endpoint
    // and socket success supersede it; auth and failed Home reads stay actionable.
    if ((params.hasSyncError && !(params.endpointStatus === 'online' && params.socketStatus === 'connected'))
        || params.socketStatus === 'error' || params.machineGroups.some((group) => group.status === 'error')) {
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
            // When canonical readiness is available, an unopened/reconnecting
            // realtime socket cannot contradict its successful Home verdict.
            kind: params.endpointStatus === 'online' ? 'connecting' : 'server_unreachable',
            machineCount: machines.machineCount,
            onlineCount: machines.onlineCount,
            hasUnknownMachines,
            socketStatus: params.socketStatus,
        };
    }

    if (machines.machineCount === 0 && machines.hasUnknownServers) {
        return {
            // The Home census owns settlement. Narrow health readers need not
            // subscribe to Machine details to observe that it has completed.
            kind: params.machineGroups.every(group => group.status === 'idle') ? 'machine_unknown' : 'connecting',
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
            kind: hasUnknownMachines ? 'machine_unknown' : 'machine_offline',
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
