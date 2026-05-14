import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storageStore';

import { useSelectedPetPackage } from './useSelectedPetPackage';

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (featureId: string) => {
        if (featureId === 'pets.companion') return { state: 'enabled' };
        if (featureId === 'pets.sync') return { state: 'disabled' };
        return { state: 'disabled' };
    },
}));

describe('useSelectedPetPackage', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('does not recompute the selected pet for unrelated settings changes', async () => {
        const previousState = storage.getState();

        try {
            storage.setState((state) => ({
                ...state,
                settings: {
                    ...settingsDefaults,
                    ...state.settings,
                    petsEnabled: true,
                    petsSelectedPetRef: { kind: 'builtIn', petId: 'milo' },
                },
                localSettings: {
                    ...localSettingsDefaults,
                    ...state.localSettings,
                    petsEnabledOverride: 'inherit',
                    petsSelectedPetOverride: { kind: 'inherit' },
                },
                accountPetsById: {},
                localPetSourcesBySourceKey: {},
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return useSelectedPetPackage();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const renderCountBeforeUnrelatedSettingsUpdate = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    settings: {
                        ...state.settings,
                        schemaVersion: state.settings.schemaVersion + 1,
                    },
                    localSettings: {
                        ...state.localSettings,
                        uiFontScale: state.localSettings.uiFontScale + 0.1,
                    },
                }));
            });

            expect(renderCount).toBe(renderCountBeforeUnrelatedSettingsUpdate);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });
});
