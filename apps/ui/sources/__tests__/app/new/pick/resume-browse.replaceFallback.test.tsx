import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import type {
    ExternalSessionsBrowseInteraction,
    ExternalSessionsBrowseScopeLock,
} from '@/components/sessions/external/browse/ExternalSessionsBrowseScreen';
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
const externalSessionBrowseSupportState = vi.hoisted(() => ({
    supportedByProviderId: {} as Record<string, boolean>,
}));
const featureDecisionState = vi.hoisted(() => ({
    state: 'enabled' as 'enabled' | 'disabled' | 'unknown' | null,
}));
const featureDecisionSpy = vi.hoisted(() => vi.fn());
const machineContributionRegistryProjectionDescribeMock = vi.hoisted(() =>
    vi.fn<(...args: unknown[]) => Promise<any>>(async () => ({ supported: false, reason: 'not-supported' })),
);
type ExternalSessionsBrowseScreenProps = Readonly<{
    interaction?: ExternalSessionsBrowseInteraction;
    lockScope?: ExternalSessionsBrowseScopeLock | null;
    onPickRemoteSessionId?: (remoteSessionId: string) => void;
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
    storage: async () =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleStub({
            useSettings: () => settingsState.value as any,
        }),
});

vi.mock('@/components/sessions/external/browse/ExternalSessionsBrowseScreen', () => ({
    ExternalSessionsBrowseScreen: (props: Record<string, unknown>) => {
        browseScreenPropsRef.current = props;
        return null;
    },
}));

vi.mock('@/components/sessions/external/browse/resolveExternalSessionBrowseLockedSourceOption', () => ({
    // Production calls `canBrowseExternalSessions` with an OBJECT, not a bare provider id:
    // a mock taking `(providerId: string)` indexed by `undefined` and answered true for
    // the wrong reason. This suite drives carrier RESOLUTION, so capability stays
    // permissive here; the projection-phase contract is covered by
    // `resume-browse.coldProjection.test.tsx` against the real resolver.
    canBrowseExternalSessions: (params: { agentId: string }) => (
        externalSessionBrowseSupportState.supportedByProviderId[params.agentId] ?? true
    ),
    resolveExternalSessionBrowseLockedSource: (params: { providerId: string }) => (
        (externalSessionBrowseSupportState.supportedByProviderId[params.providerId] ?? true)
            ? { kind: 'test' }
            : null
    ),
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: (...args: unknown[]) => {
        featureDecisionSpy(...args);
        return featureDecisionState.state === null
            ? null
            : { state: featureDecisionState.state };
    },
}));

