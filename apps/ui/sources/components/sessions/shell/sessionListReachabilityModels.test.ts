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
        const { buildSessionListReachabilitySummary } = await import('./buildSessionListReachabilitySummary');

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

        const summary = buildSessionListReachabilitySummary({
            listItems: [{ type: 'session', sessionId: 'session-1', serverId: 'server-a' } as any],
            machinesById: new Map<string, unknown>([
                [
                    'machine-stale',
                    { id: 'machine-stale', metadata: { host: 'same-host.local', displayName: 'Old Machine' } },
                ],
                [
                    'machine-live',
                    { id: 'machine-live', metadata: { host: 'same-host.local', displayName: 'Live Machine' } },
                ],
            ]),
            workspaceRefs: [],
            resolveSessionRenderable: () => ({ metadata: session.metadata } as any),
        });

        expect(summary.displayById.get('session-1')).toMatchObject({
            machineId: 'machine-stale',
            machineLabel: 'Old Machine',
            workspaceSubtitle: 'stable',
        });
    });
});
