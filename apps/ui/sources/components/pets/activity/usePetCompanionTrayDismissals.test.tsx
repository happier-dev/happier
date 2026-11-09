import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderHook, standardCleanup } from '@/dev/testkit';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { storage } from '@/sync/domains/state/storageStore';
import { settingsParse } from '@/sync/domains/settings/settings';

import { usePetCompanionTrayDismissals } from './usePetCompanionTrayDismissals';
import { getPersistenceStorage } from '@/sync/domains/state/persistenceStorage';
import { petActivityDismissalsState } from '@/sync/domains/state/onboardingUiState';
import { resetPersistentUiStateForTest } from '@/dev/testkit/cleanup/persistentUiState';

describe('usePetCompanionTrayDismissals', () => {
    beforeEach(resetPersistentUiStateForTest);
    afterEach(() => {
        standardCleanup();
    });

    it('remembers an acknowledged activity across visits with Settings writes Off', async () => {
        const previousState = storage.getState();
        try {
            storage.setState(state => ({ settings: settingsParse({ ...state.settings,
                actionsSettingsV1: { v: 1, actions: { 'settings.set': { disabledSurfaces: ['ui'] } } } }),
                localSettings: { ...localSettingsDefaults } }));
            const writes = vi.spyOn(getPersistenceStorage(), 'set');
            const localSettings = storage.getState().localSettings;
            const hook = await renderHook(() => usePetCompanionTrayDismissals());
            await act(async () => hook.getCurrent().dismissTrayItem({
                id: 'session-a', dismissKey: 'waiting:session-a:1000',
                address: { serverId: 'server-a', sessionId: 'session-a' }, sessionId: 'session-a',
                contextLine: null, accessibilityContext: null, activity: 'needsYou',
                title: 'Session', subtitle: null,
                actions: { open: true, dismiss: true, quickReply: true },
            }));
            expect(writes.mock.calls.filter(([key]) => key === 'local-settings')).toHaveLength(0);
            expect(storage.getState().localSettings).toBe(localSettings);
            expect(getPersistenceStorage().getString('ui-state:pet-activity-dismissals-v1:tray')).toBe('["waiting:session-a:1000"]');
            await hook.unmount();
            const nextVisit = await renderHook(() => usePetCompanionTrayDismissals());
            expect(nextVisit.getCurrent().dismissedTrayItemKeys.has('waiting:session-a:1000')).toBe(true);
            writes.mockRestore();
        } finally { standardCleanup(); storage.setState(previousState, true); }
    });

    it('does not rerender when unrelated local settings change', async () => {
        const previousState = storage.getState();

        try {
            storage.setState((state) => ({
                ...state,
                localSettings: {
                    ...localSettingsDefaults,
                },
            }));

            petActivityDismissalsState.set('tray', ['waiting:session-a:1000']);

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
