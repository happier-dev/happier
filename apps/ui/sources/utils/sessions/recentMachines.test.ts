import { beforeEach, describe, expect, it } from 'vitest';

import { installSessionUtilsCommonModuleMocks } from './sessionUtilsTestHelpers';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';

type StorageState = {
    sessions?: Record<string, unknown>;
    machines?: Record<string, unknown>;
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string; path?: string } } | null;
};

let storageState: StorageState = {};

installSessionUtilsCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => storageState,
            },
        });
    },
});

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

    it('does not include a same-host machine when session metadata has no explicit replacement', async () => {
        const { getRecentMachinesFromSessions } = await import('./recentMachines');

        const targetMachine = createMachine('machine-target');
        const otherMachine = createMachine('machine-other');
        const reboundSession = createSession({
            id: 'session-1',
            machineId: 'machine-other',
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
                            machineId: 'machine-other',
                            path: '/Users/test/workspace/rebound',
                        },
                    }
                    : null,
        };

        expect(getRecentMachinesFromSessions({
            machines: [otherMachine, targetMachine],
            sessions: [reboundSession],
        })).toEqual([otherMachine]);
    });

    it('includes the current machine for sessions from explicitly replaced machines', async () => {
        const { getRecentMachinesFromSessions } = await import('./recentMachines');

        const targetMachine = createMachine('machine-target');
        const oldMachine = {
            ...createMachine('machine-old'),
            active: false,
            replacedByMachineId: 'machine-target',
            replacedAt: 100,
            replacementReason: 'manual_repair',
            replacementSource: 'manual',
        };
        const reboundSession = createSession({
            id: 'session-1',
            machineId: 'machine-old',
            updatedAt: 25,
        });

        storageState = {
            ...storageState,
            machines: {
                'machine-old': oldMachine,
                'machine-target': targetMachine,
            },
            sessions: {
                'session-1': {
                    active: false,
                    updatedAt: 25,
                    metadata: reboundSession.metadata,
                },
            },
            getProjectForSession: () => null,
        };

        expect(getRecentMachinesFromSessions({
            machines: [oldMachine, targetMachine],
            sessions: [reboundSession],
        })).toEqual([targetMachine]);
    });
});
