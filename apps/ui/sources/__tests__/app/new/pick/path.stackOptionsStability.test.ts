import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import {
    createNavigationMock,
    createRouterMock,
    enableReactActEnvironment,
    PICKER_NAV_STATE,
    PICKER_THEME_COLORS,
    type PickerStackOptionsInput,
} from './testHarness';

enableReactActEnvironment();

const stableMachines = [{ id: 'm1', metadata: { homeDir: '/home' } }] as const;
const stableSessions: readonly unknown[] = [];
const stableRecentMachinePaths: readonly unknown[] = [];
const stableFavoriteDirectories: readonly string[] = [];
let localSearchParams: { machineId: string; selectedPath: string } = { machineId: 'm1', selectedPath: '' };

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

type ItemGroupProps = React.PropsWithChildren<Record<string, never>>;
type PathSelectorProps = {
    onChangeSearchQuery?: (value: string) => void;
};

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: ItemGroupProps) => React.createElement('ItemList', null, children),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 720 },
}));

vi.mock('@/components/sessions/new/components/PathSelector', () => ({
    PathSelector: (props: PathSelectorProps) => {
        const didTriggerRef = React.useRef(false);
        React.useEffect(() => {
            if (didTriggerRef.current) return;
            didTriggerRef.current = true;
            // Trigger a state update that should NOT require updating Stack.Screen options.
            props.onChangeSearchQuery?.('abc');
        }, [props]);
        return null;
    },
}));

vi.mock('@/components/ui/forms/SearchHeader', () => ({
    SearchHeader: () => null,
}));

vi.mock('@/utils/sessions/recentPaths', () => ({
    getRecentPathsForMachine: () => [],
}));

vi.mock('react-native', () => ({
    Platform: { OS: 'ios' },
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({ theme: { colors: PICKER_THEME_COLORS } }),
    StyleSheet: { create: () => ({}) },
}));

vi.mock('@react-navigation/native', () => ({
    CommonActions: {
        setParams: (params: Record<string, unknown>) => ({ type: 'SET_PARAMS', payload: { params } }),
    },
}));

vi.mock('@/sync/domains/state/storage', () => ({
    useAllMachines: () => stableMachines,
    useSessions: () => stableSessions,
    useSetting: (key: string) => {
        if (key === 'usePathPickerSearch') return false;
        if (key === 'recentMachinePaths') return stableRecentMachinePaths;
        return null;
    },
    useSettingMutable: () => [stableFavoriteDirectories, vi.fn()],
}));

describe('PathPickerScreen (Stack.Screen options stability)', () => {
    it('keeps Stack.Screen options referentially stable across parent re-renders', async () => {
        const routerApi = createRouterMock();
        const navigationApi = createNavigationMock();
        navigationApi.getState = () => PICKER_NAV_STATE;
        const setOptions = vi.fn();

        vi.doMock('expo-router', () => ({
            Stack: {
                Screen: ({ options }: { options: PickerStackOptionsInput }) => {
                    React.useEffect(() => {
                        setOptions(options);
                    }, [options]);
                    return null;
                },
            },
            useRouter: () => routerApi,
            useNavigation: () => navigationApi,
            useLocalSearchParams: () => localSearchParams,
        }));

        const PathPickerScreen = (await import('@/app/(app)/new/pick/path')).default;
        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(React.createElement(PathPickerScreen));
        });

        localSearchParams = { machineId: 'm1', selectedPath: '/tmp/next' };
        await act(async () => {
            tree?.update(React.createElement(PathPickerScreen));
        });

        expect(setOptions).toHaveBeenCalledTimes(1);
    });
});
