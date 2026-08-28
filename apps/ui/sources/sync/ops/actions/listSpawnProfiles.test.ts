import { afterEach, describe, expect, it, vi } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { listSpawnProfilesForActions } from './listSpawnProfiles';

type MachineContributionRegistryProjectionDescribeFn =
  typeof import('@/sync/ops/machineContributionRegistryProjection').machineContributionRegistryProjectionDescribe;

const { machineContributionRegistryProjectionDescribe } = vi.hoisted(() => ({
  machineContributionRegistryProjectionDescribe: vi.fn<MachineContributionRegistryProjectionDescribeFn>(
    async () => ({ supported: false, reason: 'not-supported' }) as never,
  ),
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/sync/ops/machineContributionRegistryProjection')>();
  return {
    ...actual,
    machineContributionRegistryProjectionDescribe,
  };
});

const original = (() => {
    const state = storage.getState();
    return {
        settings: state.settings,
        settingsVersion: state.settingsVersion,
        settingsScope: state.settingsScope,
    };
})();

afterEach(() => {
    storage.setState(original);
});

describe('listSpawnProfilesForActions', () => {
    it('returns not-ready before Account settings hydrate', () => {
        storage.setState((state) => ({
            ...state,
            settings: { ...state.settings, profiles: [] },
            settingsVersion: null,
        }));

        expect(listSpawnProfilesForActions({})).toMatchObject({
            items: [],
            coverage: 'unavailable',
        });
    });

    it('reports a newer-schema profile as unreadable instead of hiding it from a complete answer', () => {
        storage.setState((state) => ({
            ...state,
            settings: {
                ...state.settings,
                profiles: [
                    {
                        v: 2,
                        id: 'readable',
                        name: 'Readable',
                        extraEnvironmentVariables: [],
                        defaultPermissionModeByTargetKey: {},
                        defaultPersistenceModeByTargetKey: {},
                        compatibilityByTargetKey: {},
                        createdAt: 1,
                        updatedAt: 1,
                    },
                    { v: 99, id: 'future', opaque: { untouched: true } },
                ],
            },
            settingsVersion: 1,
        }));

        expect(listSpawnProfilesForActions({})).toMatchObject({
            coverage: 'unreadable',
            items: [expect.objectContaining({ id: 'readable' })],
        });
    });

    it('lists a profile targeting a novel external qualified Agent through the host Agent catalog', async () => {
        storage.setState((state) => ({
            ...state,
            settings: {
                ...state.settings,
                profiles: [
                    {
                        v: 2,
                        id: 'external-agent-profile',
                        name: 'External Agent profile',
                        extraEnvironmentVariables: [],
                        defaultPermissionModeByTargetKey: {},
                        defaultPersistenceModeByTargetKey: {},
                        compatibilityByTargetKey: { 'agent:acme.voice/agent': true },
                        preferredAgentTargetKey: 'agent:acme.voice/agent',
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
            settingsVersion: 1,
        }));
        machineContributionRegistryProjectionDescribe.mockResolvedValue({
            supported: true,
            projection: {
                v: 2,
                generation: 7,
                agentsById: {
                    'acme-voice-agent': {
                        id: 'acme-voice-agent',
                        identity: { pluginId: 'acme.voice', localId: 'agent' },
                        title: 'Acme Voice Agent',
                        capabilities: {
                            sessions: {
                                open: ['create', 'resume'],
                                delivery: ['newTurn'],
                                cancel: true,
                            },
                        },
                    },
                },
                backendsById: {
                    'acme-voice-agent': { id: 'acme-voice-agent', agentId: 'acme-voice-agent' },
                },
                familiesById: {},
            },
        } as never);

        const projection = await listSpawnProfilesForActions({});

        expect(projection.items).toEqual([
            expect.objectContaining({
                id: 'external-agent-profile',
                preferredAgentTargetKey: 'agent:acme.voice/agent',
                supportedAgentIds: expect.arrayContaining(['acme.voice/agent']),
            }),
        ]);
    });

    it('still answers with the bundled catalog when no machine projection is available', async () => {
        storage.setState((state) => ({
            ...state,
            settings: {
                ...state.settings,
                profiles: [
                    {
                        v: 2,
                        id: 'bundled-profile',
                        name: 'Bundled profile',
                        extraEnvironmentVariables: [],
                        defaultPermissionModeByTargetKey: {},
                        defaultPersistenceModeByTargetKey: {},
                        compatibilityByTargetKey: {},
                        createdAt: 1,
                        updatedAt: 1,
                    },
                ],
            },
            settingsVersion: 1,
        }));

        const projection = await listSpawnProfilesForActions({ agentId: 'claude' });

        expect(projection.items).toEqual([
            expect.objectContaining({
                id: 'bundled-profile',
                supportedAgentIds: expect.arrayContaining(['claude']),
            }),
        ]);
        expect(projection.coverage).toBe('complete');
    });
});
