import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installVoiceToolActionImplCommonModuleMocks } from './voiceToolActionImplTestHelpers';

const voiceTargetState = {
    scope: 'global' as 'global' | 'session',
    primaryActionSessionId: null as string | null,
    lastFocusedSessionId: null as string | null,
};

const state: any = {
    sessions: {
        s1: {
            id: 's1',
            active: true,
            presence: 'online',
            updatedAt: 1000,
            metadata: {
                machineId: 'm1',
                path: '/Users/leeroy/projects/happier',
            },
        },
    },
    machines: {
        m1: {
            id: 'm1',
            metadata: { displayName: 'Leeroy MacBook Pro', host: 'leeroy-mbp' },
        },
    },
    settings: {
        voice: {
            privacy: {
                shareDeviceInventory: true,
                shareFilePaths: false,
            },
        },
        recentMachinePaths: [
            { machineId: 'm1', path: '/Users/leeroy/projects/happier' },
        ],
    },
    getProjectForSession: () => null,
};

installVoiceToolActionImplCommonModuleMocks({
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => state,
            } as typeof import('@/sync/domains/state/storage').storage,
        });
    },
});

vi.mock('@/voice/runtime/voiceTargetStore', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/voice/runtime/voiceTargetStore')>()),
    useVoiceTargetStore: {
        getState: () => voiceTargetState,
    },
}));

