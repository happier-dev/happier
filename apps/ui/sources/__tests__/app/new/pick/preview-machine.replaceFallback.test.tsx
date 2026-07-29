import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import type { MachineSelectorProps } from '@/components/sessions/new/components/MachineSelector';
import type { Machine } from '@/sync/domains/state/storageTypes';
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
const machineSelectorPropsRef = { current: null as MachineSelectorProps | null };
const routeParamsState = vi.hoisted(() => ({
    value: {
        agentType: 'claude',
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

const previewMachine = {
    id: 'machine-picked',
    seq: 1,
    createdAt: 1,
    updatedAt: 1,
    active: true,
    activeAt: 1,
    revokedAt: null,
    metadata: null,
    metadataVersion: 1,
    daemonState: null,
    daemonStateVersion: 1,
} satisfies Machine;

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
                params: () => routeParamsState.value,
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
                useAllMachines: () => [previewMachine],
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

vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: (props: MachineSelectorProps) => {
        machineSelectorPropsRef.current = props;
        return null;
    },
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerId: () => 'server-2',
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machineContributionRegistryProjectionDescribe: (...args: Parameters<MachineContributionRegistryProjectionDescribeFn>) =>
        machineContributionRegistryProjectionDescribe(...args),
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
}));

describe('PreviewMachinePickerScreen replace fallback', () => {
    beforeEach(() => {
        vi.resetModules();
        routeParamsState.value = {
            agentType: 'claude',
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
        machineSelectorPropsRef.current = null;
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
                    key: 'preview-machine-route',
                    name: '(app)/new/pick/preview-machine',
                    path: '/new/pick/preview-machine',
                },
            ],
        });
    });

    afterEach(() => {
        standardCleanup();
    });

    it('preserves the new-session context when the preview machine picker has to replace back to /new', async () => {
        const PreviewMachinePickerScreen = (await import('@/app/(app)/new/pick/preview-machine')).default;

        await renderScreen(React.createElement(PreviewMachinePickerScreen));

        const props = machineSelectorPropsRef.current;
        expect(typeof props?.onSelect).toBe('function');

        await act(async () => {
            await props?.onSelect?.(previewMachine);
        });

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                agentType: 'claude',
                backendTarget: JSON.stringify({ kind: 'backend', backendId: 'claude' }),
                backendTargetKey: 'backend:claude',
                dataId: 'draft-1',
                machineId: 'machine-2',
                previewMachineId: 'machine-picked',
                spawnServerId: 'server-2',
            },
        });
        expect(routerMock.setParams).not.toHaveBeenCalled();
        expect(routerMock.back).not.toHaveBeenCalled();
    });

    it('preserves configured backend route params when replace fallback is needed without reserializing the legacy customAcp agentType', async () => {
        routeParamsState.value = {
            agentType: 'customAcp',
            backendTarget: JSON.stringify({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' }),
            backendTargetKey: 'backend:review-bot:configured:review-bot',
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'server-2',
        };
        const PreviewMachinePickerScreen = (await import('@/app/(app)/new/pick/preview-machine')).default;

        await renderScreen(React.createElement(PreviewMachinePickerScreen));

        const props = machineSelectorPropsRef.current;
        expect(typeof props?.onSelect).toBe('function');

        await act(async () => {
            await props?.onSelect?.(previewMachine);
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
                previewMachineId: 'machine-picked',
                spawnServerId: 'server-2',
            }),
        }));
        expect(args?.params?.agentType).toBeUndefined();

        const backendTarget = parseJsonRouteParam(args?.params?.backendTarget) as any;
        expect(backendTarget).toMatchObject({
            kind: 'backend',
            backendId: 'review-bot',
            configuredBackendId: 'review-bot',
        });
    });

    it('rehydrates canonical configured backend params from settings when route params only carry legacy customAcp', async () => {
        settingsState.current = {
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
            backendEnabledByTargetKey: null,
            acpCatalogSettingsV1: null,
        };
        routeParamsState.value = {
            agentType: 'customAcp',
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'server-2',
        };
        const PreviewMachinePickerScreen = (await import('@/app/(app)/new/pick/preview-machine')).default;

        await renderScreen(React.createElement(PreviewMachinePickerScreen));

        const props = machineSelectorPropsRef.current;
        expect(typeof props?.onSelect).toBe('function');

        await act(async () => {
            await props?.onSelect?.(previewMachine);
        });

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                backendTarget: JSON.stringify({
                    kind: 'backend',
                    backendId: 'review-bot',
                    configuredBackendId: 'review-bot',
                }),
                backendTargetKey: 'backend:review-bot:configured:review-bot',
                dataId: 'draft-1',
                machineId: 'machine-2',
                previewMachineId: 'machine-picked',
                spawnServerId: 'server-2',
            },
        });
    });

    it('falls back to the preferred built-in target when the stored configured backend is stale', async () => {
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
        routeParamsState.value = {
            agentType: 'customAcp',
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'server-2',
        };
        const PreviewMachinePickerScreen = (await import('@/app/(app)/new/pick/preview-machine')).default;

        await renderScreen(React.createElement(PreviewMachinePickerScreen));

        const props = machineSelectorPropsRef.current;
        expect(typeof props?.onSelect).toBe('function');

        await act(async () => {
            await props?.onSelect?.(previewMachine);
        });

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                agentType: 'codex',
                backendTarget: JSON.stringify({ kind: 'backend', backendId: 'codex' }),
                backendTargetKey: 'backend:codex',
                dataId: 'draft-1',
                machineId: 'machine-2',
                previewMachineId: 'machine-picked',
                spawnServerId: 'server-2',
            },
        });
    });

    it('falls back to the preferred built-in target when route params only carry legacy customAcp even when merged projection lists discovered plugin backends', async () => {
        settingsState.current = {
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: null,
            backendEnabledByTargetKey: null,
            acpCatalogSettingsV1: null,
        };
        routeParamsState.value = {
            agentType: 'customAcp',
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'server-2',
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
        const PreviewMachinePickerScreen = (await import('@/app/(app)/new/pick/preview-machine')).default;

        await renderScreen(React.createElement(PreviewMachinePickerScreen));

        await flushHookEffects({ cycles: 1, turns: 2 });

        const props = machineSelectorPropsRef.current;
        expect(typeof props?.onSelect).toBe('function');

        await act(async () => {
            await props?.onSelect?.(previewMachine);
        });

        expect(machineContributionRegistryProjectionDescribe).toHaveBeenCalledWith('machine-2', expect.objectContaining({
            serverId: 'server-2',
            timeoutMs: 10_000,
        }));
        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                agentType: 'claude',
                backendTarget: JSON.stringify({ kind: 'backend', backendId: 'claude' }),
                backendTargetKey: 'backend:claude',
                dataId: 'draft-1',
                machineId: 'machine-2',
                previewMachineId: 'machine-picked',
                spawnServerId: 'server-2',
            },
        });
    });
});
