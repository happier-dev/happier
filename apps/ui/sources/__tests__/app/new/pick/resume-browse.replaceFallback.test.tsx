import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import type {
    ExternalSessionsBrowseInteraction,
    ExternalSessionsBrowseScopeLock,
} from '@/components/sessions/external/browse/ExternalSessionsBrowseScreen';
import {
    createNavigationMock,
    createProjectionDescribeMock,
    createReviewBotPluginProjectionContributions,
    createRouterMock,
    createSupportedClaudeProjection,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
    type MachineContributionRegistryProjectionDescribeResult,
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
const featureDecisionState = vi.hoisted(() => ({
    state: 'enabled' as 'enabled' | 'disabled' | 'unknown' | null,
}));
const featureDecisionSpy = vi.hoisted(() => vi.fn());
const machineContributionRegistryProjectionDescribeMock = createProjectionDescribeMock();
type ExternalSessionsBrowseScreenProps = Readonly<{
    interaction?: ExternalSessionsBrowseInteraction;
    lockScope?: ExternalSessionsBrowseScopeLock | null;
    onPickRemoteSessionId?: (remoteSessionId: string) => void;
}>;

const browseScreenPropsRef = { current: null as ExternalSessionsBrowseScreenProps | null };

function createReviewBotProjection() {
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
            'acme.review-bot': {
                id: 'acme.review-bot',
                displayName: 'Review Bot',
                enabled: true,
                source: { kind: 'local', locator: 'acme.review-bot' },
            },
        },
        agentsById: {
            claude: {
                id: 'claude',
                title: 'Claude',
                catalogAgentId: 'claude',
                iconAgentId: 'claude',
                identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
            },
            'plugin:review-bot': {
                id: 'plugin:review-bot',
                title: 'Review Bot Plugin',
                subtitle: 'plugin agent',
                channel: 'plugin',
                isBuiltIn: false,
                catalogAgentId: 'claude',
                iconAgentId: 'claude',
                identity: { pluginId: 'acme.review-bot', localId: 'review-bot' },
                externalSessions: {
                    agent: { pluginId: 'acme.review-bot', localId: 'review-bot' },
                    generation: 1,
                    operations: {
                        listCandidates: true,
                        resolveLinkIdentity: true,
                        pageTranscript: true,
                        readAfterTranscript: true,
                    },
                    sources: [{
                        sourceKind: 'reviewBotConfig',
                        schema: {
                            fields: [
                                { name: 'kind', kind: 'literal', value: 'reviewBotConfig' },
                                { name: 'configDir', kind: 'string', min: 1, max: 10_000, nullish: true },
                            ],
                        },
                        key: {
                            segments: [
                                { kind: 'literal', value: 'reviewBotConfig' },
                                { kind: 'field', field: 'configDir' },
                            ],
                        },
                        instances: [{ kind: 'default', constants: {} }],
                    }],
                },
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
    storage: async () =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleStub({
            useSettings: () => settingsState.value as any,
        }),
    projectionSeam: { describe: machineContributionRegistryProjectionDescribeMock },
});

vi.mock('@/components/sessions/external/browse/ExternalSessionsBrowseScreen', () => ({
    ExternalSessionsBrowseScreen: (props: Record<string, unknown>) => {
        browseScreenPropsRef.current = props;
        return null;
    },
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


describe('ResumeBrowsePickerScreen replace fallback', () => {
    beforeEach(async () => {
        const { clearTempData, storeTempData } = await import('@/utils/sessions/tempDataStore');
        clearTempData();
        const dataId = storeTempData({
            machineId: 'machine-2',
            backendTarget: null,
            backendNewSessionOptionStateByTargetKey: {},
        });
        routeParamsState.value = {
            agentType: 'claude',
            dataId,
            machineId: 'machine-2',
            spawnServerId: 'server-2',
        };
        settingsState.value = {};
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
        // The bundled claude carrier only browses once the daemon projection
        // declares its External Sessions source; without it there is no lock
        // scope and the route closes instead of mounting Browse.
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: createSupportedClaudeProjection(),
        });
        const ResumeBrowsePickerScreen = (await import('@/app/(app)/new/pick/resume-browse')).default;

        await renderScreen(React.createElement(ResumeBrowsePickerScreen));
        await flushHookEffects({ cycles: 40 });

        const props = browseScreenPropsRef.current;
        expect(props?.lockScope).toEqual(expect.objectContaining({
            machineId: 'machine-2',
            serverId: 'server-2',
            providerId: 'claude',
            source: expect.objectContaining({ kind: 'claudeConfig' }),
        }));
        expect(typeof props?.onPickRemoteSessionId).toBe('function');

        await props?.onPickRemoteSessionId?.('session-picked');

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
        // Closing the picker keeps the new-session context it was opened with
        // (`buildNewSessionPickerFallbackHref`), including the configured target.
        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                backendTarget: JSON.stringify({ kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot' }),
                backendTargetKey: 'backend:review-bot:configured:review-bot',
                dataId: 'draft-1',
                machineId: 'machine-2',
                spawnServerId: 'server-2',
            },
        });
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
        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                dataId: 'draft-1',
                machineId: 'machine-2',
                spawnServerId: 'server-2',
            },
        });
    });

    it('uses the projected runtime carrier when browsing direct sessions for a plugin backend', async () => {
        routeParamsState.value = {
            backendTargetKey: 'agent:acme.review-bot/review-bot',
            dataId: 'draft-1',
            machineId: 'machine-plugin-2',
            spawnServerId: 'server-2',
        };
        // The daemon projection is the only authority that can prove which
        // qualified Agent contribution owns the settings-backed plugin backend:
        // the V2 projection carries the contribution identity, so the real
        // carrier resolution maps the backend onto `plugin:review-bot` instead
        // of falling back to the bundled claude carrier.
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: createSupportedClaudeProjection(createReviewBotPluginProjectionContributions()),
        });

        const ResumeBrowsePickerScreen = (await import('@/app/(app)/new/pick/resume-browse')).default;
        await renderScreen(React.createElement(ResumeBrowsePickerScreen));
        // The route candidate only becomes available once the merged projection
        // is ready (account-scope binding → describe → catalog adaptation), so
        // wait for the full async chain to settle before capturing props.
        await flushHookEffects({ cycles: 40 });

        expect(browseScreenPropsRef.current?.lockScope).toEqual(expect.objectContaining({
            machineId: 'machine-plugin-2',
            serverId: 'server-2',
            providerId: 'plugin:review-bot',
            source: expect.objectContaining({ kind: 'reviewBotConfig' }),
        }));
    });

    it('waits for plugin carrier projection on cold load instead of navigating away through the customAcp fallback', async () => {
        routeParamsState.value = {
            backendTargetKey: 'agent:acme.review-bot/review-bot',
            dataId: 'draft-1',
            machineId: 'machine-plugin-2',
            spawnServerId: 'server-2',
        };
        let resolveProjection: ((value: MachineContributionRegistryProjectionDescribeResult) => void) | undefined;
        machineContributionRegistryProjectionDescribeMock.mockImplementationOnce(() => new Promise((resolve) => {
            resolveProjection = resolve;
        }));

        const ResumeBrowsePickerScreen = (await import('@/app/(app)/new/pick/resume-browse')).default;
        await renderScreen(React.createElement(ResumeBrowsePickerScreen));
        // Settle the account-scope binding that precedes the describe call so
        // the pending projection is the only thing the route is waiting on.
        await flushHookEffects({ cycles: 10 });

        expect(routerMock.back).not.toHaveBeenCalled();
        expect(routerMock.replace).not.toHaveBeenCalled();
        expect(browseScreenPropsRef.current).toBeNull();

        const projectionResolver = resolveProjection;
        expect(typeof projectionResolver).toBe('function');
        await act(async () => {
            projectionResolver?.({
                supported: true,
                projection: createSupportedClaudeProjection(createReviewBotPluginProjectionContributions()),
            });
        });
        await flushHookEffects({ cycles: 40 });

        expect(routerMock.back).not.toHaveBeenCalled();
        expect(routerMock.replace).not.toHaveBeenCalled();
        expect(browseScreenPropsRef.current?.lockScope?.providerId).toBe('plugin:review-bot');
    });
});
