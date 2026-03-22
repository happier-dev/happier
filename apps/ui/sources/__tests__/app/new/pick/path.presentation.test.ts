import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import {
    createNavigationMock,
    createRouterMock,
    createStackOptionsCapture,
    enableReactActEnvironment,
    PICKER_THEME_COLORS,
} from './testHarness';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const stackOptionsCapture = createStackOptionsCapture();

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});

type PlatformSelectOptions<T> = { ios?: T; default?: T };
type ItemGroupProps = React.PropsWithChildren<Record<string, never>>;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                        Platform: { OS: 'ios', select: <T,>(options: PlatformSelectOptions<T>) => options.ios ?? options.default },
                                        TurboModuleRegistry: { getEnforcing: () => ({}) },
                                    }
    );
});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({
        navigation: navigationMock,
        params: { machineId: 'm1', selectedPath: '/tmp' },
        router: {
            push: routerMock.push,
            back: routerMock.back,
            replace: routerMock.replace,
            setParams: routerMock.setParams,
        },
        stackOptionsCapture,
    }).module;
});

vi.mock('@react-navigation/native', () => ({
    CommonActions: {
        setParams: (params: any) => ({ type: 'SET_PARAMS', payload: { params } }),
    },
}));

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    const colors = { ...PICKER_THEME_COLORS, shadow: { color: '#000', opacity: 0.2 } };
    return createUnistylesMock({
        theme: { colors },
    });
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('@/components/ui/lists/ItemList', () => ({
    ItemList: ({ children }: ItemGroupProps) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/layout/layout', () => ({
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

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            // Boundary fixture: this picker only needs the selected machine homeDir.
            useAllMachines: (() => [{ id: 'm1', metadata: { homeDir: '/home' } }]) as any,
            useSessions: () => [],
            useSetting: (key: string) => {
                if (key === 'recentMachinePaths') return [];
                if (key === 'usePathPickerSearch') return false;
                return null;
            },
            useSettingMutable: () => [[], vi.fn()],
        },
    });
});

describe('PathPickerScreen (iOS presentation)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('presents as containedModal on iOS and provides an explicit header back button', async () => {
        const PathPickerScreen = (await import('@/app/(app)/new/pick/path')).default;
        stackOptionsCapture.reset();

        await renderScreen(React.createElement(PathPickerScreen));

        const options = stackOptionsCapture.getResolved();
        expect(options?.presentation).toBe('containedModal');
        expect(typeof options?.headerLeft).toBe('function');

        const backButton = options?.headerLeft?.();
        expect(typeof backButton?.props?.onPress).toBe('function');
        backButton?.props?.onPress?.();
        expect(routerMock.back).toHaveBeenCalledTimes(1);
    });
});
