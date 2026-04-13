import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { SecretsListProps } from '@/components/secrets/SecretsList';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { BackendTargetRefV1 } from '@happier-dev/protocol';
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
const routeParamsState = vi.hoisted(() => ({
    current: {
        agentType: 'claude',
        backendTarget: JSON.stringify({
            kind: 'configuredAcpBackend',
            backendId: 'claude-sonnet',
        }),
        backendTargetKey: 'acpBackend:claude-sonnet',
        dataId: 'draft-1',
        machineId: 'machine-2',
        spawnServerId: 'server-2',
    } as Record<string, string>,
}));
const settingsState = vi.hoisted(() => ({
    current: {
        lastUsedAgent: 'claude',
        lastUsedBackendTarget: null as BackendTargetRefV1 | null,
        backendEnabledByTargetKey: null as Record<string, boolean> | null,
        acpCatalogSettingsV1: null as unknown,
    },
}));

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
                params: () => routeParamsState.current,
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
                useSettings: () => ({
                    ...settingsDefaults,
                    lastUsedAgent: settingsState.current.lastUsedAgent,
                    lastUsedBackendTarget: settingsState.current.lastUsedBackendTarget,
                    backendEnabledByTargetKey:
                        settingsState.current.backendEnabledByTargetKey as unknown as typeof settingsDefaults.backendEnabledByTargetKey,
                    acpCatalogSettingsV1:
                        settingsState.current.acpCatalogSettingsV1 as unknown as typeof settingsDefaults.acpCatalogSettingsV1,
                }),
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
        routeParamsState.current = {
            agentType: 'claude',
            backendTarget: JSON.stringify({
                kind: 'configuredAcpBackend',
                backendId: 'claude-sonnet',
            }),
            backendTargetKey: 'acpBackend:claude-sonnet',
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'server-2',
        };
        settingsState.current = {
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: null,
            backendEnabledByTargetKey: null,
            acpCatalogSettingsV1: null,
        };
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
                backendTarget: JSON.stringify({
                    kind: 'configuredAcpBackend',
                    backendId: 'claude-sonnet',
                }),
                backendTargetKey: 'acpBackend:claude-sonnet',
                dataId: 'draft-1',
                machineId: 'machine-2',
                secretId: 'secret-picked',
                spawnServerId: 'server-2',
            },
        });
        expect(routerMock.setParams).not.toHaveBeenCalled();
        expect(routerMock.back).not.toHaveBeenCalled();
    });

    it('rehydrates canonical configured backend params from settings when route params only carry legacy customAcp', async () => {
        routeParamsState.current = {
            agentType: 'customAcp',
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'server-2',
        };
        settingsState.current = {
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            backendEnabledByTargetKey: null,
            acpCatalogSettingsV1: null,
        };
        const SecretPickerScreen = (await import('@/app/(app)/new/pick/secret')).default;

        await renderScreen(React.createElement(SecretPickerScreen));

        const props = secretsListPropsRef.current;
        expect(typeof props?.onSelectId).toBe('function');

        props?.onSelectId?.('secret-picked');

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                agentType: 'customAcp',
                backendTarget: JSON.stringify({
                    kind: 'configuredAcpBackend',
                    backendId: 'review-bot',
                }),
                backendTargetKey: 'acpBackend:review-bot',
                dataId: 'draft-1',
                machineId: 'machine-2',
                secretId: 'secret-picked',
                spawnServerId: 'server-2',
            },
        });
    });

    it('falls back to the preferred built-in target when the stored configured backend is stale', async () => {
        routeParamsState.current = {
            agentType: 'customAcp',
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'server-2',
        };
        settingsState.current = {
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'stale-review-bot' },
            backendEnabledByTargetKey: { 'agent:codex': true },
            acpCatalogSettingsV1: {
                v: 2,
                backends: [{
                    id: 'review-bot',
                    name: 'review-bot',
                    title: 'Review Bot',
                    command: 'review-bot',
                    args: [],
                    env: {},
                    transportProfile: 'generic',
                    capabilities: {
                        supportsLoadSession: false,
                        supportsModes: 'unknown',
                        supportsModels: 'unknown',
                        supportsConfigOptions: 'unknown',
                        promptImageSupport: 'unknown',
                    },
                    createdAt: 1,
                    updatedAt: 1,
                }],
            },
        };
        const SecretPickerScreen = (await import('@/app/(app)/new/pick/secret')).default;

        await renderScreen(React.createElement(SecretPickerScreen));

        const props = secretsListPropsRef.current;
        expect(typeof props?.onSelectId).toBe('function');

        props?.onSelectId?.('secret-picked');

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                agentType: 'codex',
                dataId: 'draft-1',
                machineId: 'machine-2',
                secretId: 'secret-picked',
                spawnServerId: 'server-2',
            },
        });
    });
});
