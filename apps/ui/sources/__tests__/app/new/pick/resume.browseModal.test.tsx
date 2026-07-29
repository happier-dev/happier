import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';
import { DEFAULT_AGENT_ID } from '@/agents/catalog/catalog';

import {
    renderScreen,
    standardCleanup,
    flushHookEffects,
} from '@/dev/testkit';
import type { NewSessionResumeSelectionContentProps } from '@/components/sessions/new/components/NewSessionResumeSelectionContent';
import {
    createNavigationMock,
    createRouterMock,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
} from './testHarness';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const openExternalSessionsResumeIdPickerModalMock = vi.hoisted(() => vi.fn<(args: unknown) => Promise<string | null>>(async () => 'session-picked'));
const machineContributionRegistryProjectionDescribeMock = vi.hoisted(() =>
    vi.fn<(...args: unknown[]) => Promise<any>>(async () => ({ supported: false, reason: 'not-supported' })),
);
const routeParamsState = vi.hoisted(() => ({
    value: {
        agentType: 'claude',
        dataId: 'draft-1',
        currentResumeId: '',
        machineId: 'machine-2',
        spawnServerId: 'server-2',
    } as Record<string, string>,
}));
const settingsState = vi.hoisted(() => ({
    value: {} as Record<string, unknown>,
}));
const featureState = vi.hoisted(() => ({
    externalSessionsEnabled: false,
}));

const resumeSelectionContentPropsRef = { current: null as NewSessionResumeSelectionContentProps | null };

function createSupportedClaudeProjection(params: Readonly<{
    additionalAgentsById?: Readonly<Record<string, unknown>>;
    backendsById?: Readonly<Record<string, unknown>>;
}> = {}) {
    return PluginProjectionV2Schema.parse({
        v: 2,
        generation: 1,
        installedPackagesById: {
            'happier.agent.claude': {
                id: 'happier.agent.claude',
                displayName: 'Claude',
                enabled: true,
                source: { kind: 'bundled', locator: 'happier.agent.claude' },
            },
        },
        agentsById: {
            ...params.additionalAgentsById,
            claude: {
                id: 'claude',
                title: 'Claude',
                catalogAgentId: 'claude',
                iconAgentId: 'claude',
                identity: {
                    pluginId: 'happier.agent.claude',
                    localId: 'claude',
                },
                externalSessions: {
                    agent: {
                        pluginId: 'happier.agent.claude',
                        localId: 'claude',
                    },
                    generation: 1,
                    operations: {
                        listCandidates: true,
                        resolveLinkIdentity: true,
                        pageTranscript: true,
                        readAfterTranscript: true,
                    },
                    sources: [{
                        sourceKind: 'claudeConfig',
                        schema: {
                            passthrough: true,
                            fields: [
                                { name: 'kind', kind: 'literal', value: 'claudeConfig' },
                                { name: 'configDir', kind: 'string', min: 1, max: 10_000, nullish: true },
                                { name: 'projectId', kind: 'string', min: 1, max: 2_000, nullish: true },
                            ],
                        },
                        key: {
                            segments: [
                                { kind: 'literal', value: 'claudeConfig' },
                                { kind: 'field', field: 'configDir' },
                                { kind: 'field', field: 'projectId' },
                            ],
                        },
                        instances: [{ kind: 'default', constants: {} }],
                    }],
                },
            },
        },
        backendsById: params.backendsById ?? {},
    });
}

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
                useSettings: () => settingsState.value as any,
            },
        }),
});

vi.mock('@/components/sessions/new/components/NewSessionResumeSelectionContent', () => ({
    NewSessionResumeSelectionContent: (props: NewSessionResumeSelectionContentProps) => {
        resumeSelectionContentPropsRef.current = props;
        return null;
    },
}));

