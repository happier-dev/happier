import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorageModuleStub } from '../../../dev/testkit/mocks/storage';
import { installVoiceToolActionImplCommonModuleMocks } from './voiceToolActionImplTestHelpers';

const getActiveServerSnapshot = vi.fn();
const getServerProfileById = vi.fn();
const state = vi.hoisted(() => ({
    settings: {
        voice: {
            privacy: {
                shareDeviceInventory: true,
            },
        },
    },
    sessionListViewDataByServerId: {},
})) as {
    settings: {
        voice: {
            privacy: {
                shareDeviceInventory: boolean;
            };
        };
    };
    sessionListViewDataByServerId: Record<string, unknown[]>;
};

installVoiceToolActionImplCommonModuleMocks({
    storage: async () => {
        return createStorageModuleStub({
            storage: {
                getState: () => state,
            } as typeof import('@/sync/domains/state/storage').storage,
        });
    },
});

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot,
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getServerProfileById,
}));

describe('listServersForVoiceTool', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    it('prefers saved server profile names over raw server ids', async () => {
        state.settings.voice.privacy.shareDeviceInventory = true;
        state.sessionListViewDataByServerId = {
            'server-b': [
                {
                    type: 'session',
                    serverId: 'server-b',
                    serverName: 'Review Server',
                    session: { id: 's-review' },
                },
            ],
        };
        getActiveServerSnapshot.mockReturnValue({ serverId: 'server-a' });
        getServerProfileById.mockImplementation((serverId: string) => {
            if (serverId === 'server-a') {
                return {
                    id: 'server-a',
                    name: 'Primary Server',
                    serverUrl: 'http://server-a.local',
                    createdAt: 1,
                    updatedAt: 1,
                    lastUsedAt: 1,
                };
            }
            return null;
        });

        const { listServersForVoiceTool } = await import('./serversList');
        const result = await listServersForVoiceTool({ limit: 10 });

        expect(result).toEqual({
            items: [
                { serverId: 'server-a', label: 'Primary Server' },
                { serverId: 'server-b', label: 'Review Server' },
            ],
        });
    });

    it('falls back to human-friendly generic labels instead of raw server ids', async () => {
        state.settings.voice.privacy.shareDeviceInventory = true;
        state.sessionListViewDataByServerId = {
            'server-b': [
                {
                    type: 'session',
                    serverId: 'server-b',
                    session: { id: 's-review' },
                },
            ],
            'server-c': [
                {
                    type: 'session',
                    serverId: 'server-c',
                    session: { id: 's-mobile' },
                },
            ],
        };
        getActiveServerSnapshot.mockReturnValue({ serverId: 'server-a' });
        getServerProfileById.mockReturnValue(null);

        const { listServersForVoiceTool } = await import('./serversList');
        const result = await listServersForVoiceTool({ limit: 10 });

        expect(result).toEqual({
            items: [
                { serverId: 'server-a', label: 'Current server' },
                { serverId: 'server-b', label: 'Connected server 1' },
                { serverId: 'server-c', label: 'Connected server 2' },
            ],
        });
    });
});
