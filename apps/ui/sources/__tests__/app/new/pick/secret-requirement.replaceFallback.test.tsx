import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { settingsDefaults } from '@/sync/domains/settings/settings';
import type { SecretRequirementScreenProps } from '@/components/secrets/requirements';
import {
    createNavigationMock,
    createRouterMock,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
    parseJsonRouteParam,
} from './testHarness';
import { createUseSettingMock, createUseSettingMutableMockFromReader } from '@/dev/testkit/mocks/storage';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const secretRequirementScreenPropsRef = { current: null as SecretRequirementScreenProps | null };
const routeParamsState = vi.hoisted(() => ({
    current: {
        agentType: 'customAcp',
        dataId: 'draft-1',
        profileId: 'deepseek',
        machineId: 'machine-2',
        secretEnvVarName: 'OPENAI_API_KEY',
        secretEnvVarNames: 'OPENAI_API_KEY',
        spawnServerId: 'server-2',
    } as Record<string, string>,
}));
const settingsState = vi.hoisted(() => ({
    current: {
        lastUsedAgent: 'customAcp',
        lastUsedBackendTarget: null as unknown,
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
                useSetting: createUseSettingMock({ fallback: (key) => {
                    if (key === 'profiles') {
                        return [{ id: 'deepseek', name: 'DeepSeek', compatibility: { codex: true }, isBuiltIn: false }];
                    }
                    return [];
                } }),
                useSettingMutable: createUseSettingMutableMockFromReader(() => [[], vi.fn()]),
                useSettings: () => ({
                    ...settingsDefaults,
                    lastUsedAgent: settingsState.current.lastUsedAgent,
                    lastUsedBackendTarget:
                        settingsState.current.lastUsedBackendTarget as unknown as typeof settingsDefaults.lastUsedBackendTarget,
                    backendEnabledByTargetKey:
                        settingsState.current.backendEnabledByTargetKey as unknown as typeof settingsDefaults.backendEnabledByTargetKey,
                    acpCatalogSettingsV1:
                        settingsState.current.acpCatalogSettingsV1 as unknown as typeof settingsDefaults.acpCatalogSettingsV1,
                }),
            },
        }),
});

vi.mock('@/components/secrets/requirements', () => ({
    SecretRequirementScreen: (props: SecretRequirementScreenProps) => {
        secretRequirementScreenPropsRef.current = props;
        return null;
    },
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    storeTempData: () => 'temp-secret-result-id',
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

describe('SecretRequirementPickerScreen replace fallback', () => {
    beforeEach(() => {
        routeParamsState.current = {
            agentType: 'customAcp',
            dataId: 'draft-1',
            profileId: 'deepseek',
            machineId: 'machine-2',
            secretEnvVarName: 'OPENAI_API_KEY',
            secretEnvVarNames: 'OPENAI_API_KEY',
            spawnServerId: 'server-2',
        };
        settingsState.current = {
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: null,
            backendEnabledByTargetKey: null,
            acpCatalogSettingsV1: null,
        };
        secretRequirementScreenPropsRef.current = null;
        routerMock.replace.mockClear();
        routerMock.push.mockClear();
        routerMock.back.mockClear();
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
                    key: 'secret-requirement-picker-route',
                    name: '(app)/new/pick/secret-requirement',
                    path: '/new/pick/secret-requirement',
                },
            ],
        });
    });

    afterEach(() => {
        standardCleanup();
    });

    it('falls back to the preferred built-in target when route params only carry legacy customAcp and no explicit backend target is stored', async () => {
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

        const SecretRequirementPickerScreen = (await import('@/app/(app)/new/pick/secret-requirement')).default;
        await renderScreen(React.createElement(SecretRequirementPickerScreen));
        await flushHookEffects({ cycles: 1, turns: 2 });

        const props = secretRequirementScreenPropsRef.current;
        expect(typeof props?.onResolve).toBe('function');

        await act(async () => {
            await props?.onResolve?.({ action: 'cancel' });
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
                profileId: 'deepseek',
                secretRequirementResultId: 'temp-secret-result-id',
                spawnServerId: 'server-2',
            }),
        }));

        const backendTarget = parseJsonRouteParam(args?.params?.backendTarget) as any;
        expect(backendTarget).toMatchObject({ kind: 'backend', backendId: 'claude' });
    });
});
