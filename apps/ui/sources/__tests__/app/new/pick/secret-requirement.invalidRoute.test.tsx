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
    PICKER_THEME_COLORS,
} from './testHarness';

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
            params: {},
            router: {
                push: routerMock.push,
                back: routerMock.back,
                replace: routerMock.replace,
                setParams: routerMock.setParams,
            },
            stackOptionsCapture,
        }).module,
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'profiles') return [];
                    return undefined;
                },
                useSettingMutable: () => [{}, vi.fn()],
            },
        }),
    unistyles: async () =>
        (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
            theme: { colors: PICKER_THEME_COLORS },
        }),
});

vi.mock('@/components/secrets/requirements', () => ({
    SecretRequirementScreen: () => React.createElement('SecretRequirementScreen'),
}));

vi.mock('@/components/ui/popover', () => ({
    PopoverScope: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
}));

describe('SecretRequirementPickerScreen invalid route state', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        stackOptionsCapture.reset();
        routerMock.back.mockClear();
        routerMock.replace.mockClear();
        routerMock.setParams.mockClear();
        navigationMock.dispatch.mockClear();
        navigationMock.goBack.mockClear();
        navigationMock.setParams.mockClear();
        navigationMock.getState = () => ({
            index: 0,
            routes: [
                {
                    key: 'secret-requirement-route',
                    name: '(app)/new/pick/secret-requirement',
                    path: '/new/pick/secret-requirement',
                },
            ],
        });
    });

    it('dismisses itself when required route params are missing', async () => {
        const SecretRequirementPickerScreen = (await import('@/app/(app)/new/pick/secret-requirement')).default;
        await renderScreen(React.createElement(SecretRequirementPickerScreen));

        expect(routerMock.replace).toHaveBeenCalledWith('/new');
    });
});
