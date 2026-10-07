import * as React from 'react';
import { storage as storageStore } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { standardCleanup } from '@/dev/testkit';

const initialSettingsCatalogStorage = storageStore.getState();

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        View: 'View',
        Pressable: 'Pressable',
        Text: 'Text',
        Platform: {
            OS: 'web',
            select: (options: any) => (options && 'default' in options ? options.default : undefined),
        },
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: () => '/settings',
        router: { push: vi.fn() },
    }).module;
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => true,
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => importOriginal());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

vi.mock('expo-clipboard', () => ({
    setStringAsync: async () => {},
}));

vi.mock('@/components/ui/text/Text', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/ui/text/Text')>();
    return {
        ...actual,
        Text: 'StyledText',
    };
});

beforeEach(async () => {
    await loadSyncSingletonForTests();
    installDisconnectedServerSocketBoundary();
    storageStore.setState({
        settings: settingsParse({ useProfiles: false }),
        localSettings: localSettingsParse({ devModeEnabled: false, uiFontScale: 1 }),
    });
});

afterEach(async () => {
    await standardCleanup();
    storageStore.setState(initialSettingsCatalogStorage, true);
});

describe('SettingsSidebar real TextInput render', () => {
    it('renders the settings sidebar search input without crashing', async () => {
        const { SettingsSidebar } = await import('./SettingsSidebar');
        const screen = await renderScreen(React.createElement(SettingsSidebar));

        expect(screen.findByTestId('settings-sidebar.searchInput')).toBeTruthy();
    });
});
