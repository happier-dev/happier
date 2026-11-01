import { describe, expect, it } from 'vitest';

import { installSessionUtilsCommonModuleMocks } from '@/utils/sessions/sessionUtilsTestHelpers';

type MockStorageState = {
    sessions?: Record<string, unknown>;
    machines?: Record<string, unknown>;
    getProjectForSession?: (sessionId: string) => { key?: { machineId?: string; path?: string } } | null;
};

let mockStorageState: MockStorageState = {};

installSessionUtilsCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => mockStorageState,
            },
        });
    },
});

describe('buildSessionListReachabilityModels', () => {
    it('uses stable display targets instead of live reachable daemon targets', async () => {
        const { buildSessionListReachabilityModels } = await import('./sessionListReachabilityModels');

        const session = {
            id: 'session-1',
            active: false,
            updatedAt: 10,
            metadata: {
                machineId: 'machine-stale',
                path: '/Users/test/workspace/stable',
                homeDir: '/Users/test',
                host: 'stale.local',
            },
        };
        mockStorageState = {
            sessions: {
                'session-1': session,
            },
            machines: {
                'machine-stale': {
                    id: 'machine-stale',
                    active: false,
                    activeAt: 1,
                    metadata: { host: 'same-host.local', displayName: 'Old Machine' },
                },
                'machine-live': {
                    id: 'machine-live',
                    active: true,
                    activeAt: 100,
                    metadata: { host: 'same-host.local', displayName: 'Live Machine' },
                },
            },
            getProjectForSession: (sessionId: string) =>
                sessionId === 'session-1'
                    ? { key: { machineId: 'machine-live', path: '/Users/test/workspace/live' } }
                    : null,
        };

        const models = buildSessionListReachabilityModels({
            items: [{ type: 'session', session, serverId: 'server-a' } as any],
            machinesById: {
                'machine-stale': {
                    id: 'machine-stale',
                    title: 'Old Machine',
                    subtitle: 'same-host.local',
                    metadata: { host: 'same-host.local', displayName: 'Old Machine' },
                } as any,
                'machine-live': {
                    id: 'machine-live',
                    title: 'Live Machine',
                    subtitle: 'same-host.local',
                    metadata: { host: 'same-host.local', displayName: 'Live Machine' },
                } as any,
            },
            workspaceLabelsByLabelKey: {},
        });

        expect(models.reachableSessionDisplayByKey.get('server-a:session-1')).toMatchObject({
            machineId: 'machine-stale',
            machineLabel: 'Old Machine',
            workspaceSubtitle: 'stable',
        });
    });

    it('reuses cached reachability rows when unrelated session rows refresh', async () => {
        const {
            buildSessionListReachabilityModels,
            createSessionListReachabilityModelsCache,
        } = await import('./sessionListReachabilityModels');

        mockStorageState = {
            sessions: {},
            machines: {},
            getProjectForSession: () => null,
        };
        const unchanged = {
            id: 'unchanged-session',
            active: false,
            updatedAt: 10,
            metadata: {
                machineId: 'machine-a',
                path: '/Users/test/workspace/unchanged',
                homeDir: '/Users/test',
                host: 'a.local',
            },
        };
        const refreshed = {
            id: 'refreshed-session',
            active: false,
            updatedAt: 10,
            metadata: {
                machineId: 'machine-a',
                path: '/Users/test/workspace/refreshed',
                homeDir: '/Users/test',
                host: 'a.local',
            },
        };
        const machinesById = {
            'machine-a': {
                id: 'machine-a',
                title: 'Machine A',
                subtitle: 'a.local',
                metadata: { host: 'a.local', displayName: 'Machine A' },
            } as any,
        };
        const workspaceLabelsByLabelKey = {};
        const cache = createSessionListReachabilityModelsCache();
        const first = buildSessionListReachabilityModels({
            cache,
            items: [
                { type: 'session', serverId: 'server-a', session: unchanged } as any,
                { type: 'session', serverId: 'server-a', session: refreshed } as any,
            ],
            machinesById,
            workspaceLabelsByLabelKey,
        });
        const unchangedDisplay = first.reachableSessionDisplayByKey.get('server-a:unchanged-session');
        const second = buildSessionListReachabilityModels({
            cache,
            items: [
                { type: 'session', serverId: 'server-a', session: unchanged } as any,
                {
                    type: 'session',
                    serverId: 'server-a',
                    session: { ...refreshed, updatedAt: 11 },
                } as any,
            ],
            machinesById,
            workspaceLabelsByLabelKey,
        });

        expect(second).not.toBe(first);
        expect(second.reachableSessionDisplayByKey.get('server-a:unchanged-session')).toBe(unchangedDisplay);
        expect(second.reachableSessionDisplayByKey.get('server-a:refreshed-session')).toMatchObject({
            machineId: 'machine-a',
            workspaceSubtitle: 'refreshed',
        });
    });

    it('reuses retained reachability models across a list remount', async () => {
        const {
            buildSessionListReachabilityModels,
            createSessionListReachabilityModelsCache,
        } = await import('./sessionListReachabilityModels');

        mockStorageState = {
            sessions: {},
            machines: {},
            getProjectForSession: () => null,
        };
        const items = [{
            type: 'session',
            serverId: 'server-a',
            session: {
                id: 'retained-session',
                metadata: {
                    machineId: 'machine-a',
                    path: '/Users/test/workspace/retained',
                    homeDir: '/Users/test',
                    host: 'a.local',
                },
            },
        }] as any;
        const machinesById = {
            'machine-a': {
                id: 'machine-a',
                title: 'Machine A',
                subtitle: 'a.local',
                metadata: { host: 'a.local', displayName: 'Machine A' },
            } as any,
        };
        const first = buildSessionListReachabilityModels({
            cache: createSessionListReachabilityModelsCache(),
            items,
            machinesById,
            workspaceLabelsByLabelKey: {},
        });
        const second = buildSessionListReachabilityModels({
            cache: createSessionListReachabilityModelsCache(),
            items,
            machinesById,
            workspaceLabelsByLabelKey: {},
        });

        expect(second).toBe(first);
    });

    it('keeps reachability display scoped when two visible servers share a session id', async () => {
        const { buildSessionListReachabilityModels } = await import('./sessionListReachabilityModels');

        mockStorageState = {
            sessions: {},
            machines: {},
            getProjectForSession: () => null,
        };

        const sharedSessionId = 'shared-session';
        const first = {
            id: sharedSessionId,
            active: false,
            updatedAt: 10,
            metadata: {
                machineId: 'machine-a',
                path: '/Users/test/workspace/a',
                homeDir: '/Users/test',
                host: 'a.local',
            },
        };
        const second = {
            ...first,
            metadata: {
                machineId: 'machine-b',
                path: '/Users/test/workspace/b',
                homeDir: '/Users/test',
                host: 'b.local',
            },
        };

        const models = buildSessionListReachabilityModels({
            items: [
                { type: 'session', serverId: 'server-a', session: first } as any,
                { type: 'session', serverId: 'server-b', session: second } as any,
            ],
            machinesById: {
                'machine-a': {
                    id: 'machine-a',
                    title: 'Machine A',
                    subtitle: 'a.local',
                    metadata: { host: 'a.local', displayName: 'Machine A' },
                } as any,
                'machine-b': {
                    id: 'machine-b',
                    title: 'Machine B',
                    subtitle: 'b.local',
                    metadata: { host: 'b.local', displayName: 'Machine B' },
                } as any,
            },
            workspaceLabelsByLabelKey: {},
        });

        expect(models.reachableSessionDisplayByKey.get('server-a:shared-session')).toMatchObject({
            machineId: 'machine-a',
            machineLabel: 'Machine A',
            workspaceSubtitle: 'a',
        });
        expect(models.reachableSessionDisplayByKey.get('server-b:shared-session')).toMatchObject({
            machineId: 'machine-b',
            machineLabel: 'Machine B',
            workspaceSubtitle: 'b',
        });
    });
});
