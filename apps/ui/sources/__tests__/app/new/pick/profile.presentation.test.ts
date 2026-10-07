import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import {
    createNavigationMock,
    createStackOptionsCapture,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
    PICKER_THEME_COLORS,
    createRouterMock,
} from './testHarness';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const stackOptionsCapture = createStackOptionsCapture();

installPickerCommonModuleMocks({
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            Platform: { OS: 'ios' },
        }),
    expoRouter: async () =>
        (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
            navigation: navigationMock,
            params: { selectedId: '', machineId: 'm1' },
            router: {
                push: routerMock.push,
                back: routerMock.back,
                replace: routerMock.replace,
                setParams: routerMock.setParams,
            },
            stackOptionsCapture,
        }).module,
    unistyles: async () =>
        (await import('@/dev/testkit')).createUnistylesMock({
            theme: { colors: PICKER_THEME_COLORS },
        }),
    modal: async () =>
        (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
            spies: {
                alert: vi.fn(),
                show: vi.fn(),
            },
        }).module,
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

const runtime = installSessionPaneRuntimeTestHarness();

describe('ProfilePickerScreen (iOS presentation)', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        stackOptionsCapture.reset();
        navigationMock.goBack.mockClear();
    });

    it('presents as containedModal on iOS and provides an explicit header back button', async () => {
        const ProfilePickerScreen = (await import('@/app/(app)/new/pick/profile')).default;
        await renderScreen(React.createElement(runtime.Wrapper, null, React.createElement(ProfilePickerScreen)));

        const resolvedOptions = stackOptionsCapture.getResolved();
        expect(resolvedOptions?.presentation).toBe('containedModal');
        expect(typeof resolvedOptions?.headerLeft).toBe('function');

        const backButton = typeof resolvedOptions?.headerLeft === 'function'
            ? resolvedOptions.headerLeft()
            : null;
        expect(typeof backButton?.props?.onPress).toBe('function');
        backButton?.props?.onPress?.();
        expect(navigationMock.goBack).toHaveBeenCalledTimes(1);
    });
});
