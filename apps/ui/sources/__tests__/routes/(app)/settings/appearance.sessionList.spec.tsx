import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createReactNativeWebMock } from '@/dev/testkit/mocks/reactNative';
import { createExpoRouterMock } from '@/dev/testkit/mocks/router';
import { createStorageModuleMock } from '@/dev/testkit/mocks/storage';
import { createTextModuleMock } from '@/dev/testkit/mocks/text';
import { createUnistylesMock } from '@/dev/testkit/mocks/unistyles';
import { renderScreen } from '@/dev/testkit/render/renderScreen';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('expo-router', () => createExpoRouterMock().module);

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn() }));
vi.mock('@/theme', () => ({ darkTheme: { colors: { groupped: { background: '#000' } } }, lightTheme: { colors: { groupped: { background: '#fff' } } } }));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                            View: 'View',
                            Appearance: { getColorScheme: () => 'light' },
                        }
    );
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('react-native-unistyles', async () => await createUnistylesMock({
    theme: {
        colors: {
            accent: { blue: '#00f', orange: '#f90', indigo: '#6366f1' },
            status: { connecting: '#09f' },
            shadow: { color: '#000' },
            surface: '#fff',
            text: '#111',
            divider: '#ddd',
        },
    },
}));

vi.mock('@/text', () => ({
    ...createTextModuleMock(),
    getLanguageNativeName: () => 'English',
    SUPPORTED_LANGUAGES: { en: { name: 'English' } },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: any) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ children }: any) => React.createElement('ItemGroup', null, children),
}));

vi.mock('@/components/ui/lists/Item', () => ({
    Item: (props: any) => React.createElement('Item', props),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: 'Switch',
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/utils/platform/responsive', () => ({
    useDeviceType: () => 'desktop',
}));

type MutableHookResult<T> = readonly [T, (next: T) => void];

function createNoopMutable<T>(value: T): MutableHookResult<T> {
    return [value, vi.fn()] as const;
}

const useSettingMutableMock = vi.fn();
const useLocalSettingMutableMock = vi.fn();

vi.mock('@/sync/domains/state/storage', async (importOriginal) => await createStorageModuleMock({
    importOriginal,
    overrides: {
        useSettingMutable: (key: string) => useSettingMutableMock(key),
        useLocalSettingMutable: (key: string) => useLocalSettingMutableMock(key),
    },
}));

describe('AppearanceSettingsScreen (focused groups after redistribution)', () => {
    beforeEach(() => {
        vi.resetModules();

        useSettingMutableMock.mockImplementation((key: string) => {
            if (key === 'avatarStyle') return createNoopMutable('gradient' as any);
            if (key === 'showFlavorIcons') return createNoopMutable(true);
            if (key === 'preferredLanguage') return createNoopMutable(null);
            return createNoopMutable(null);
        });

        useLocalSettingMutableMock.mockImplementation((key: string) => {
            if (key === 'themePreference') return createNoopMutable('adaptive' as any);
            if (key === 'uiFontScale') return createNoopMutable(1 as any);
            if (key === 'uiItemDensity') return createNoopMutable('comfortable' as any);
            if (key === 'uiMultiPanePanelsEnabled') return createNoopMutable(false);
            if (key === 'detailsPaneTabsBehavior') return createNoopMutable('preview' as any);
            if (key === 'editorFocusModeEnabled') return createNoopMutable(false);
            return createNoopMutable(null);
        });
    });

    it('renders core appearance settings after redistribution', async () => {
        const { default: AppearanceSettingsScreen } = await import('@/app/(app)/settings/appearance');
        const screen = await renderScreen(React.createElement(AppearanceSettingsScreen));

        const items = screen.root.findAllByType('Item' as any);
        const titles = items.map((i) => i.props.title);
        const dropdowns = screen.root.findAllByType('DropdownMenu' as any);
        const dropdownTitles = dropdowns.map((node: any) => node.props?.itemTrigger?.title).filter(Boolean);

        // Core appearance settings that remain
        expect(titles).toContain('settings.appearance');
        expect(titles).toContain('settingsAppearance.avatarStyle');
        expect(titles).toContain('settingsAppearance.showFlavorIcons');
        expect(titles).toContain('settingsAppearance.multiPanePanels');
        expect(dropdownTitles).toContain('settingsAppearance.textSize');
        expect(dropdownTitles).toContain('settingsAppearance.itemDensity');

        // Session list settings moved to session.tsx — should NOT be here
        expect(titles).not.toContain('settingsFeatures.hideInactiveSessions');
        expect(titles).not.toContain('settingsFeatures.sessionListActiveGrouping');
        expect(titles).not.toContain('settingsFeatures.sessionListInactiveGrouping');
    });
});
