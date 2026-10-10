import * as React from 'react';
import { storage as storageStore } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { localSettingsParse } from '@/sync/domains/settings/localSettings';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { standardCleanup } from '@/dev/testkit';

const initialSettingsCatalogStorage = storageStore.getState();

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { renderScreen } from '@/dev/testkit';
import { Item } from '@/components/ui/lists/Item';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const featureGateState = vi.hoisted(() => ({
    enabled: (_featureId: string) => true,
}));
const pathnameState = vi.hoisted(() => ({ value: '/settings' }));
const routerPushSpy = vi.hoisted(() => vi.fn());
const routerNavigateSpy = vi.hoisted(() => vi.fn());

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
        useWindowDimensions: () => ({ width: 390, height: 844, scale: 1, fontScale: 1 }),
    });
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        pathname: () => pathnameState.value,
        router: { navigate: routerNavigateSpy, push: routerPushSpy },
    }).module;
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureGateState.enabled(featureId),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => importOriginal());

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    // Page search words are translation keys; resolve them in English (as the catalog owner test does)
    // so a page is found by its words. Every other key renders as itself.
    const { settingsSearchKeywordsTranslations } = await import('@/text/translations/settingsSearchKeywordsTranslations');
    const english: Record<string, string> = settingsSearchKeywordsTranslations.en.settingsSearchKeywords;
    return createTextModuleMock({
        translate: (key) => (key.startsWith('settingsSearchKeywords.') ? english[key.slice('settingsSearchKeywords.'.length)] : undefined) ?? key,
    });
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

vi.mock('@/components/ui/text/Text', () => ({
    Text: 'StyledText',
    TextInput: 'TextInput',
}));

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

describe('SettingsPageSearch', () => {
    afterEach(() => {
        routerNavigateSpy.mockReset();
    });

    async function renderSearch() {
        const { SettingsPageSearch } = await import('./SettingsPageSearch');
        const { SettingsShell } = await import('./SettingsShell');
        return await renderScreen(
            <SettingsShell><SettingsPageSearch>
                <Item testID="settings-overview-content" title="overview" />
            </SettingsPageSearch></SettingsShell>,
        );
    }

    it('shows the page until a query is typed, then the pages and settings it finds instead', async () => {
        const screen = await renderSearch();
        expect(screen.findByTestId('settings-overview-content')).toBeTruthy();

        await act(async () => {
            screen.changeTextByTestId('settings-page-search:input', 'notif');
        });

        expect(screen.findByTestId('settings-overview-content')).toBeNull();
        expect(screen.findByTestId('settings-page-search.result.notifications')).toBeTruthy();
        expect(screen.findByTestId('settings-page-search.result.group.settings')).toBeTruthy();

        await screen.pressByTestIdAsync('settings-page-search.result.notifications');
        expect(routerNavigateSpy).toHaveBeenCalledWith('/settings/notifications?settingsSearch=1');
    });

    it('opens a setting at its row, and keeps the query for the way back', async () => {
        const { SettingsPageSearch } = await import('./SettingsPageSearch');
        const { SettingsShell } = await import('./SettingsShell');
        const screen = await renderSearch();
        await act(async () => {
            screen.changeTextByTestId('settings-page-search:input', 'itemDensity');
        });

        await screen.pressByTestIdAsync('settings-page-search.result.setting.appearance.density');
        expect(routerNavigateSpy).toHaveBeenCalledWith('/settings/appearance?setting=appearance.density&settingsSearch=1');

        // Hosted Settings replaces its selected leaf, not the shared layout/shell.
        await act(async () => {
            screen.update(<SettingsShell><Item testID="appearance-leaf" title="appearance" /></SettingsShell>);
        });
        expect(screen.findByTestId('settings-page-search:input')).toBeNull();
        expect(screen.findByTestId('appearance-leaf')).toBeTruthy();
        await act(async () => {
            screen.update(<SettingsShell><SettingsPageSearch>
                <Item testID="settings-overview-content" title="overview" />
            </SettingsPageSearch></SettingsShell>);
        });
        expect(screen.findByTestId('settings-page-search:input')?.props.value).toBe('itemDensity');
        expect(screen.findByTestId('settings-page-search.result.setting.appearance.density')).toBeTruthy();
    });

    it('says so when nothing matches', async () => {
        const screen = await renderSearch();
        await act(async () => {
            screen.changeTextByTestId('settings-page-search:input', 'zzqxv-no-such-setting');
        });
        expect(screen.findByTestId('settings-page-search.empty')).toBeTruthy();
    });
});
