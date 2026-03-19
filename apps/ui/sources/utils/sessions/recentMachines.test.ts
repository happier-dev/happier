import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Machine, Session } from '@/sync/domains/state/storageTypes';

type StorageState = {
    sessions?: Record<string, unknown>;
    machines?: Record<string, unknown>;
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string; path?: string } } | null;
};

let storageState: StorageState = {};

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => storageState,
    },
}));

function createMachine(id: string): Machine {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        revokedAt: null,
        metadata: {
            host: `${id}.local`,
            platform: 'darwin',
            happyCliVersion: '0.0.0-test',
            happyHomeDir: '/tmp/.happier',
            homeDir: '/Users/test',
        },
        metadataVersion: 1,
        daemonState: null,
        daemonStateVersion: 1,
    };
}

function createSession(input: Readonly<{
    id: string;
    machineId: string;
    updatedAt?: number;
}>): Session {
    return {
        id: input.id,
        seq: 1,
        createdAt: 1,
        updatedAt: input.updatedAt ?? 1,
        active: true,
        activeAt: 1,
        metadata: {
            machineId: input.machineId,
            path: '/Users/test/workspace/rebound',
            homeDir: '/Users/test',
            host: 'host.local',
            flavor: 'claude',
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

describe('getRecentMachinesFromSessions', () => {
    beforeEach(() => {
        storageState = {
            sessions: {},
            machines: {
                'machine-target': {
                    id: 'machine-target',
                    active: true,
                    activeAt: 10,
                    metadata: { host: 'target.local' },
                },
            },
            getProjectForSession: () => null,
        };
    });

    it('includes machines selected through the canonical reachable target when session metadata is stale', async () => {
        const { getRecentMachinesFromSessions } = await import('./recentMachines');

        const targetMachine = createMachine('machine-target');
        const otherMachine = createMachine('machine-other');
        const reboundSession = createSession({
            id: 'session-1',
            machineId: 'machine-stale',
            updatedAt: 25,
        });

        storageState = {
            ...storageState,
            sessions: {
                'session-1': {
                    active: true,
                    updatedAt: 25,
                    metadata: reboundSession.metadata,
                },
            },
            getProjectForSession: (sessionId: string) =>
                sessionId === 'session-1'
                    ? {
                        key: {
                            machineId: 'machine-target',
                            path: '/Users/test/workspace/rebound',
                        },
                    }
                    : null,
        };

        expect(getRecentMachinesFromSessions({
            machines: [otherMachine, targetMachine],
            sessions: [reboundSession],
        })).toEqual([targetMachine]);
    });
});
