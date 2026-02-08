import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { enableReactActEnvironment, PICKER_NAV_STATE, PICKER_THEME_COLORS } from './testHarness';

type PathSelectorProps = {
    favoriteDirectories: string[];
    onChangeFavoriteDirectories: (next: string[]) => void;
    onSubmitSelectedPath: (path: string) => void;
};
type NavigationState = {
    index: number;
    routes: Array<{ key: string }>;
};

let lastPathSelectorProps: PathSelectorProps | null = null;
let routerBackMock = vi.fn();
let routerSetParamsMock = vi.fn();
let navigationDispatchMock = vi.fn();
let navigationGoBackMock = vi.fn();
let navigationState: NavigationState = PICKER_NAV_STATE;

enableReactActEnvironment();

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    Platform: {
        OS: 'web',
        select: (options: { web?: unknown; ios?: unknown; default?: unknown }) => options.web ?? options.ios ?? options.default,
    },
    TurboModuleRegistry: {
        getEnforcing: () => ({}),
    },
}));

vi.mock('expo-router', () => ({
    Stack: { Screen: () => null },
    useRouter: () => ({ back: routerBackMock, setParams: routerSetParamsMock }),
    useNavigation: () => ({
        getState: () => navigationState,
        dispatch: navigationDispatchMock,
        goBack: navigationGoBackMock,
    }),
    useLocalSearchParams: () => ({ machineId: 'm1', selectedPath: '/tmp' }),
}));

vi.mock('@react-navigation/native', () => ({
    CommonActions: {
        setParams: (params: Record<string, unknown>) => ({ type: 'SET_PARAMS', payload: { params } }),
    },
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: PICKER_THEME_COLORS } }),
    StyleSheet: { create: (fn: any) => fn({ colors: PICKER_THEME_COLORS }) },
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: React.PropsWithChildren<Record<string, never>>) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/layout', () => ({
    layout: { maxWidth: 900 },
}));

vi.mock('@/components/ui/forms/SearchHeader', () => ({
    SearchHeader: () => null,
}));

vi.mock('@/components/sessions/new/components/PathSelector', () => ({
    PathSelector: (props: PathSelectorProps) => {
        lastPathSelectorProps = props;
        return null;
    },
}));

vi.mock('@/sync/storage', () => ({
    useAllMachines: () => [{ id: 'm1', metadata: { homeDir: '/home' } }],
    useSessions: () => [],
    useSetting: (key: string) => {
        if (key === 'recentMachinePaths') return [];
        if (key === 'usePathPickerSearch') return false;
        return null;
    },
    useSettingMutable: (key: string) => {
        if (key === 'favoriteDirectories') return [undefined, vi.fn()];
        return [null, vi.fn()];
    },
}));

describe('PathPickerScreen', () => {
    beforeEach(() => {
        lastPathSelectorProps = null;
        navigationState = PICKER_NAV_STATE;
        routerBackMock.mockClear();
        routerSetParamsMock.mockClear();
        navigationDispatchMock.mockClear();
        navigationGoBackMock.mockClear();
    });

    async function renderPathPicker() {
        const PathPickerScreen = (await import('@/app/(app)/new/pick/path')).default;
        act(() => {
            renderer.create(React.createElement(PathPickerScreen));
        });
    }

    it('defaults favoriteDirectories to an empty array when setting is undefined', async () => {
        await renderPathPicker();

        expect(lastPathSelectorProps).toBeTruthy();
        expect(lastPathSelectorProps?.favoriteDirectories).toEqual([]);
        expect(typeof lastPathSelectorProps?.onChangeFavoriteDirectories).toBe('function');
    });

    it('sets the selected path on the previous route params when confirming', async () => {
        await renderPathPicker();

        expect(lastPathSelectorProps).toBeTruthy();
        act(() => {
            lastPathSelectorProps?.onSubmitSelectedPath('/Users/leeroy/Documents/Development/happier/dev/apps/stack');
        });

        expect(navigationDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
            type: 'SET_PARAMS',
            source: 'a',
            payload: expect.objectContaining({
                params: expect.objectContaining({
                    path: '/Users/leeroy/Documents/Development/happier/dev/apps/stack',
                }),
            }),
        }));
        expect(routerBackMock).toHaveBeenCalled();
    });

    it('falls back to router params update when there is no previous route', async () => {
        navigationState = { index: 0, routes: [{ key: 'only' }] };
        await renderPathPicker();

        expect(lastPathSelectorProps).toBeTruthy();
        act(() => {
            lastPathSelectorProps?.onSubmitSelectedPath('');
        });

        expect(navigationDispatchMock).not.toHaveBeenCalled();
        expect(routerBackMock).not.toHaveBeenCalled();
        expect(routerSetParamsMock).toHaveBeenCalledWith({
            path: '/home',
        });
    });
});