describe('listRecentPathsForVoiceTool', () => {
    beforeEach(() => {
        voiceTargetState.scope = 'global';
        voiceTargetState.primaryActionSessionId = null;
        voiceTargetState.lastFocusedSessionId = null;
        state.sessions = {
            s1: {
                id: 's1',
                active: true,
                presence: 'online',
                updatedAt: 1000,
                metadata: {
                    machineId: 'm1',
                    path: '/Users/leeroy/projects/happier',
                },
            },
        };
        state.machines = {
            m1: {
                id: 'm1',
                metadata: { displayName: 'Leeroy MacBook Pro', host: 'leeroy-mbp' },
            },
        };
        state.settings.voice.privacy.shareDeviceInventory = true;
        state.settings.voice.privacy.shareFilePaths = false;
        state.settings.recentMachinePaths = [{ machineId: 'm1', path: '/Users/leeroy/projects/happier' }];
        state.getProjectForSession = () => null;
    });

    it('returns redacted labels without workspace handles when file paths are hidden', async () => {
        const { listRecentPathsForVoiceTool } = await import('./pathsListRecent');

        const result: any = await listRecentPathsForVoiceTool({ limit: 10 });

        expect(result).toMatchObject({
            items: [
                {
                    label: 'happier — Leeroy MacBook Pro',
                    lastUsedAt: 1000,
                },
            ],
        });
        expect(result.items[0]).not.toHaveProperty('workspaceId');
        expect(result.items[0]).not.toHaveProperty('path');
    });

    it('still redacts labels when a raw voice privacy blob tries to enable file path sharing', async () => {
        state.settings.voice.privacy.shareFilePaths = true;
        const { listRecentPathsForVoiceTool } = await import('./pathsListRecent');

        const result: any = await listRecentPathsForVoiceTool({ limit: 10 });

        expect(result).toMatchObject({
            items: [
                {
                    label: 'happier — Leeroy MacBook Pro',
                    lastUsedAt: 1000,
                },
            ],
        });
        expect(result.items[0]).not.toHaveProperty('workspaceId');
        expect(result.items[0]).not.toHaveProperty('machineId');
        expect(result.items[0]).not.toHaveProperty('path');
    });

    it('resolves the default machine and lastUsedAt from an explicit replacement target even when raw path sharing is force-enabled', async () => {
        voiceTargetState.primaryActionSessionId = 's1';
        state.sessions = {
            s1: {
                id: 's1',
                active: true,
                presence: 'online',
                updatedAt: 1000,
                metadata: {
                    machineId: 'm-stale',
                    path: '/Users/leeroy/projects/happier',
                    homeDir: '/Users/leeroy',
                    host: 'old-host',
                },
            },
        };
        state.machines = {
            'm-stale': {
                id: 'm-stale',
                active: false,
                replacedByMachineId: 'm1',
                metadata: { displayName: 'Old Machine', host: 'old-host' },
            },
            m1: {
                id: 'm1',
                active: true,
                activeAt: 10,
                metadata: { displayName: 'Leeroy MacBook Pro', host: 'leeroy-mbp' },
            },
        };
        state.settings.voice.privacy.shareFilePaths = true;
        state.settings.recentMachinePaths = [];
        state.getProjectForSession = () => null;

        const { listRecentPathsForVoiceTool } = await import('./pathsListRecent');

        const result: any = await listRecentPathsForVoiceTool({ limit: 10 });

        expect(result).toMatchObject({
            items: [
                {
                    label: 'happier — Leeroy MacBook Pro',
                    lastUsedAt: 1000,
                },
            ],
        });
        expect(result.items[0]).not.toHaveProperty('machineId');
        expect(result.items[0]).not.toHaveProperty('path');
    });

    it('does not route a session-scoped inventory read through a stale global target', async () => {
        voiceTargetState.scope = 'session';
        voiceTargetState.primaryActionSessionId = 'stale-global-session';
        state.sessions = {
            'stale-global-session': {
                id: 'stale-global-session',
                active: true,
                presence: 'online',
                updatedAt: 2000,
                metadata: {
                    machineId: 'm-stale-target',
                    path: '/Users/leeroy/projects/stale',
                },
            },
        };
        state.machines = {
            'm-stale-target': { id: 'm-stale-target', metadata: { displayName: 'Stale target' } },
            m1: { id: 'm1', metadata: { displayName: 'Recent machine' } },
        };
        state.settings.recentMachinePaths = [{ machineId: 'm1', path: '/Users/leeroy/projects/recent' }];

        const { listRecentPathsForVoiceTool } = await import('./pathsListRecent');
        const result: any = await listRecentPathsForVoiceTool({ limit: 10 });

        expect(result.items).toEqual([
            expect.objectContaining({ label: expect.stringContaining('recent') }),
        ]);
        expect(result.items).not.toEqual([
            expect.objectContaining({ label: expect.stringContaining('stale') }),
        ]);
    });

    it('canonicalizes the default machine from recent path entries before listing paths', async () => {
        state.sessions = {};
        state.machines = {
            'm-stale': {
                id: 'm-stale',
                active: false,
                replacedByMachineId: 'm1',
                metadata: { displayName: 'Old Machine', host: 'old-host' },
            },
            m1: {
                id: 'm1',
                active: true,
                activeAt: 10,
                metadata: { displayName: 'Leeroy MacBook Pro', host: 'leeroy-mbp' },
            },
        };
        state.settings.recentMachinePaths = [
            { machineId: 'm-stale', path: '/Users/leeroy/projects/happier' },
        ];

        const { listRecentPathsForVoiceTool } = await import('./pathsListRecent');

        const result: any = await listRecentPathsForVoiceTool({ limit: 10 });

        expect(result).toMatchObject({
            items: [
                {
                    label: 'happier — Leeroy MacBook Pro',
                    lastUsedAt: 0,
                },
            ],
        });
    });

    it('counts lastUsedAt from visible lookup session metadata when the raw session path is stale', async () => {
        state.sessions = {
            s1: {
                id: 's1',
                active: true,
                presence: 'online',
                updatedAt: 1000,
                metadata: {
                    machineId: 'm1',
                    path: '/Users/leeroy/projects/old',
                },
            },
        };
        state.sessionListRenderables = {
            s1: {
                id: 's1',
                updatedAt: 1000,
                metadata: {
                    machineId: 'm1',
                    path: '/Users/leeroy/projects/happier',
                },
            },
        };
        state.sessionListIndexByServerId = {
            'server-a': [
                { type: 'session', sessionId: 's1', serverId: 'server-a', serverName: 'Server A' },
            ],
        };
        state.concurrentSessionListCacheByServerId = {};
        state.settings.recentMachinePaths = [
            { machineId: 'm1', path: '/Users/leeroy/projects/happier' },
        ];

        const { listRecentPathsForVoiceTool } = await import('./pathsListRecent');

        const result: any = await listRecentPathsForVoiceTool({ machineId: 'm1', limit: 10 });

        expect(result).toMatchObject({
            items: [
                {
                    label: 'happier — Leeroy MacBook Pro',
                    lastUsedAt: 1000,
                },
            ],
        });
    });
});
