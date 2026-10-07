import React from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { storage } from '@/sync/domains/state/storageStore';
import { createMachineFixture } from '@/dev/testkit';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const stackOptionsCapture = createStackOptionsCapture();

type PlatformSelectOptions<T> = { ios?: T; default?: T };

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
});

const runtime = installSessionPaneRuntimeTestHarness();
beforeEach(() => {
    storage.getState().applyMachines([createMachineFixture({ id: 'm1', storageMode: 'plain', metadata: {
        host: 'tester.local', platform: 'darwin', happyCliVersion: '0.0.0-test',
        happyHomeDir: '/Users/tester/.happy-dev', homeDir: '/home',
    } })], true, { sourceServerId: runtime.serverId });
    storage.getState().applySettingsLocal({ usePathPickerSearch: false, favoriteDirectories: [] });
});

describe('PathPickerScreen (iOS presentation)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('presents as containedModal on iOS and provides an explicit header back button', async () => {
        const PathPickerScreen = (await import('@/app/(app)/new/pick/path')).default;
        stackOptionsCapture.reset();

        await renderScreen(React.createElement(runtime.Wrapper, null, React.createElement(PathPickerScreen)));

        const options = stackOptionsCapture.getResolved();
        expect(options?.presentation).toBe('containedModal');
        expect(typeof options?.headerLeft).toBe('function');

        // K2 picker route chrome: the leading control is Cancel.
        const backButton = options?.headerLeft?.();
        expect(typeof backButton?.props?.onPress).toBe('function');
        expect(backButton?.props?.testID).toBe('new-session-path-picker-cancel');
        expect(backButton?.props?.appearance).toBe('text');
        backButton?.props?.onPress?.();
        expect(navigationMock.goBack).toHaveBeenCalledTimes(1);

        const confirmButton = options?.headerRight?.();
        expect(typeof confirmButton?.props?.onPress).toBe('function');
        expect(confirmButton?.props?.accessibilityRole).toBe('button');
        expect(confirmButton?.props?.accessibilityLabel).toBe('common.done');
    });
});
