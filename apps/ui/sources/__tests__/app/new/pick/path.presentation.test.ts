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
    installPickerCommonModuleMocks,
    PICKER_THEME_COLORS,
} from './testHarness';
import { createUseSettingMock, createUseSettingMutableMockFromReader } from '@/dev/testkit/mocks/storage';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const stackOptionsCapture = createStackOptionsCapture();

type PlatformSelectOptions<T> = { ios?: T; default?: T };
type ItemGroupProps = React.PropsWithChildren<Record<string, never>>;

installPickerCommonModuleMocks({
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            Platform: { OS: 'ios', select: <T,>(options: PlatformSelectOptions<T>) => options.ios ?? options.default },
            TurboModuleRegistry: { getEnforcing: () => ({}) },
        }),
    expoRouter: async () =>
        (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
            navigation: navigationMock,
            params: { machineId: 'm1', selectedPath: '/tmp' },
            router: {
                push: routerMock.push,
                back: routerMock.back,
                replace: routerMock.replace,
                setParams: routerMock.setParams,
            },
            stackOptionsCapture,
        }).module,
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        const colors = { ...PICKER_THEME_COLORS, shadow: { color: '#000', opacity: 0.2 } };
        return createUnistylesMock({
            theme: { colors },
        });
    },
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
            importOriginal,
            overrides: {
                // Boundary fixture: this picker only needs the selected machine homeDir.
                useAllMachines: (() => [{ id: 'm1', metadata: { homeDir: '/home' } }]) as any,
                useAllSessionListRenderables: () => [],
                useSetting: createUseSettingMock({ fallback: (key) => {
                    if (key === 'recentMachinePaths') return [];
                    if (key === 'usePathPickerSearch') return false;
                    return null;
                } }),
                useSettingMutable: createUseSettingMutableMockFromReader(() => [[], vi.fn()]),
            },
        }),
});

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 900 },
    useLayoutMaxWidth: () => 900,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 900 }),
}));

vi.mock('@/components/ui/forms/SearchHeader', () => ({
    SearchHeader: () => null,
}));

vi.mock('@/components/sessions/new/components/PathSelectionList', () => ({
    PathSelectionList: () => null,
}));

vi.mock('@/utils/sessions/recentPaths', () => ({
    getRecentPathsForMachine: () => [],
}));

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
        expect(backButton?.props?.accessibilityRole).toBe('button');
        expect(backButton?.props?.accessibilityLabel).toBe('common.back');
        backButton?.props?.onPress?.();
        expect(navigationMock.goBack).toHaveBeenCalledTimes(1);

        const confirmButton = options?.headerRight?.();
        expect(typeof confirmButton?.props?.onPress).toBe('function');
        expect(confirmButton?.props?.accessibilityRole).toBe('button');
        expect(confirmButton?.props?.accessibilityLabel).toBe('common.done');
    });
});
