import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import {
    createNavigationMock,
    createRouterMock,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
} from './testHarness';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const routeParamsState = vi.hoisted(() => ({
    value: {
        providerId: ['claude', 'ignored'],
        machineId: ['machine-9', 'ignored'],
        serverId: ['server-4', 'ignored'],
        dataId: ['draft-7', 'ignored'],
    } as Record<string, unknown>,
}));
const settingsState = vi.hoisted(() => ({
    value: {
        lastUsedAgent: 'claude',
        lastUsedBackendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
        backendEnabledByTargetKey: {},
    } as Record<string, unknown>,
}));

type ExternalSessionsBrowseScreenProps = Readonly<{
    lockScope?: Record<string, unknown> | null;
}>;

const browseScreenPropsRef = { current: null as ExternalSessionsBrowseScreenProps | null };

installPickerCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            Platform: { OS: 'ios' },
        }),
    reactNavigationNative: async () => ({
        ...(await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock(),
        CommonActions: {
            setParams: (params: Record<string, unknown>) => ({ type: 'SET_PARAMS', payload: { params } }),
        },
        useNavigation: () => navigationMock,
    }),
    expoRouter: async () =>
        ({
            ...(await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
                navigation: navigationMock,
                params: () => routeParamsState.value as any,
                router: {
                    push: routerMock.push,
                    back: routerMock.back,
                    replace: routerMock.replace,
                    setParams: routerMock.setParams,
                },
            }).module,
            useNavigation: () => navigationMock,
        }),
    storage: async () =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleStub({
            useSettings: () => settingsState.value as any,
        }),
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    unistyles: async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
});

vi.mock('@/components/sessions/external/browse/ExternalSessionsBrowseScreen', () => ({
    ExternalSessionsBrowseScreen: (props: Record<string, unknown>) => {
        browseScreenPropsRef.current = props;
        return null;
    },
}));

vi.mock('@/components/sessions/external/browse/resolveExternalSessionBrowseLockedSourceOption', () => ({
    canBrowseExternalSessions: () => true,
    resolveExternalSessionBrowseLockedSource: () => ({ kind: 'test' }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useProfile: () => ({ id: 'account-1' }),
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    peekTempData: () => null,
}));

describe('ResumeBrowsePickerScreen legacy param compatibility', () => {
    beforeEach(() => {
        routeParamsState.value = {
            providerId: ['claude', 'ignored'],
            machineId: ['machine-9', 'ignored'],
            serverId: ['server-4', 'ignored'],
            dataId: ['draft-7', 'ignored'],
        };
        settingsState.value = {
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
            backendEnabledByTargetKey: {},
        };
        browseScreenPropsRef.current = null;
        routerMock.push.mockClear();
        routerMock.back.mockClear();
        routerMock.replace.mockClear();
        routerMock.setParams.mockClear();
        navigationMock.dispatch.mockClear();
        navigationMock.goBack.mockClear();
        navigationMock.setParams.mockClear();
    });

    afterEach(() => {
        standardCleanup();
    });

    it('accepts legacy providerId/serverId array params and uses them as the browse lock scope', async () => {
        const ResumeBrowsePickerScreen = (await import('@/app/(app)/new/pick/resume-browse')).default;

        await renderScreen(React.createElement(ResumeBrowsePickerScreen));

        expect(browseScreenPropsRef.current?.lockScope).toEqual(expect.objectContaining({
            machineId: 'machine-9',
            serverId: 'server-4',
            providerId: 'claude',
        }));
    });
});
