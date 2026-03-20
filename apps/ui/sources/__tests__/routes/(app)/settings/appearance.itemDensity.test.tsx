import * as React from 'react';
import renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const settingsState: Record<string, any> = {
    themePreference: 'adaptive',
    uiFontScale: 1,
    uiItemDensity: 'comfortable',
    uiMultiPanePanelsEnabled: true,
    detailsPaneTabsBehavior: 'preview',
    editorFocusModeEnabled: false,
    avatarStyle: 'gradient',
    showFlavorIcons: true,
    preferredLanguage: null,
};

vi.mock('react-native', () => ({
    Platform: {
        OS: 'web',
        select: (options: any) => (options && 'default' in options ? options.default : undefined),
    },
    View: 'View',
    Appearance: { getColorScheme: () => 'light' },
}));

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));
vi.mock('expo-router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('expo-localization', () => ({ getLocales: () => [{ languageTag: 'en-US' }] }));
vi.mock('expo-system-ui', () => ({ setBackgroundColorAsync: vi.fn() }));
vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                accent: { blue: '#00f', orange: '#f90', indigo: '#6366f1' },
                status: { connecting: '#09f' },
            },
        },
    }),
    UnistylesRuntime: {
        setAdaptiveThemes: vi.fn(),
        setTheme: vi.fn(),
        setRootViewBackgroundColor: vi.fn(),
    },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({ ItemList: ({ children }: any) => React.createElement('ItemList', null, children) }));
vi.mock('@/components/ui/lists/ItemGroup', () => ({ ItemGroup: ({ children, ...props }: any) => React.createElement('ItemGroup', props, children) }));
vi.mock('@/components/ui/lists/Item', () => ({ Item: (props: any) => React.createElement('Item', props) }));
vi.mock('@/components/ui/forms/Switch', () => ({ Switch: 'Switch' }));
vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({ DropdownMenu: (props: any) => React.createElement('DropdownMenu', props) }));
vi.mock('@/utils/platform/responsive', () => ({ useDeviceType: () => 'desktop' }));
vi.mock('@/theme', () => ({ darkTheme: { colors: { groupped: { background: '#000' } } }, lightTheme: { colors: { groupped: { background: '#fff' } } } }));
vi.mock('@/text', () => ({
    t: (key: string) => key,
    getLanguageNativeName: () => 'English',
    SUPPORTED_LANGUAGES: { en: true },
}));
vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: (key: string) => [settingsState[key] ?? null, (next: any) => { settingsState[key] = next; }],
    useLocalSettingMutable: (key: string) => [settingsState[key] ?? null, (next: any) => { settingsState[key] = next; }],
}));

afterEach(() => {
    settingsState.uiItemDensity = 'comfortable';
});

describe('Appearance settings item density', () => {
    it('renders the item density dropdown and updates the local setting', async () => {
        const mod = await import('@/app/(app)/settings/appearance');
        const AppearanceSettingsScreen = mod.default;

        let tree!: ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(AppearanceSettingsScreen));
        });

        const dropdowns = tree.root.findAllByType('DropdownMenu' as any);
        const itemDensityDropdown = dropdowns.find((node: any) => node.props?.itemTrigger?.title === 'settingsAppearance.itemDensity');
        expect(itemDensityDropdown).toBeTruthy();
        expect(itemDensityDropdown?.props?.selectedId).toBe('comfortable');

        const itemIds = itemDensityDropdown?.props?.items?.map((item: any) => item.id) ?? [];
        expect(itemIds).toEqual(['comfortable', 'cozy', 'compact']);

        await act(async () => {
            itemDensityDropdown!.props.onSelect('cozy');
        });

        expect(settingsState.uiItemDensity).toBe('cozy');
    });
});
