import { describe, expect, it } from 'vitest';

import { resolveConnectionHealth } from './resolveConnectionHealth';

describe('resolveConnectionHealth', () => {
    it('keeps a failed Home read unhealthy despite a connected socket and retained online machines, then recovers', () => {
        const retainedMachines = { machineCount: 2, onlineCount: 2, readyCount: 2 };
        const connection = { endpointStatus: 'online' as const, socketStatus: 'connected' as const };

        const failed = resolveConnectionHealth({
            ...connection,
            machineGroups: [{ ...retainedMachines, status: 'error' }],
        });
        expect(failed.kind).toBe('server_error');
        expect(failed.machineCount).toBe(2);
        expect(failed.onlineCount).toBe(2);

        const recovered = resolveConnectionHealth({
            ...connection,
            machineGroups: [{ ...retainedMachines, status: 'idle' }],
        });
        expect(recovered.kind).toBe('healthy');
    });

    it('requires sign-in when the Home projection is signed out despite retained transport and machine facts', () => {
        expect(resolveConnectionHealth({
            endpointStatus: 'online',
            socketStatus: 'connected',
            machineGroups: [{ machineCount: 2, onlineCount: 2, status: 'signedOut' }],
        }).kind).toBe('auth_required');
    });

    it('treats endpoint shutting_down as server_unreachable even if the socket is connected', () => {
        const result = resolveConnectionHealth({
            endpointStatus: 'shutting_down',
            socketStatus: 'connected',
            machineGroups: [{ machineCount: 2, onlineCount: 2, status: 'idle' }],
        });

        expect(result.kind).toBe('server_unreachable');
    });

    it('treats endpoint connecting as connecting even when the socket is disconnected', () => {
        const result = resolveConnectionHealth({
            endpointStatus: 'connecting',
            socketStatus: 'disconnected',
            machineGroups: [{ machineCount: 0, onlineCount: 0, status: 'idle' }],
        });

        expect(result.kind).toBe('connecting');
    });

    it('shows loading during a pending initial Home probe, not an outage from an unopened socket', () => {
        expect(resolveConnectionHealth({
            endpointStatus: 'idle',
            socketStatus: 'disconnected',
            machineGroups: [{ machineCount: 0, onlineCount: null, status: 'loading' }],
        }).kind).toBe('connecting');
    });

    it('keeps a reachable Home loading while its socket reconnects', () => {
        expect(resolveConnectionHealth({
            endpointStatus: 'online',
            socketStatus: 'disconnected',
            machineGroups: [{ machineCount: 2, onlineCount: 2, status: 'idle' }],
        }).kind).toBe('connecting');
    });

    it('returns no_machine when the server is connected and there are no machines', () => {
        const result = resolveConnectionHealth({
            socketStatus: 'connected',
            machineGroups: [{ machineCount: 0, onlineCount: 0, status: 'idle' }],
        });

        expect(result.kind).toBe('no_machine');
    });

    it('returns machine_offline when machines exist but none are online', () => {
        const result = resolveConnectionHealth({
            socketStatus: 'connected',
            machineGroups: [{ machineCount: 2, onlineCount: 0, status: 'idle' }],
        });

        expect(result.kind).toBe('machine_offline');
    });

    it('returns healthy when at least one machine is online', () => {
        const result = resolveConnectionHealth({
            socketStatus: 'connected',
            machineGroups: [{ machineCount: 2, onlineCount: 1, status: 'idle' }],
        });

        expect(result.kind).toBe('healthy');
    });

    it('returns machine_not_ready when machines are online but not ready', () => {
        const result = resolveConnectionHealth({
            socketStatus: 'connected',
            machineGroups: [{ machineCount: 2, onlineCount: 2, readyCount: 1, status: 'idle' }],
        });

        expect(result.kind).toBe('machine_not_ready');
    });

    it('returns server_unreachable when the socket is disconnected even if machines exist', () => {
        const result = resolveConnectionHealth({
            socketStatus: 'disconnected',
            machineGroups: [{ machineCount: 2, onlineCount: 2, status: 'idle' }],
        });

        expect(result.kind).toBe('server_unreachable');
    });

    it('treats planned server restarts as a neutral reconnect while preserving known machines', () => {
        const result = resolveConnectionHealth({
            endpointStatus: 'offline',
            endpointReason: 'server_restarting',
            socketStatus: 'disconnected',
            machineGroups: [{ machineCount: 2, onlineCount: 2, status: 'idle' }],
        });

        expect(result.kind).toBe('server_restarting');
        expect(result.machineCount).toBe(2);
        expect(result.onlineCount).toBe(2);
        expect(result.hasUnknownMachines).toBe(false);
    });

    it('returns auth_required for terminal auth sync errors before generic server errors', () => {
        const result = resolveConnectionHealth({
            socketStatus: 'error',
            syncErrorKind: 'auth',
            hasSyncError: true,
            machineGroups: [{ machineCount: 2, onlineCount: 2, status: 'idle' }],
        });

        expect(result.kind).toBe('auth_required');
    });

    it('aggregates machine groups for multi-server selections', () => {
        const result = resolveConnectionHealth({
            socketStatus: 'connected',
            machineGroups: [
                { machineCount: 0, onlineCount: 0, status: 'idle' },
                { machineCount: 1, onlineCount: 1, status: 'idle' },
            ],
        });

        expect(result.kind).toBe('healthy');
        expect(result.machineCount).toBe(1);
        expect(result.onlineCount).toBe(1);
    });
});
