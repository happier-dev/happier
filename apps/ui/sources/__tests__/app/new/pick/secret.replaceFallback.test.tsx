import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import type { SecretsListProps } from '@/components/secrets/SecretsList';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { BackendTargetRefV2 } from '@happier-dev/protocol';
import {
    createNavigationMock,
    createRouterMock,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
    parseJsonRouteParam,
} from './testHarness';
import { createUseSettingMutableMockFromReader } from '@/dev/testkit/mocks/storage';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const secretsListPropsRef = { current: null as SecretsListProps | null };
const routeParamsState = vi.hoisted(() => ({
    current: {
        agentType: 'claude',
        backendTarget: JSON.stringify({
            kind: 'backend',
            backendId: 'claude-sonnet',
            configuredBackendId: 'claude-sonnet',
        }),
        backendTargetKey: 'backend:claude-sonnet:configured:claude-sonnet',
        dataId: 'draft-1',
        machineId: 'machine-2',
        spawnServerId: 'server-2',
    } as Record<string, string>,
}));
const settingsState = vi.hoisted(() => ({
    current: {
        lastUsedAgent: 'claude',
        lastUsedBackendTarget: null as BackendTargetRefV2 | null,
        backendEnabledByTargetKey: null as Record<string, boolean> | null,
        acpCatalogSettingsV1: null as unknown,
    },
}));
type MachineContributionRegistryProjectionDescribeFn =
    typeof import('@/sync/ops/machineContributionRegistryProjection').machineContributionRegistryProjectionDescribe;
const {
    machineContributionRegistryProjectionDescribe,
} = vi.hoisted(() => ({
    machineContributionRegistryProjectionDescribe: vi.fn<MachineContributionRegistryProjectionDescribeFn>(
        async () => ({ supported: false, reason: 'not-supported' }),
    ),
}));

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
                useSettingMutable: createUseSettingMutableMockFromReader(() => [[], vi.fn()]),
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

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machineContributionRegistryProjectionDescribe: (...args: Parameters<MachineContributionRegistryProjectionDescribeFn>) =>
        machineContributionRegistryProjectionDescribe(...args),
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
}));

describe('SecretPickerScreen replace fallback', () => {
    beforeEach(() => {
        vi.resetModules();
        routeParamsState.current = {
            agentType: 'claude',
            backendTarget: JSON.stringify({
                kind: 'backend',
                backendId: 'claude-sonnet',
                configuredBackendId: 'claude-sonnet',
            }),
            backendTargetKey: 'backend:claude-sonnet:configured:claude-sonnet',
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
        machineContributionRegistryProjectionDescribe.mockReset();
        machineContributionRegistryProjectionDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' });
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

        await act(async () => {
            await props?.onSelectId?.('secret-picked');
        });

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                backendTarget: JSON.stringify({
                    kind: 'backend',
                    backendId: 'claude-sonnet',
                    configuredBackendId: 'claude-sonnet',
                }),
                backendTargetKey: 'backend:claude-sonnet:configured:claude-sonnet',
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
            lastUsedBackendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
            backendEnabledByTargetKey: null,
            acpCatalogSettingsV1: null,
        };
        const SecretPickerScreen = (await import('@/app/(app)/new/pick/secret')).default;

        await renderScreen(React.createElement(SecretPickerScreen));

        const props = secretsListPropsRef.current;
        expect(typeof props?.onSelectId).toBe('function');

        await act(async () => {
            await props?.onSelectId?.('secret-picked');
        });

        expect(routerMock.replace).toHaveBeenCalledTimes(1);
        const [call] = routerMock.replace.mock.calls;
        const args = call?.[0] as any;

        expect(args).toEqual(expect.objectContaining({
            pathname: '/new',
            params: expect.objectContaining({
                backendTargetKey: 'backend:review-bot:configured:review-bot',
                dataId: 'draft-1',
                machineId: 'machine-2',
                secretId: 'secret-picked',
                spawnServerId: 'server-2',
            }),
        }));

        const backendTarget = parseJsonRouteParam(args?.params?.backendTarget) as any;
        expect(backendTarget).toMatchObject({
            kind: 'backend',
            backendId: 'review-bot',
            configuredBackendId: 'review-bot',
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
            lastUsedBackendTarget: { kind: 'backend', backendId: 'stale-review-bot', configuredBackendId: 'stale-review-bot', sourceKind: 'configured' },
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

        await act(async () => {
            await props?.onSelectId?.('secret-picked');
        });

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                agentType: 'codex',
                backendTarget: JSON.stringify({ kind: 'backend', backendId: 'codex' }),
                backendTargetKey: 'backend:codex',
                dataId: 'draft-1',
                machineId: 'machine-2',
                secretId: 'secret-picked',
                spawnServerId: 'server-2',
            },
        });
    });

    it('falls back to the preferred built-in target when route params only carry legacy customAcp even when merged projection lists discovered plugin backends', async () => {
        routeParamsState.current = {
            agentType: 'customAcp',
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'server-2',
        };
        settingsState.current = {
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: null,
            backendEnabledByTargetKey: null,
            acpCatalogSettingsV1: null,
        };
        machineContributionRegistryProjectionDescribe.mockResolvedValue({
            supported: true,
            projection: {
                v: 1,
                agentsById: {
                    'acme.review.provider': {
                        id: 'acme.review.provider',
                        title: 'Acme Review Provider',
                        channel: 'plugin',
                        isBuiltIn: false,
                        settingsBackendId: 'acme.review.backend',
                    },
                },
                backendsById: {
                    'acme.review.backend': {
                        id: 'acme.review.backend',
                        backendId: 'acme.review.backend',
                        agentId: 'acme.review.provider',
                        title: 'Acme Review Backend',
                    },
                },
            },
        });
        const SecretPickerScreen = (await import('@/app/(app)/new/pick/secret')).default;

        await renderScreen(React.createElement(SecretPickerScreen));

        await flushHookEffects({ cycles: 1, turns: 2 });

        const props = secretsListPropsRef.current;
        expect(typeof props?.onSelectId).toBe('function');

        await act(async () => {
            await props?.onSelectId?.('secret-picked');
        });

        expect(machineContributionRegistryProjectionDescribe).toHaveBeenCalledWith('machine-2', expect.objectContaining({
            serverId: 'server-2',
            timeoutMs: 10_000,
        }));
        expect(routerMock.replace).toHaveBeenCalledTimes(1);
        const [call] = routerMock.replace.mock.calls;
        const args = call?.[0] as any;

        expect(args).toEqual(expect.objectContaining({
            pathname: '/new',
            params: expect.objectContaining({
                agentType: 'claude',
                backendTargetKey: 'backend:claude',
                dataId: 'draft-1',
                machineId: 'machine-2',
                secretId: 'secret-picked',
                spawnServerId: 'server-2',
            }),
        }));

        const backendTarget = parseJsonRouteParam(args?.params?.backendTarget) as any;
        expect(backendTarget).toMatchObject({ kind: 'backend', backendId: 'claude' });
    });
});
