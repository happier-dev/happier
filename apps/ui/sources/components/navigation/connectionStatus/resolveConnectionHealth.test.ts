import { describe, expect, it } from 'vitest';

import { resolveConnectionHealth } from './resolveConnectionHealth';

describe('resolveConnectionHealth', () => {
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
