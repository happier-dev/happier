import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import type {
    DirectSessionsBrowseInteraction,
    DirectSessionsBrowseScopeLock,
} from '@/components/sessions/directSessions/browse/DirectSessionsBrowseScreen';
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
        agentType: 'claude',
        dataId: 'draft-1',
        machineId: 'machine-2',
        spawnServerId: 'server-2',
    } as Record<string, string>,
}));
const settingsState = vi.hoisted(() => ({
    value: {} as Record<string, unknown>,
}));
type DirectSessionsBrowseScreenProps = Readonly<{
    interaction?: DirectSessionsBrowseInteraction;
    lockScope?: DirectSessionsBrowseScopeLock | null;
    onPickRemoteSessionId?: (remoteSessionId: string) => void;
}>;

const browseScreenPropsRef = { current: null as DirectSessionsBrowseScreenProps | null };

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
                useSettings: () => settingsState.value as any,
            },
        }),
});

vi.mock('@/components/sessions/directSessions/browse/DirectSessionsBrowseScreen', () => ({
    DirectSessionsBrowseScreen: (props: Record<string, unknown>) => {
        browseScreenPropsRef.current = props;
        return null;
    },
}));

vi.mock('@/components/sessions/directSessions/browse/resolveDirectBrowseLockedSourceOption', () => ({
    canBrowseDirectSessions: () => true,
    resolveDirectBrowseLockedSource: () => ({ kind: 'test' }),
}));

vi.mock('@/sync/store/hooks', () => ({
    useProfile: () => ({ id: 'account-1' }),
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    peekTempData: () => ({ machineId: 'machine-2', backendTarget: null, backendNewSessionOptionStateByTargetKey: {} }),
}));

describe('ResumeBrowsePickerScreen replace fallback', () => {
    beforeEach(() => {
        routeParamsState.value = {
            agentType: 'claude',
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'server-2',
        };
        settingsState.value = {};
        browseScreenPropsRef.current = null;
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
                    key: 'resume-browse-route',
                    name: '(app)/new/pick/resume-browse',
                    path: '/new/pick/resume-browse',
                },
            ],
        });
    });

    afterEach(() => {
        standardCleanup();
    });

    it('preserves the new-session context when the browse picker has to replace back to /new', async () => {
        const ResumeBrowsePickerScreen = (await import('@/app/(app)/new/pick/resume-browse')).default;

        await renderScreen(React.createElement(ResumeBrowsePickerScreen));

        const props = browseScreenPropsRef.current;
        expect(typeof props?.onPickRemoteSessionId).toBe('function');

        await props?.onPickRemoteSessionId?.('session-picked');

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                agentType: 'claude',
                dataId: 'draft-1',
                machineId: 'machine-2',
                spawnServerId: 'server-2',
                resumeSessionId: 'session-picked',
            },
        });
        expect(routerMock.setParams).not.toHaveBeenCalled();
        expect(routerMock.back).not.toHaveBeenCalled();
    });

    it('round-trips a serialized backendTarget without reserializing the legacy customAcp agentType', async () => {
        routeParamsState.value = {
            backendTarget: JSON.stringify({ kind: 'configuredAcpBackend', backendId: 'review-bot' }),
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'server-2',
        };
        settingsState.value = {
            acpCatalogSettingsV1: {
                v: 2,
                backends: [
                    {
                        id: 'review-bot',
                        name: 'review-bot',
                        title: 'Review Bot',
                        command: 'custom-acp',
                        args: ['serve'],
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
                    },
                ],
            },
        };

        const ResumeBrowsePickerScreen = (await import('@/app/(app)/new/pick/resume-browse')).default;

        await renderScreen(React.createElement(ResumeBrowsePickerScreen));

        const props = browseScreenPropsRef.current;
        expect(props?.lockScope?.providerId).toBe('customAcp');
        await props?.onPickRemoteSessionId?.('session-picked');

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                backendTarget: JSON.stringify({ kind: 'configuredAcpBackend', backendId: 'review-bot' }),
                backendTargetKey: 'acpBackend:review-bot',
                dataId: 'draft-1',
                machineId: 'machine-2',
                spawnServerId: 'server-2',
                resumeSessionId: 'session-picked',
            },
        });
    });

    it('falls back to the settings-backed configured backend when route context is missing', async () => {
        routeParamsState.value = {
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'server-2',
        };
        settingsState.value = {
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'configuredAcpBackend', backendId: 'review-bot' },
            acpCatalogSettingsV1: {
                v: 2,
                backends: [
                    {
                        id: 'review-bot',
                        name: 'review-bot',
                        title: 'Review Bot',
                        command: 'custom-acp',
                        args: ['serve'],
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
                    },
                ],
            },
        };

        const ResumeBrowsePickerScreen = (await import('@/app/(app)/new/pick/resume-browse')).default;

        await renderScreen(React.createElement(ResumeBrowsePickerScreen));

        const props = browseScreenPropsRef.current;
        expect(props?.lockScope?.providerId).toBe('customAcp');

        await props?.onPickRemoteSessionId?.('session-picked');

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                backendTarget: JSON.stringify({ kind: 'configuredAcpBackend', backendId: 'review-bot' }),
                backendTargetKey: 'acpBackend:review-bot',
                dataId: 'draft-1',
                machineId: 'machine-2',
                spawnServerId: 'server-2',
                resumeSessionId: 'session-picked',
            },
        });
    });
});
