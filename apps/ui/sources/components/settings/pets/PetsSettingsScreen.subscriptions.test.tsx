import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { act, renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';
import { PetsSettingsScreen } from './PetsSettingsScreen';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

const initialState = storage.getState();
afterEach(() => {
    standardCleanup();
    storage.setState(initialState, true);
});

it('keeps the pet settings page quiet for unrelated local preferences and follows companion size', async () => {
    storage.getState().applyLocalSettings(localSettingsDefaults, { persist: false });
    const commits = vi.fn();
    await renderScreen(<React.Profiler id="pet-settings" onRender={commits}>
        <PetsSettingsScreen />
    </React.Profiler>);
    const baseline = commits.mock.calls.length;
    await act(async () => {
        storage.getState().applyLocalSettings({ paneArrangement: 'editor' }, { persist: false });
    });
    expect(commits.mock.calls.length - baseline).toBe(0);
    await act(async () => {
        storage.getState().applyLocalSettings({ petsCompanionSizeScale: 1.5 }, { persist: false });
    });
    expect(commits.mock.calls.length - baseline).toBe(1);
});
