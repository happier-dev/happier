import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SecretsListProps } from '@/components/secrets/SecretsList';
import {
    createNavigationMock,
    createRouterMock,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
} from './testHarness';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const secretsListPropsRef = { current: null as SecretsListProps | null };

installPickerCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            Platform: { OS: 'ios' },
        }),
    reactNavigationNative: async () => ({
        CommonActions: {
            setParams: (params: Record<string, unknown>) => ({ type: 'SET_PARAMS', payload: { params } }),
        },
        useNavigation: () => navigationMock,
    }),
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    unistyles: async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
    expoRouter: async () =>
        ({
            ...(await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
                navigation: navigationMock,
                params: {
                    agentType: 'claude',
                    dataId: 'draft-1',
                    machineId: 'machine-2',
                    spawnServerId: 'server-2',
                },
                router: {
                    push: routerMock.push,
                    back: routerMock.back,
                    replace: routerMock.replace,
                    setParams: routerMock.setParams,
                },
            }).module,
            useNavigation: () => navigationMock,
        }),
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
            importOriginal,
            overrides: {
                useSettingMutable: () => [[], vi.fn()],
            },
        }),
});

vi.mock('@/components/secrets/SecretsList', () => ({
    SecretsList: (props: SecretsListProps) => {
        secretsListPropsRef.current = props;
        return null;
    },
}));

describe('SecretPickerScreen replace fallback', () => {
    beforeEach(() => {
        secretsListPropsRef.current = null;
        routerMock.push.mockClear();
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
                    key: 'secret-picker-route',
                    name: '(app)/new/pick/secret',
                    path: '/new/pick/secret',
                },
            ],
        });
    });

    afterEach(() => {
        standardCleanup();
    });

    it('preserves the new-session context when the secret picker has to replace back to /new', async () => {
        const SecretPickerScreen = (await import('@/app/(app)/new/pick/secret')).default;

        await renderScreen(React.createElement(SecretPickerScreen));

        const props = secretsListPropsRef.current;
        expect(typeof props?.onSelectId).toBe('function');

        props?.onSelectId?.('secret-picked');

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                agentType: 'claude',
                dataId: 'draft-1',
                machineId: 'machine-2',
                secretId: 'secret-picked',
                spawnServerId: 'server-2',
            },
        });
        expect(routerMock.setParams).not.toHaveBeenCalled();
        expect(routerMock.back).not.toHaveBeenCalled();
    });
});
