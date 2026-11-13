import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
} from './testHarness';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = { ...createNavigationMock(), canGoBack: vi.fn(() => false) };
const stackOptionsCapture = createStackOptionsCapture();

await installPickerCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            Platform: {
                OS: 'web',
            },
        }),
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    unistyles: async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
    expoRouter: async () =>
        (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
            navigation: navigationMock,
            params: { selectedId: 'm1' },
            router: {
                push: routerMock.push,
                back: routerMock.back,
                replace: routerMock.replace,
                setParams: routerMock.setParams,
            },
            stackOptionsCapture,
        }).module,
});

const runtime = installSessionPaneRuntimeTestHarness();

describe('MachinePickerScreen (back fallback)', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        stackOptionsCapture.reset();
        routerMock.push.mockClear();
        routerMock.back.mockClear();
        routerMock.replace.mockClear();
        routerMock.setParams.mockClear();
        navigationMock.dispatch.mockClear();
        navigationMock.goBack.mockClear();
        navigationMock.setParams.mockClear();
        navigationMock.canGoBack.mockReturnValue(false);
    });

    it('replaces to /new when it cannot go back', async () => {
        navigationMock.canGoBack.mockReturnValue(false);
        const MachinePickerScreen = (await import('@/app/(app)/new/pick/machine')).default;
        const screen = await renderScreen(React.createElement(runtime.Wrapper, null, React.createElement(MachinePickerScreen)));
        await screen.pressByTestIdAsync('new-session-machine-picker-cancel');

        // The picker's own `selectedId` is not new-session context, so the
        // structured fallback href carries no params.
        expect(routerMock.replace).toHaveBeenCalledWith({ pathname: '/new', params: {} });
        expect(routerMock.back).toHaveBeenCalledTimes(0);
    });
});
