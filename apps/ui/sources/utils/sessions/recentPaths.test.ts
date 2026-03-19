import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/sync/domains/state/storageTypes';

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

function createSession(input: Readonly<{
    id: string;
    machineId: string;
    path: string;
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
            path: input.path,
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

describe('getRecentPathsForMachine', () => {
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

    it('includes session paths that rebound to the requested machine through the canonical reachable target', async () => {
        const { getRecentPathsForMachine } = await import('./recentPaths');

        const session = createSession({
            id: 'session-1',
            machineId: 'machine-stale',
            path: '/Users/test/workspace/rebound',
            updatedAt: 25,
        });

        storageState = {
            ...storageState,
            sessions: {
                'session-1': {
                    active: true,
                    updatedAt: 25,
                    metadata: session.metadata,
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

        expect(getRecentPathsForMachine({
            machineId: 'machine-target',
            recentMachinePaths: [],
            sessions: [session],
        })).toEqual(['/Users/test/workspace/rebound']);
    });

    it('uses the canonical reachable base path when the stored session path is stale after handoff', async () => {
        const { getRecentPathsForMachine } = await import('./recentPaths');

        const session = createSession({
            id: 'session-1',
            machineId: 'machine-stale',
            path: '/Users/test/workspace/stale',
            updatedAt: 25,
        });

        storageState = {
            ...storageState,
            sessions: {
                'session-1': {
                    active: true,
                    updatedAt: 25,
                    metadata: session.metadata,
                },
            },
            getProjectForSession: (sessionId: string) =>
                sessionId === 'session-1'
                    ? {
                        key: {
                            machineId: 'machine-target',
                            path: '/Volumes/target/workspace/rebound',
                        },
                    }
                    : null,
        };

        expect(getRecentPathsForMachine({
            machineId: 'machine-target',
            recentMachinePaths: [],
            sessions: [session],
        })).toEqual(['/Volumes/target/workspace/rebound']);
    });

    it('uses the reachable target base path instead of stale session metadata paths after handoff', async () => {
        const { getRecentPathsForMachine } = await import('./recentPaths');

        const session = createSession({
            id: 'session-1',
            machineId: 'machine-stale',
            path: '/Users/test/workspace/stale-path',
            updatedAt: 25,
        });

        storageState = {
            ...storageState,
            sessions: {
                'session-1': {
                    active: true,
                    updatedAt: 25,
                    metadata: session.metadata,
                },
            },
            getProjectForSession: (sessionId: string) =>
                sessionId === 'session-1'
                    ? {
                        key: {
                            machineId: 'machine-target',
                            path: '/Users/test/workspace/live-path',
                        },
                    }
                    : null,
        };

        expect(getRecentPathsForMachine({
            machineId: 'machine-target',
            recentMachinePaths: [],
            sessions: [session],
        })).toEqual(['/Users/test/workspace/live-path']);
    });
});
