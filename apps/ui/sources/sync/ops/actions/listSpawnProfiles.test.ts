import { afterEach, describe, expect, it } from 'vitest';

import { storage } from '@/sync/domains/state/storage';
import { listSpawnProfilesForActions } from './listSpawnProfiles';

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
});
