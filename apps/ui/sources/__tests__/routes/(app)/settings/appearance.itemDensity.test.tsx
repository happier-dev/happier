import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    renderSettingsView,
    standardCleanup,
} from '@/dev/testkit';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const shared = vi.hoisted(() => ({
    settingsState: {
        themePreference: 'adaptive',
        uiFontScale: 1,
        uiItemDensity: 'comfortable',
        uiMultiPanePanelsEnabled: true,
        detailsPaneTabsBehavior: 'preview',
        editorFocusModeEnabled: false,
        avatarStyle: 'gradient',
        showFlavorIcons: true,
        preferredLanguage: null,
    } as Record<string, unknown>,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                Appearance: { getColorScheme: () => 'light' },
                            }
    );
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});

vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn() }));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                accent: { blue: '#00f', orange: '#f90', indigo: '#6366f1' },
                status: { connecting: '#09f' },
            },
        },
        runtime: {
            setAdaptiveThemes: vi.fn(),
            setTheme: vi.fn(),
            setRootViewBackgroundColor: vi.fn(),
        },
    });
});

vi.mock('@/components/ui/lists/ItemList', () => ({ ItemList: ({ children }: any) => React.createElement('ItemList', null, children) }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: ({ children, ...props }: any) => React.createElement('ItemGroup', props, children) }));
vi.mock('@/components/ui/lists/Item', () => ({ Item: (props: any) => React.createElement('Item', props) }));
vi.mock('@/components/ui/forms/Switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({ DropdownMenu: (props: any) => React.createElement('DropdownMenu', props) }));
vi.mock('@/utils/platform/responsive', () => ({ useDeviceType: () => 'desktop' }));
vi.mock('@/theme', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/theme')>();
    return {
        ...actual,
        darkTheme: {
            ...actual.darkTheme,
            colors: {
                ...actual.darkTheme.colors,
                groupped: { background: '#000' },
            },
        },
        lightTheme: {
            ...actual.lightTheme,
            colors: {
                ...actual.lightTheme.colors,
                groupped: { background: '#fff' },
            },
        },
    };
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return {
        ...createTextModuleMock(),
        getLanguageNativeName: () => 'English',
        SUPPORTED_LANGUAGES: { en: true },
    };
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            // Boundary mock: this suite only reads and updates a small local settings subset.
            useSettingMutable: ((key: string) => [
                shared.settingsState[key] ?? null,
                (next: unknown) => { shared.settingsState[key] = next; },
            ]) as any,
            // Boundary mock: this suite only reads and updates a small local settings subset.
            useLocalSettingMutable: ((key: string) => [
                shared.settingsState[key] ?? null,
                (next: unknown) => { shared.settingsState[key] = next; },
            ]) as any,
        },
    });
});

afterEach(() => {
    standardCleanup();
    shared.settingsState.uiItemDensity = 'comfortable';
});

describe('Appearance settings item density', () => {
    it('renders the item density dropdown and updates the local setting', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const screen = await renderSettingsView(React.createElement(mod.default));

        const dropdowns = screen.root.findAllByType('DropdownMenu' as any);
        const itemDensityDropdown = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsAppearance.itemDensity');
        expect(itemDensityDropdown).toBeTruthy();
        expect(itemDensityDropdown?.props?.selectedId).toBe('comfortable');

        const itemIds = itemDensityDropdown?.props?.items?.map((item: any) => item.id) ?? [];
        expect(itemIds).toEqual(['comfortable', 'cozy', 'compact']);

        await act(async () => {
            itemDensityDropdown!.props.onSelect('cozy');
        });

        expect(shared.settingsState.uiItemDensity).toBe('cozy');
    });
});
