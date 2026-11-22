import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { setPreferredLanguageFromSettings, t } from '@/text';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('react-native-reanimated', async () => {
    const { createReanimatedModuleMock } = await import('@/dev/testkit/mocks/reanimated');
    return createReanimatedModuleMock();
});

const initialState = storage.getState();
afterEach(() => {
    standardCleanup();
    storage.setState(initialState, true);
    setPreferredLanguageFromSettings(initialState.settings.preferredLanguage);
});

describe('SessionListStorageTabsBar', () => {
    it('updates the mounted Direct tab when a synced language changes', async () => {
        storage.getState().applySettingsLocal({ preferredLanguage: 'zh-Hans' });
        const initialLabel = t('sessionsList.storageDirectTab');
        const { SessionListStorageTabsBar } = await import('./SessionListStorageTabsBar');
        const screen = await renderScreen(<SessionListStorageTabsBar activeTabId="direct" onSelectTab={vi.fn()} />);
        const directTab = () => screen.findByTestId('sessions-list-storage-tab:direct');
        expect(directTab()?.findByType('Text' as never).props.children).toBe(initialLabel);

        await act(async () => {
            const { applySettings, settings, settingsVersion } = storage.getState();
            applySettings({ ...settings, preferredLanguage: 'en' }, (settingsVersion ?? 0) + 1);
        });

        const EnglishLabel = t('sessionsList.storageDirectTab');
        expect(EnglishLabel).not.toBe(initialLabel);
        expect(directTab()?.findByType('Text' as never).props.children).toBe(EnglishLabel);
        expect(directTab()?.props.accessibilityState).toEqual({ selected: true });
    });
});