vi.mock('@/components/sessions/external/browse/openExternalSessionsResumeIdPickerModal', () => ({
    openExternalSessionsResumeIdPickerModal: (args: unknown) => openExternalSessionsResumeIdPickerModalMock(args),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: (featureId: string) => featureId === 'sessions.direct' ? featureState.externalSessionsEnabled : false,
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    machineContributionRegistryProjectionDescribe: (...args: any[]) => machineContributionRegistryProjectionDescribeMock(...args),
    getMachineContributionRegistryProjectionRevision: () => 0,
    subscribeMachineContributionRegistryProjectionInvalidation: () => () => {},
}));

vi.mock('@/utils/sessions/tempDataStore', () => ({
    peekTempData: () => null,
}));

describe('ResumePickerScreen browse modal', () => {
    beforeEach(() => {
        routeParamsState.value = {
            agentType: 'claude',
            dataId: 'draft-1',
            currentResumeId: '',
            machineId: 'machine-2',
            spawnServerId: 'server-2',
        };
        settingsState.value = {};
        resumeSelectionContentPropsRef.current = null;
        routerMock.push.mockClear();
        routerMock.back.mockClear();
        routerMock.replace.mockClear();
        routerMock.setParams.mockClear();
        navigationMock.dispatch.mockClear();
        navigationMock.goBack.mockClear();
        navigationMock.setParams.mockClear();
        openExternalSessionsResumeIdPickerModalMock.mockReset();
        openExternalSessionsResumeIdPickerModalMock.mockResolvedValue('session-picked');
        machineContributionRegistryProjectionDescribeMock.mockReset();
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({ supported: false, reason: 'not-supported' });
        featureState.externalSessionsEnabled = false;
    });

    afterEach(() => {
        standardCleanup();
    });

    it('uses the shared resume browser modal instead of navigating to the resume browse route', async () => {
        featureState.externalSessionsEnabled = true;
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: createSupportedClaudeProjection(),
        });
        const ResumePickerScreen = (await import('@/app/(app)/new/pick/resume')).default;

        await renderScreen(React.createElement(ResumePickerScreen));

        const props = resumeSelectionContentPropsRef.current;
        expect(props?.resumeBrowse).toBeTruthy();
        const onBrowse = props?.resumeBrowse?.onBrowse ?? null;
        expect(typeof onBrowse).toBe('function');
        const result = await onBrowse?.();

        expect(openExternalSessionsResumeIdPickerModalMock).toHaveBeenCalledWith(expect.objectContaining({
            title: 'externalSessions.browseTitle',
            lockScope: expect.objectContaining({
                machineId: 'machine-2',
                serverId: 'server-2',
                providerId: 'claude',
                source: expect.anything(),
            }),
        }));
        expect(result).toBe('session-picked');
        expect(routerMock.replace).not.toHaveBeenCalledWith(expect.objectContaining({
            pathname: '/new/pick/resume-browse',
        }));
    });

    it('does not expose resume browse when sessions.direct is disabled', async () => {
        const ResumePickerScreen = (await import('@/app/(app)/new/pick/resume')).default;

        await renderScreen(React.createElement(ResumePickerScreen));

        const props = resumeSelectionContentPropsRef.current;
        expect(props?.resumeBrowse).toBeNull();
        expect(openExternalSessionsResumeIdPickerModalMock).not.toHaveBeenCalled();
    });

    it('resolves configured ACP backend labels without reviving customAcp in the canonical agentType state', async () => {
        routeParamsState.value = {
            backendTargetKey: 'acpBackend:review-bot',
            currentResumeId: '',
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
                backendEnabledByTargetKey: {},
            },
        };

        const ResumePickerScreen = (await import('@/app/(app)/new/pick/resume')).default;

        await renderScreen(React.createElement(ResumePickerScreen));

        const props = resumeSelectionContentPropsRef.current;
        expect(props?.agentType).toBe(DEFAULT_AGENT_ID);
        expect(props?.agentLabel).toBe('Review Bot');
    });

    it('resolves plugin backend labels from daemon merged projection inputs', async () => {
        routeParamsState.value = {
            backendTargetKey: 'backend:plugin-review-bot',
            currentResumeId: '',
            machineId: 'machine-plugin-2',
            spawnServerId: 'server-2',
        };

        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: {
                v: 1,
                providersById: {
                    'plugin:review-bot': {
                        providerId: 'plugin:review-bot',
                        title: 'Review Bot Plugin',
                        subtitle: 'plugin provider',
                        channel: 'plugin',
                        isBuiltIn: false,
                    },
                },
                backendsById: {
                    'plugin-review-bot': {
                        backendId: 'plugin-review-bot',
                        providerId: 'plugin:review-bot',
                        title: 'Review Bot (plugin)',
                        subtitle: 'plugin backend',
                        catalogAgentId: null,
                        iconAgentId: null,
                    },
                },
            },
        });

        const ResumePickerScreen = (await import('@/app/(app)/new/pick/resume')).default;
        await renderScreen(React.createElement(ResumePickerScreen));
        await flushHookEffects({ cycles: 10 });

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith(
            'machine-plugin-2',
            expect.objectContaining({ serverId: 'server-2' }),
        );

        const props = resumeSelectionContentPropsRef.current;
        expect(props?.agentLabel).toBe('Review Bot (plugin)');
    });

    it('uses the projected runtime carrier when browsing direct sessions for a plugin backend', async () => {
        featureState.externalSessionsEnabled = true;
        routeParamsState.value = {
            backendTargetKey: 'backend:plugin-review-bot',
            currentResumeId: '',
            machineId: 'machine-plugin-3',
            spawnServerId: 'server-2',
        };

        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: createSupportedClaudeProjection({
                additionalAgentsById: {
                    'plugin:review-bot': {
                        id: 'plugin:review-bot',
                        title: 'Review Bot Plugin',
                        subtitle: 'plugin provider',
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
            }),
        });

        const ResumePickerScreen = (await import('@/app/(app)/new/pick/resume')).default;
        await renderScreen(React.createElement(ResumePickerScreen));
        await flushHookEffects({ cycles: 10 });

        const props = resumeSelectionContentPropsRef.current;
        expect(props?.resumeBrowse).toBeTruthy();

        const result = await props?.resumeBrowse?.onBrowse?.();

        expect(openExternalSessionsResumeIdPickerModalMock).toHaveBeenCalledWith(expect.objectContaining({
            lockScope: expect.objectContaining({
                machineId: 'machine-plugin-3',
                serverId: 'server-2',
                providerId: 'claude',
            }),
        }));
        expect(result).toBe('session-picked');
    });

    it('preserves the new-session context when it has to replace back to /new', async () => {
        navigationMock.getState = () => ({
            index: 0,
            routes: [
                {
                    key: 'resume-picker-route',
                    name: '(app)/new/pick/resume',
                    path: '/new/pick/resume',
                },
            ],
        });

        const ResumePickerScreen = (await import('@/app/(app)/new/pick/resume')).default;

        await renderScreen(React.createElement(ResumePickerScreen));

        const props = resumeSelectionContentPropsRef.current;
        expect(typeof props?.onSave).toBe('function');

        await props?.onSave?.('session-picked');

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

    it('uses the last explicit built-in agent placeholder while keeping the configured backend label when route context is missing', async () => {
        navigationMock.getState = () => ({
            index: 0,
            routes: [
                {
                    key: 'resume-picker-route',
                    name: '(app)/new/pick/resume',
                    path: '/new/pick/resume',
                },
            ],
        });
        routeParamsState.value = {
            currentResumeId: '',
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
                backendEnabledByTargetKey: {},
            },
        };

        const ResumePickerScreen = (await import('@/app/(app)/new/pick/resume')).default;

        await renderScreen(React.createElement(ResumePickerScreen));

        const props = resumeSelectionContentPropsRef.current;
        expect(props?.agentType).toBe('codex');
        expect(props?.agentLabel).toBe('Review Bot');

        await props?.onSave?.('session-picked');

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
                spawnServerId: 'server-2',
                resumeSessionId: 'session-picked',
            },
        });
    });
});
