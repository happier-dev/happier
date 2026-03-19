import { describe, expect, it } from 'vitest';

import { resolveConnectionHealth } from './resolveConnectionHealth';

describe('resolveConnectionHealth', () => {
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

    it('returns server_unreachable when the socket is disconnected even if machines exist', () => {
        const result = resolveConnectionHealth({
            socketStatus: 'disconnected',
            machineGroups: [{ machineCount: 2, onlineCount: 2, status: 'idle' }],
        });

        expect(result.kind).toBe('server_unreachable');
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
