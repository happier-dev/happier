import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { enableReactActEnvironment, PICKER_NAV_STATE, PICKER_THEME_COLORS } from './testHarness';

type PathSelectorProps = {
    favoriteDirectories: string[];
    onChangeFavoriteDirectories: (next: string[]) => void;
    onSubmitSelectedPath: (path: string) => void;
    machineBrowse?: {
        enabled: boolean;
        machineId: string | null;
    };
};
type NavigationState = {
    index: number;
    routes: Array<{ key: string; name?: string; path?: string; params?: Record<string, unknown> }>;
};

function cloneNavigationState(state: { index: number; routes: ReadonlyArray<{ key: string; name?: string; path?: string; params?: Record<string, unknown> }> }): NavigationState {
    return {
        index: state.index,
        routes: state.routes.map((route) => ({
            key: route.key,
            ...(route.name ? { name: route.name } : {}),
            ...(route.path ? { path: route.path } : {}),
            ...(route.params ? { params: route.params } : {}),
        })),
    };
}

let lastPathSelectorProps: PathSelectorProps | null = null;
let routerBackMock = vi.fn();
let routerSetParamsMock = vi.fn();
let routerReplaceMock = vi.fn();
let navigationDispatchMock = vi.fn();
let navigationGoBackMock = vi.fn();
let navigationState: NavigationState = cloneNavigationState(PICKER_NAV_STATE);
let localSearchParams: {
    dataId?: string;
    machineId?: string;
    selectedPath?: string;
    spawnServerId?: string;
} = { machineId: 'm1', selectedPath: '/tmp' };

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
    AppState: { addEventListener: () => ({ remove: () => {} }) },
    TurboModuleRegistry: {
        getEnforcing: () => ({}),
    },
}));

vi.mock('expo-router', () => ({
    Stack: { Screen: () => null },
    useRouter: () => ({ back: routerBackMock, replace: routerReplaceMock, setParams: routerSetParamsMock }),
    useNavigation: () => ({
        getState: () => navigationState,
        dispatch: navigationDispatchMock,
        goBack: navigationGoBackMock,
    }),
    useLocalSearchParams: () => localSearchParams,
}));

vi.mock('@react-navigation/native', () => ({
    CommonActions: {
        setParams: (params: Record<string, unknown>) => ({ type: 'SET_PARAMS', payload: { params } }),
    },
}));

vi.mock('react-native-unistyles', () => {
    const colors = { ...PICKER_THEME_COLORS, shadow: { color: '#000', opacity: 0.2 } };
    return {
        useUnistyles: () => ({ theme: { colors } }),
        StyleSheet: { create: (input: any) => (typeof input === 'function' ? input({ colors }) : input) },
    };
});

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: React.PropsWithChildren<Record<string, never>>) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/layout/layout', () => ({
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

vi.mock('@/sync/domains/state/storage', () => ({
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
        localSearchParams = { machineId: 'm1', selectedPath: '/tmp' };
        navigationState = {
            index: 2,
            routes: [
                { key: 'session-route' },
                { key: 'new-route', name: '(app)/new/index', path: '/new', params: { machineId: 'm1' } },
                { key: 'path-picker', name: '(app)/new/pick/path', path: '/new/pick/path' },
            ],
        };
        routerBackMock.mockClear();
        routerReplaceMock.mockClear();
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

    it('passes machine browse config to PathSelector for the current machine', async () => {
        await renderPathPicker();

        expect(lastPathSelectorProps?.machineBrowse).toEqual({
            enabled: true,
            machineId: 'm1',
        });
    });

    it('sets the selected path on the previous route params when confirming', async () => {
        await renderPathPicker();

        expect(lastPathSelectorProps).toBeTruthy();
        act(() => {
            lastPathSelectorProps?.onSubmitSelectedPath('/Users/leeroy/Documents/Development/happier/dev/apps/stack');
        });

        expect(navigationDispatchMock).toHaveBeenCalledWith(expect.objectContaining({
            type: 'SET_PARAMS',
            source: 'new-route',
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
        localSearchParams = {
            dataId: 'draft-1',
            machineId: 'm1',
            selectedPath: '/tmp',
            spawnServerId: 'server-b',
        };
        await renderPathPicker();

        expect(lastPathSelectorProps).toBeTruthy();
        act(() => {
            lastPathSelectorProps?.onSubmitSelectedPath('');
        });

        expect(navigationDispatchMock).not.toHaveBeenCalled();
        expect(routerBackMock).not.toHaveBeenCalled();
        expect(routerSetParamsMock).not.toHaveBeenCalled();
        expect(routerReplaceMock).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                dataId: 'draft-1',
                machineId: 'm1',
                path: '/home',
                spawnServerId: 'server-b',
            },
        });
    });
});
