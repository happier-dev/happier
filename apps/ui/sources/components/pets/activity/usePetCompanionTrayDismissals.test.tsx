import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { storage } from '@/sync/domains/state/storageStore';

import { usePetCompanionTrayDismissals } from './usePetCompanionTrayDismissals';

describe('usePetCompanionTrayDismissals', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('does not rerender when unrelated local settings change', async () => {
        const previousState = storage.getState();

        try {
            storage.setState((state) => ({
                ...state,
                localSettings: {
                    ...localSettingsDefaults,
                    petsDismissedCompanionTrayItemKeys: ['waiting:session-a:1000'],
                },
            }));

            let renderCount = 0;
            const hook = await renderHook(() => {
                renderCount += 1;
                return usePetCompanionTrayDismissals();
            }, {
                flushOptions: { cycles: 1, turns: 4 },
            });
            const renderCountBeforeUnrelatedSetting = renderCount;

            await act(async () => {
                storage.setState((state) => ({
                    ...state,
                    localSettings: {
                        ...state.localSettings,
                        uiFontScale: state.localSettings.uiFontScale + 0.1,
                    },
                }));
            });

            expect(renderCount).toBe(renderCountBeforeUnrelatedSetting);

            await hook.unmount();
        } finally {
            storage.setState(previousState, true);
        }
    });
});
