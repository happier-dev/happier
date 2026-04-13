import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type { MachineSelectorProps } from '@/components/sessions/new/components/MachineSelector';
import type { Machine } from '@/sync/domains/state/storageTypes';
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
        lastUsedBackendTarget: null as BackendTargetRefV1 | null,
        backendEnabledByTargetKey: null as Record<string, boolean> | null,
        acpCatalogSettingsV1: null as unknown,
    },
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

vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: (props: MachineSelectorProps) => {
        machineSelectorPropsRef.current = props;
        return null;
    },
}));

vi.mock('@/sync/domains/server/serverProfiles', () => ({
    getActiveServerId: () => 'server-2',
}));

describe('PreviewMachinePickerScreen replace fallback', () => {
    beforeEach(() => {
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

        props?.onSelect?.(previewMachine);

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                agentType: 'claude',
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
            backendTarget: JSON.stringify({ kind: 'configuredAcpBackend', backendId: 'review-bot' }),
            backendTargetKey: 'acpBackend:review-bot',
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'server-2',
        };
        const PreviewMachinePickerScreen = (await import('@/app/(app)/new/pick/preview-machine')).default;

        await renderScreen(React.createElement(PreviewMachinePickerScreen));

        const props = machineSelectorPropsRef.current;
        expect(typeof props?.onSelect).toBe('function');

        props?.onSelect?.(previewMachine);

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                backendTarget: JSON.stringify({ kind: 'configuredAcpBackend', backendId: 'review-bot' }),
                backendTargetKey: 'acpBackend:review-bot',
                dataId: 'draft-1',
                machineId: 'machine-2',
                previewMachineId: 'machine-picked',
                spawnServerId: 'server-2',
            },
        });
    });

    it('rehydrates canonical configured backend params from settings when route params only carry legacy customAcp', async () => {
        settingsState.current = {
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
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

        props?.onSelect?.(previewMachine);

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                agentType: 'customAcp',
                backendTarget: JSON.stringify({ kind: 'configuredAcpBackend', backendId: 'review-bot' }),
                backendTargetKey: 'acpBackend:review-bot',
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

        props?.onSelect?.(previewMachine);

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                agentType: 'codex',
                dataId: 'draft-1',
                machineId: 'machine-2',
                previewMachineId: 'machine-picked',
                spawnServerId: 'server-2',
            },
        });
    });
});
