import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createStorageModuleStub } from '../../../dev/testkit/mocks/storage';
import { installVoiceToolActionImplCommonModuleMocks } from './voiceToolActionImplTestHelpers';
import { settingsParse } from '@/sync/domains/settings/settings';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { ConcurrentSessionListCacheByServerId } from '@/sync/domains/session/listing/concurrentSessionListCache';
import type { StorageState } from '@/sync/store/types';
import type { StoreApi, UseBoundStore } from 'zustand';

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
    concurrentSessionListCacheByServerId: {},
})) as {
    settings: {
        voice: {
            privacy: {
                shareDeviceInventory: boolean;
            };
        };
    };
    concurrentSessionListCacheByServerId: ConcurrentSessionListCacheByServerId;
};

function createCachedSession(sessionId: string) {
    return buildSessionListRenderableFromSession({
        id: sessionId,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        archivedAt: null,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    });
}

installVoiceToolActionImplCommonModuleMocks({
    storage: async () => {
        const getSnapshot = () => ({
            settings: settingsParse(state.settings),
            concurrentSessionListCacheByServerId: state.concurrentSessionListCacheByServerId,
        } as StorageState);

        return createStorageModuleStub({
            // Boundary-only dynamic store stub: this action reads `settings` and the session list cache
            // directly from `storage.getState()`, so the test only models that contract surface.
            storage: Object.assign(
                ((selector?: (value: StorageState) => unknown) => {
                    const snapshot = getSnapshot();
                    return typeof selector === 'function' ? selector(snapshot) : snapshot;
                }) as UseBoundStore<StoreApi<StorageState>>,
                {
                    getState: getSnapshot,
                    getInitialState: getSnapshot,
                    setState: () => undefined,
                    subscribe: () => () => undefined,
                    destroy: () => undefined,
                } satisfies Pick<StoreApi<StorageState>, 'getState' | 'getInitialState' | 'setState' | 'subscribe'> & {
                    destroy: () => void;
                },
            ),
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
        state.concurrentSessionListCacheByServerId = {
            'server-b': {
                serverName: 'Review Server',
                sessions: {
                    's-review': createCachedSession('s-review'),
                },
            },
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
        state.concurrentSessionListCacheByServerId = {
            'server-b': {
                serverName: null,
                sessions: {
                    's-review': createCachedSession('s-review'),
                },
            },
            'server-c': {
                serverName: null,
                sessions: {
                    's-mobile': createCachedSession('s-mobile'),
                },
            },
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