vi.mock('@/sync/store/hooks', () => ({
    useProfile: () => ({ id: 'account-1' }),
    useLocalSetting: () => undefined,
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machineContributionRegistryProjectionDescribe: (...args: any[]) => machineContributionRegistryProjectionDescribeMock(...args),
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
    machinePluginSecretStatus: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretSet: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
    machinePluginSecretDelete: vi.fn(async () => ({ supported: false, reason: 'not-supported' })),
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
        externalSessionBrowseSupportState.supportedByProviderId = {};
        featureDecisionState.state = 'enabled';
        featureDecisionSpy.mockReset();
        browseScreenPropsRef.current = null;
        routerMock.push.mockClear();
        routerMock.back.mockClear();
        routerMock.replace.mockClear();
        routerMock.setParams.mockClear();
        navigationMock.dispatch.mockClear();
        navigationMock.goBack.mockClear();
        navigationMock.setParams.mockClear();
        machineContributionRegistryProjectionDescribeMock.mockReset();
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({ supported: false, reason: 'not-supported' });
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

    it.each([
        ['disabled', 'disabled', 'external-sessions-browse-route-gate-unavailable'],
        ['unknown', 'unknown', 'external-sessions-browse-route-gate-unknown'],
        ['missing', null, 'external-sessions-browse-route-gate-checking'],
    ] as const)('fails closed for a %s sessions.direct decision before resolving daemon projection or mounting Browse', async (_label, state, expectedGateTestId) => {
        featureDecisionState.state = state;
        const ResumeBrowsePickerScreen = (await import('@/app/(app)/new/pick/resume-browse')).default;

        const screen = await renderScreen(React.createElement(ResumeBrowsePickerScreen));

        // Failing closed is not the same as a blank screen: the gate owns one accessible
        // state with a working exit for every non-available arm.
        expect(screen.findByTestId(expectedGateTestId)).not.toBeNull();
        expect(featureDecisionSpy).toHaveBeenCalledWith('sessions.direct', {
            scopeKind: 'spawn',
            serverId: 'server-2',
        });
        expect(machineContributionRegistryProjectionDescribeMock).not.toHaveBeenCalled();
        expect(browseScreenPropsRef.current).toBeNull();
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
                backendTarget: JSON.stringify({ kind: 'backend', backendId: 'claude' }),
                backendTargetKey: 'backend:claude',
                dataId: 'draft-1',
                machineId: 'machine-2',
                spawnServerId: 'server-2',
                resumeSessionId: 'session-picked',
            },
        });
        expect(routerMock.setParams).not.toHaveBeenCalled();
        expect(routerMock.back).not.toHaveBeenCalled();
    });

    it('closes the browse picker instead of reviving a customAcp compat carrier when a configured backend has no runtime browse carrier', async () => {
        routeParamsState.value = {
            backendTarget: JSON.stringify({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' }),
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
        await Promise.resolve();

        expect(browseScreenPropsRef.current).toBeNull();
        expect(routerMock.replace).toHaveBeenCalledWith('/new');
    });

    it('does not treat the last built-in selection as an external-session carrier for an unprojected configured backend', async () => {
        routeParamsState.value = {
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'server-2',
        };
        settingsState.value = {
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
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
        expect(browseScreenPropsRef.current).toBeNull();
        expect(routerMock.replace).toHaveBeenCalledWith('/new');
    });

    it('uses the projected runtime carrier when browsing direct sessions for a plugin backend', async () => {
        routeParamsState.value = {
            backendTargetKey: 'backend:plugin-review-bot',
            dataId: 'draft-1',
            machineId: 'machine-plugin-2',
            spawnServerId: 'server-2',
        };
        settingsState.value = {
            backendEnabledByTargetKey: {
                'backend:plugin-review-bot': true,
            },
        };
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 1,
                agentsById: {
                    'plugin:review-bot': {
                        id: 'plugin:review-bot',
                        title: 'Review Bot Plugin',
                        subtitle: 'plugin agent',
                        channel: 'plugin',
                        isBuiltIn: false,
                        catalogAgentId: 'claude',
                        iconAgentId: 'claude',
                    },
                },
                backendsById: {
                    'plugin-review-bot': {
                        id: 'plugin-review-bot',
                        agentId: 'plugin:review-bot',
                        title: 'Review Bot (plugin)',
                        subtitle: 'plugin backend',
                        catalogAgentId: 'claude',
                        iconAgentId: 'claude',
                    },
                },
            },
        });

        const ResumeBrowsePickerScreen = (await import('@/app/(app)/new/pick/resume-browse')).default;
        await renderScreen(React.createElement(ResumeBrowsePickerScreen));

        expect(browseScreenPropsRef.current?.lockScope?.providerId).toBe('plugin:review-bot');
    });

    it('waits for plugin carrier projection on cold load instead of navigating away through the customAcp fallback', async () => {
        routeParamsState.value = {
            backendTargetKey: 'backend:plugin-review-bot',
            dataId: 'draft-1',
            machineId: 'machine-plugin-2',
            spawnServerId: 'server-2',
        };
        settingsState.value = {
            backendEnabledByTargetKey: {
                'backend:plugin-review-bot': true,
            },
        };
        externalSessionBrowseSupportState.supportedByProviderId = {
            customAcp: false,
            claude: true,
        };

        let resolveProjection: ((value: unknown) => void) | undefined;
        machineContributionRegistryProjectionDescribeMock.mockImplementationOnce(() => new Promise((resolve) => {
            resolveProjection = resolve;
        }));

        const ResumeBrowsePickerScreen = (await import('@/app/(app)/new/pick/resume-browse')).default;
        await renderScreen(React.createElement(ResumeBrowsePickerScreen));
        await Promise.resolve();

        expect(routerMock.back).not.toHaveBeenCalled();
        expect(routerMock.replace).not.toHaveBeenCalled();

        const projectionResolver = resolveProjection;
        if (typeof projectionResolver === 'function') {
            await act(async () => {
                projectionResolver({
                    supported: true,
                    projection: {
                        v: 1,
                        agentsById: {
                            'plugin:review-bot': {
                                id: 'plugin:review-bot',
                                title: 'Review Bot Plugin',
                                subtitle: 'plugin agent',
                                channel: 'plugin',
                                isBuiltIn: false,
                                catalogAgentId: 'claude',
                                iconAgentId: 'claude',
                            },
                        },
                        backendsById: {
                            'plugin-review-bot': {
                                id: 'plugin-review-bot',
                                agentId: 'plugin:review-bot',
                                title: 'Review Bot (plugin)',
                                subtitle: 'plugin backend',
                                catalogAgentId: 'claude',
                                iconAgentId: 'claude',
                            },
                        },
                    },
                });
            });
        }
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(routerMock.back).not.toHaveBeenCalled();
        expect(routerMock.replace).not.toHaveBeenCalled();
        expect(browseScreenPropsRef.current?.lockScope?.providerId).toBe('plugin:review-bot');
    });
});
