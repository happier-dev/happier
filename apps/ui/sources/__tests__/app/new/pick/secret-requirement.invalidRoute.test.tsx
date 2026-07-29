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
import { settingsDefaults } from '@/sync/domains/settings/settings';
import { createUseSettingMock, createUseSettingMutableMockFromReader } from '@/dev/testkit/mocks/storage';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const stackOptionsCapture = createStackOptionsCapture();
const routeParamsState = vi.hoisted(() => ({
    current: {} as Record<string, string>,
}));
const storeTempDataSpy = vi.hoisted(() => vi.fn(() => 'invalid-secret-result-id'));

installPickerCommonModuleMocks({
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            Platform: { OS: 'ios' },
        }),
    expoRouter: async () =>
        (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
            navigation: navigationMock,
            params: () => routeParamsState.current,
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
                useSetting: createUseSettingMock({ fallback: (key) => {
                    if (key === 'profiles') return [];
                    return undefined;
                } }),
                useSettingMutable: createUseSettingMutableMockFromReader((key) => {
                    if (key === 'secrets') return [[], vi.fn()];
                    return [{}, vi.fn()];
                }),
                useSettings: () => settingsDefaults,
            },
        }),
    unistyles: async () =>
        (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
            theme: { colors: PICKER_THEME_COLORS },
        }),
});

vi.mock('@/agents/backendCatalog/useDaemonMergedProjectionInputs', () => ({
    useDaemonMergedProjectionInputs: () => ({ inputs: null }),
}));

vi.mock('@/components/secrets/requirements', () => ({
    SecretRequirementScreen: () => React.createElement('SecretRequirementScreen'),
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    storeTempData: (...args: Parameters<typeof storeTempDataSpy>) => storeTempDataSpy(...args),
}));

vi.mock('@/components/ui/popover', () => ({
    PopoverScope: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
}));

describe('SecretRequirementPickerScreen invalid route state', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        routeParamsState.current = {};
        storeTempDataSpy.mockClear();
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

    it('returns a cancel result with current backend route context when the profile route state is unusable', async () => {
        routeParamsState.current = {
            agentType: 'customAcp',
            backendTarget: JSON.stringify({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' }),
            backendTargetKey: 'backend:review-bot:configured:review-bot',
            dataId: 'draft-1',
            machineId: 'machine-1',
            profileId: 'missing-profile',
            spawnServerId: 'server-2',
        };

        const SecretRequirementPickerScreen = (await import('@/app/(app)/new/pick/secret-requirement')).default;
        await renderScreen(React.createElement(SecretRequirementPickerScreen));

        expect(storeTempDataSpy).toHaveBeenCalledWith({
            profileId: 'missing-profile',
            revertOnCancel: false,
            result: { action: 'cancel' },
        });
        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: expect.objectContaining({
                backendTarget: routeParamsState.current.backendTarget,
                backendTargetKey: 'backend:review-bot:configured:review-bot',
                dataId: 'draft-1',
                machineId: 'machine-1',
                profileId: 'missing-profile',
                secretRequirementResultId: 'invalid-secret-result-id',
                spawnServerId: 'server-2',
            }),
        });
    });
});
