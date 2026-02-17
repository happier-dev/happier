import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as any).__DEV__ = false;

vi.mock('react-native-reanimated', () => ({}));

vi.mock('expo-linear-gradient', () => ({
    LinearGradient: 'LinearGradient',
}));

vi.mock('expo-router', () => ({
    useRouter: () => ({
        push: vi.fn(),
        back: vi.fn(),
        navigate: vi.fn(),
        replace: vi.fn(),
    }),
}));

vi.mock('expo-localization', () => ({
    getLocales: () => [{ languageTag: 'en-US' }],
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: { create: (styles: any) => styles },
    useUnistyles: () => ({
        theme: { colors: { status: { connecting: '#00f' } } },
    }),
    UnistylesRuntime: {
        setAdaptiveThemes: vi.fn(),
        setTheme: vi.fn(),
        setRootViewBackgroundColor: vi.fn(),
    },
}));

vi.mock('expo-system-ui', () => ({
    setBackgroundColorAsync: vi.fn(),
}));

vi.mock('@/theme', () => ({
    darkTheme: { colors: { groupped: { background: '#000' } } },
    lightTheme: { colors: { groupped: { background: '#fff' } } },
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Platform: {
        OS: 'ios',
        select: (spec: Record<string, unknown>) =>
            spec && Object.prototype.hasOwnProperty.call(spec, 'ios') ? (spec as any).ios : (spec as any).default,
    },
    Appearance: {
        getColorScheme: () => 'light',
    },
}));

vi.mock('@expo/vector-icons', async () => {
    const Ionicons = Object.assign(
        (props: any) => React.createElement('Ionicons', props),
        { glyphMap: {} },
    );
    return { Ionicons };
});

vi.mock('@/text', () => ({
    t: (key: string) => key,
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
    Switch: (props: any) => React.createElement('Switch', props),
}));

type MutableHookResult<T> = readonly [T, (next: T) => void];

function createNoopMutable<T>(value: T): MutableHookResult<T> {
    return [value, vi.fn()] as const;
}

const useSettingMutableMock = vi.fn();
const useLocalSettingMutableMock = vi.fn();

vi.mock('@/sync/domains/state/storage', () => ({
    useSettingMutable: (key: string) => useSettingMutableMock(key),
    useLocalSettingMutable: (key: string) => useLocalSettingMutableMock(key),
}));

describe('AppearanceSettingsScreen (session list controls)', () => {
    beforeEach(() => {
        vi.resetModules();

        useSettingMutableMock.mockImplementation((key: string) => {
            if (key === 'viewInline') return createNoopMutable(false);
            if (key === 'expandTodos') return createNoopMutable(false);
            if (key === 'showLineNumbers') return createNoopMutable(false);
            if (key === 'showLineNumbersInToolViews') return createNoopMutable(false);
            if (key === 'wrapLinesInDiffs') return createNoopMutable(false);
            if (key === 'alwaysShowContextSize') return createNoopMutable(false);
            if (key === 'agentInputActionBarLayout') return createNoopMutable('auto' as any);
            if (key === 'agentInputChipDensity') return createNoopMutable('auto' as any);
            if (key === 'avatarStyle') return createNoopMutable('gradient' as any);
            if (key === 'showFlavorIcons') return createNoopMutable(true);
            if (key === 'compactSessionView') return createNoopMutable(false);
            if (key === 'compactSessionViewMinimal') return createNoopMutable(false);
            if (key === 'preferredLanguage') return createNoopMutable(null);

            // Session list settings we are moving into appearance:
            if (key === 'hideInactiveSessions') return createNoopMutable(false);
            if (key === 'sessionListActiveGroupingV1') return createNoopMutable('project' as any);
            if (key === 'sessionListInactiveGroupingV1') return createNoopMutable('date' as any);

            return createNoopMutable(null);
        });

        useLocalSettingMutableMock.mockImplementation((key: string) => {
            if (key === 'themePreference') return createNoopMutable('adaptive' as any);
            return createNoopMutable(null);
        });
    });

    it('renders session list grouping controls and hide-inactive toggle', async () => {
        const { default: AppearanceSettingsScreen } = await import('./appearance');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(React.createElement(AppearanceSettingsScreen));
        });

        const items = tree!.root.findAllByType('Item' as any);
        const titles = items.map((i) => i.props.title);

        expect(titles).toContain('settingsFeatures.hideInactiveSessions');
        expect(titles).toContain('settingsFeatures.sessionListActiveGrouping');
        expect(titles).toContain('settingsFeatures.sessionListInactiveGrouping');
    });
});
