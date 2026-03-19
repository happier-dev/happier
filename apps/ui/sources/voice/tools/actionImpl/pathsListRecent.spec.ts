import { beforeEach, describe, expect, it, vi } from 'vitest';

const voiceTargetState = {
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

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => state,
    },
}));

vi.mock('@/voice/runtime/voiceTargetStore', () => ({
    useVoiceTargetStore: {
        getState: () => voiceTargetState,
    },
}));

describe('listRecentPathsForVoiceTool', () => {
    beforeEach(() => {
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

    it('resolves the default machine and lastUsedAt from the reachable target even when raw path sharing is force-enabled', async () => {
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
            m1: {
                id: 'm1',
                active: true,
                activeAt: 10,
                metadata: { displayName: 'Leeroy MacBook Pro', host: 'leeroy-mbp' },
            },
        };
        state.settings.voice.privacy.shareFilePaths = true;
        state.settings.recentMachinePaths = [];
        state.getProjectForSession = (sessionId: string) =>
            sessionId === 's1'
                ? {
                    key: {
                        machineId: 'm1',
                        path: '/Users/leeroy/projects/happier',
                    },
                }
                : null;

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
});
