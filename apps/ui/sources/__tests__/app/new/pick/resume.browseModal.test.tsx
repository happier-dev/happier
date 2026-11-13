import { applyPickerFixtureSettings } from './testHarness';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import type { AcpBackendDefinitionV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';

import {
    renderScreen,
    standardCleanup,
    flushHookEffects,
} from '@/dev/testkit';
import type { NewSessionResumeSelectionContentProps } from '@/components/sessions/new/components/NewSessionResumeSelectionContent';
import {
    createNavigationMock,
    createConfiguredAcpBackendCatalogSettings,
    createConfiguredAgentRouteParams,
    createProjectionDescribeMock,
    createReviewBotPluginProjectionContributions,
    createRouterMock,
    createSupportedClaudeProjection,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
} from './testHarness';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const openExternalSessionsResumeIdPickerModalMock = vi.hoisted(() => vi.fn<(args: unknown) => Promise<string | null>>(async () => 'session-picked'));
const machineContributionRegistryProjectionDescribeMock = createProjectionDescribeMock();
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
let acpDefinitions: AcpBackendDefinitionV1[] = [];

const picker = await installPickerCommonModuleMocks({
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
    projectionSeam: {
        describe: machineContributionRegistryProjectionDescribeMock,
        serverProfiles: [{ id: 'server-2', serverUrl: 'https://server-2.example.test' }],
    },
    tempDataStore: {
        peekTempData: () => null,
    },
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

async function renderResumePicker() {
    const scope = picker.accountScope;
    picker.homeBoundary.answer(scope.serverId, ACP_CATALOG_ROWS_ROUTE_V1, {
        body: AcpCatalogRowReadResponseV1Schema.parse({
            status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, definitions: acpDefinitions } },
        }),
    });
    const { storage } = await import('@/sync/domains/state/storageStore');
    const { settingsParse } = await import('@/sync/domains/settings/settings');
    await applyPickerFixtureSettings(settingsParse(settingsState.value));
    const { refreshAcpCatalog } = await import('@/sync/engine/settings/acpCatalogEngine');
    await refreshAcpCatalog(scope);
    const ResumePickerScreen = (await import('@/app/(app)/new/pick/resume')).default;
    return renderScreen(React.createElement(ResumePickerScreen));
}

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
        acpDefinitions = [];
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
        await renderResumePicker();
        await vi.waitFor(() => expect(resumeSelectionContentPropsRef.current?.resumeBrowse).toBeTruthy());

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

    it('offers a resume-only listing source because the resume picker is the remote-session-id interaction', async () => {
        featureState.externalSessionsEnabled = true;
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: createSupportedClaudeProjection({ resumeOnlySource: true }),
        });
        await renderResumePicker();
        await vi.waitFor(() => expect(resumeSelectionContentPropsRef.current?.resumeBrowse).toBeTruthy());

        const props = resumeSelectionContentPropsRef.current;
        expect(props?.resumeBrowse).toBeTruthy();

        await props?.resumeBrowse?.onBrowse?.();

        expect(openExternalSessionsResumeIdPickerModalMock).toHaveBeenCalledWith(expect.objectContaining({
            lockScope: expect.objectContaining({
                providerId: 'claude',
                source: expect.objectContaining({ kind: 'claudeConfig' }),
            }),
        }));
    });

    it('materializes the declared source from the current Agent setting before opening its resume browser', async () => {
        featureState.externalSessionsEnabled = true;
        settingsState.value = { customConfigDir: '/configured/claude' };
        const projection = createSupportedClaudeProjection();
        const source = projection.agentsById.claude?.externalSessions?.sources[0];
        if (!source) throw new Error('Claude browse source fixture unavailable');
        source.instances = [{ kind: 'default', constants: {} }, {
            kind: 'agentSettingOverride', settingId: 'customConfigDir', field: 'configDir',
            normalization: 'configuredPath', constants: {},
        }];
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({ supported: true, projection });
        await renderResumePicker();
        await vi.waitFor(() => expect(resumeSelectionContentPropsRef.current?.resumeBrowse).toBeTruthy());
        const browse = resumeSelectionContentPropsRef.current?.resumeBrowse;
        await browse?.onBrowse();

        expect(openExternalSessionsResumeIdPickerModalMock).toHaveBeenCalledWith(expect.objectContaining({
            lockScope: expect.objectContaining({
                providerId: 'claude',
                source: { kind: 'claudeConfig', configDir: '/configured/claude' },
            }),
        }));
    });

    it('does not expose resume browse when sessions.direct is disabled', async () => {
        await renderResumePicker();

        const props = resumeSelectionContentPropsRef.current;
        expect(props?.resumeBrowse).toBeNull();
        expect(openExternalSessionsResumeIdPickerModalMock).not.toHaveBeenCalled();
    });

    it('resolves configured ACP backend labels onto the concrete configured carrier instead of the retired customAcp sentinel', async () => {
        routeParamsState.value = {
            backendTargetKey: 'backend:review-bot:configured:review-bot',
            currentResumeId: '',
            machineId: 'machine-2',
            spawnServerId: 'server-2',
        };
        acpDefinitions = createConfiguredAcpBackendCatalogSettings('review-bot').backends;

        await renderResumePicker();

        const props = resumeSelectionContentPropsRef.current;
        // The canonical agentType state carries the concrete configured carrier
        // id (`getResolvedBackendCatalogEntries` pins `agentId: backend.id` for
        // configured rows); only the retired `customAcp` sentinel must never
        // reappear here.
        expect(props?.agentType).toBe('custom-acp');
        expect(props?.agentLabel).toBe('Review Bot');
    });

    it('resolves plugin backend labels from daemon merged projection inputs', async () => {
        routeParamsState.value = {
            backendTargetKey: 'agent:acme.review-bot/review-bot',
            currentResumeId: '',
            machineId: 'machine-plugin-2',
            spawnServerId: 'server-2',
        };
        settingsState.value = {
            backendEnabledByTargetKey: {
                'agent:acme.review-bot/review-bot': true,
            },
        };

        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: createSupportedClaudeProjection({
                additionalAgentsById: {
                    'acme.review-bot/review-bot': {
                        id: 'acme.review-bot/review-bot',
                        title: 'Review Bot Plugin',
                        subtitle: 'plugin agent',
                        channel: 'plugin',
                        isBuiltIn: false,
                        identity: {
                            pluginId: 'acme.review-bot',
                            localId: 'review-bot',
                        },
                    },
                },
                additionalInstalledPackagesById: {
                    'acme.review-bot': {
                        id: 'acme.review-bot',
                        displayName: 'Review Bot',
                        enabled: true,
                        source: { kind: 'local', locator: 'acme.review-bot' },
                    },
                },
            }),
        });

        await renderResumePicker();
        await flushHookEffects({ cycles: 10 });

        expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalledWith(
            'machine-plugin-2',
            expect.objectContaining({ serverId: 'server-2' }),
        );

        // A settings-backed plugin row is titled by its Agent projection
        // (`createBuiltInTargetEntry`: settings-backed rows use the provider
        // projection title), which here can only come from the daemon inputs.
        await vi.waitFor(() => expect(resumeSelectionContentPropsRef.current?.agentLabel).toBe('Review Bot Plugin'));
    });

    it('uses the projected runtime carrier when browsing direct sessions for a plugin backend', async () => {
        featureState.externalSessionsEnabled = true;
        routeParamsState.value = {
            backendTargetKey: 'agent:acme.review-bot/review-bot',
            currentResumeId: '',
            machineId: 'machine-plugin-3',
            spawnServerId: 'server-2',
        };
        settingsState.value = {
            backendEnabledByTargetKey: {
                'agent:acme.review-bot/review-bot': true,
            },
        };

        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: createSupportedClaudeProjection(createReviewBotPluginProjectionContributions()),
        });

        await renderResumePicker();
        // The route candidate only becomes available once the merged projection
        // is ready (account-scope binding → describe → catalog adaptation), so
        // wait for the full async chain to settle before capturing props.
        await vi.waitFor(() => expect(resumeSelectionContentPropsRef.current?.agentType).toBe('acme.review-bot/review-bot'));

        const props = resumeSelectionContentPropsRef.current;
        expect(props?.resumeBrowse).toBeTruthy();

        const result = await props?.resumeBrowse?.onBrowse?.();

        expect(openExternalSessionsResumeIdPickerModalMock).toHaveBeenCalledWith(expect.objectContaining({
            lockScope: expect.objectContaining({
                machineId: 'machine-plugin-3',
                serverId: 'server-2',
                providerId: 'acme.review-bot/review-bot',
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

        await renderResumePicker();

        const props = resumeSelectionContentPropsRef.current;
        expect(typeof props?.onSave).toBe('function');

        await props?.onSave?.('session-picked');

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                agentType: 'claude',
                // The bundled Agent serializes under its canonical qualified
                // contribution identity (`formatBackendTargetKeyV2` rekeys the
                // retired `backend:<bundledId>` spelling onto it).
                backendTarget: JSON.stringify({
                    kind: 'agent',
                    identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
                }),
                backendTargetKey: 'agent:happier.agent.claude/claude',
                dataId: 'draft-1',
                machineId: 'machine-2',
                spawnServerId: 'server-2',
                resumeSessionId: 'session-picked',
            },
        });
        expect(routerMock.setParams).not.toHaveBeenCalled();
        expect(routerMock.back).not.toHaveBeenCalled();
    });

    it('keeps the configured backend target and label when route context is missing', async () => {
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
        };
        acpDefinitions = createConfiguredAcpBackendCatalogSettings('review-bot').backends;

        await renderResumePicker();

        const props = resumeSelectionContentPropsRef.current;
        // The stored configured backend target wins over the built-in agent
        // placeholder under the V2 carrier vocabulary (`resolvePreferredBackendTarget`
        // prefers the parseable stored target); the configured label still comes
        // from the resolved backend row.
        expect(props?.agentType).toBe('custom-acp');
        expect(props?.agentLabel).toBe('Review Bot');

        await props?.onSave?.('session-picked');

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                ...createConfiguredAgentRouteParams('review-bot'),
                dataId: 'draft-1',
                machineId: 'machine-2',
                spawnServerId: 'server-2',
                resumeSessionId: 'session-picked',
            },
        });
    });
});
