import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import {
    createNavigationMock,
    createRouterMock,
    createStackOptionsCapture,
    enableReactActEnvironment,
    PICKER_THEME_COLORS,
    type PickerStackOptionsInput,
} from './testHarness';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const stackOptionsCapture = createStackOptionsCapture();

vi.mock('@/text', () => ({ t: (key: string) => key }));

type PlatformSelectOptions<T> = { ios?: T; default?: T };
type ItemGroupProps = React.PropsWithChildren<Record<string, never>>;

vi.mock('react-native', () => ({
    View: 'View',
    Text: 'Text',
    Pressable: 'Pressable',
    Platform: { OS: 'ios', select: <T,>(options: PlatformSelectOptions<T>) => options.ios ?? options.default },
    TurboModuleRegistry: { getEnforcing: () => ({}) },
}));

vi.mock('expo-router', () => ({
    Stack: {
        Screen: ({ options }: { options: PickerStackOptionsInput }) => {
            stackOptionsCapture.record(options);
            return null;
        },
    },
    useRouter: () => routerMock,
    useNavigation: () => navigationMock,
    useLocalSearchParams: () => ({ machineId: 'm1', selectedPath: '/tmp' }),
}));

vi.mock('@react-navigation/native', () => ({
    CommonActions: {
        setParams: (params: any) => ({ type: 'SET_PARAMS', payload: { params } }),
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
    ItemList: ({ children }: ItemGroupProps) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/layout', () => ({
    layout: { maxWidth: 900 },
}));

vi.mock('@/components/ui/forms/SearchHeader', () => ({
    SearchHeader: () => null,
}));

vi.mock('@/components/sessions/new/components/PathSelector', () => ({
    PathSelector: () => null,
}));

vi.mock('@/utils/sessions/recentPaths', () => ({
    getRecentPathsForMachine: () => [],
}));

vi.mock('@/sync/storage', () => ({
    useAllMachines: () => [{ id: 'm1', metadata: { homeDir: '/home' } }],
    useSessions: () => [],
    useSetting: (key: string) => {
        if (key === 'recentMachinePaths') return [];
        if (key === 'usePathPickerSearch') return false;
        return null;
    },
    useSettingMutable: () => [[], vi.fn()],
}));

describe('PathPickerScreen (iOS presentation)', () => {
    it('presents as containedModal on iOS and provides an explicit header back button', async () => {
        const PathPickerScreen = (await import('@/app/(app)/new/pick/path')).default;
        stackOptionsCapture.reset();

        await act(async () => {
            renderer.create(React.createElement(PathPickerScreen));
        });

        const options = stackOptionsCapture.getResolved();
        expect(options?.presentation).toBe('containedModal');
        expect(typeof options?.headerLeft).toBe('function');

        const backButton = options?.headerLeft?.();
        expect(typeof backButton?.props?.onPress).toBe('function');
        backButton?.props?.onPress?.();
        expect(routerMock.back).toHaveBeenCalledTimes(1);
    });
});
