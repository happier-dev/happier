import { applyPickerFixtureSettings } from './testHarness';
import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

import { createDeferred, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import {
    createNavigationMock,
    createProjectionDescribeMock,
    createRouterMock,
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
        machineId: 'machine-cold',
        spawnServerId: 'server-cold',
    } as Record<string, string>,
}));
const machineContributionRegistryProjectionDescribeMock = createProjectionDescribeMock();
const browseScreenPropsRef = { current: null as Record<string, unknown> | null };

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
    projectionSeam: {
        describe: machineContributionRegistryProjectionDescribeMock,
        serverProfiles: [{ id: 'server-cold', serverUrl: 'https://server-cold.example.test' }],
    },
});

vi.mock('@/components/sessions/external/browse/ExternalSessionsBrowseScreen', () => ({
    ExternalSessionsBrowseScreen: (props: Record<string, unknown>) => {
        browseScreenPropsRef.current = props;
        return null;
    },
}));

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'enabled' }),
}));

/**
 * These run against the REAL `canBrowseExternalSessions`, which answers from the daemon
 * projection: no projection means no browse capability, for a BUNDLED Agent exactly as
 * for a plugin carrier. That is what makes a cold load of this picker a wait rather than
 * a dismissal, and it is invisible to a suite that stubs the capability resolver.
 */
describe('ResumeBrowsePickerScreen cold projection', () => {

    beforeEach(async () => {
        const { clearTempData, storeTempData } = await import('@/utils/sessions/tempDataStore');
        clearTempData();
        const dataId = storeTempData({
            machineId: 'machine-cold',
            backendTarget: null,
            backendNewSessionOptionStateByTargetKey: {},
        });
        routeParamsState.value = {
            agentType: 'claude',
            dataId,
            machineId: 'machine-cold',
            spawnServerId: 'server-cold',
        };
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        await applyPickerFixtureSettings(settingsParse({}));
        browseScreenPropsRef.current = null;
        routerMock.push.mockClear();
        routerMock.back.mockClear();
        routerMock.replace.mockClear();
        routerMock.setParams.mockClear();
        navigationMock.dispatch.mockClear();
        navigationMock.goBack.mockClear();
        machineContributionRegistryProjectionDescribeMock.mockReset();
        navigationMock.getState = () => ({
            index: 0,
            routes: [{
                key: 'resume-browse-route',
                name: '(app)/new/pick/resume-browse',
                path: '/new/pick/resume-browse',
            }],
        });
    });

    afterEach(() => {
        standardCleanup();
    });

    it('retains the picker while the bundled-Agent projection is still loading', async () => {
        const projection = createDeferred<MachineContributionRegistryProjectionDescribeResult>();
        machineContributionRegistryProjectionDescribeMock.mockImplementation(() => projection.promise);

        const ResumeBrowsePickerScreen = (await import('@/app/(app)/new/pick/resume-browse')).default;
        const screen = await renderScreen(React.createElement(ResumeBrowsePickerScreen));
        await vi.waitFor(() => expect(machineContributionRegistryProjectionDescribeMock).toHaveBeenCalled());

        expect(routerMock.back).not.toHaveBeenCalled();
        expect(routerMock.replace).not.toHaveBeenCalled();
        expect(navigationMock.goBack).not.toHaveBeenCalled();
        expect(browseScreenPropsRef.current).toBeNull();
        expect(screen.findByTestId('external-sessions-browse-route-loading')).not.toBeNull();
        await screen.unmount();
        await act(async () => { projection.resolve({ supported: false, reason: 'not-supported' }); });
    });

    it('dismisses once the projection authoritatively answers that browse is unavailable', async () => {
        let resolveProjection: ((value: MachineContributionRegistryProjectionDescribeResult) => void) | undefined;
        machineContributionRegistryProjectionDescribeMock.mockImplementation(() => new Promise((resolve) => {
            resolveProjection = resolve;
        }));

        const ResumeBrowsePickerScreen = (await import('@/app/(app)/new/pick/resume-browse')).default;
        await renderScreen(React.createElement(ResumeBrowsePickerScreen));
        await vi.waitFor(() => expect(resolveProjection).toBeTypeOf('function'));
        expect(routerMock.replace).not.toHaveBeenCalled();

        const projectionResolver = resolveProjection;
        if (typeof projectionResolver !== 'function') throw new Error('Expected a pending projection request');
        await act(async () => {
            projectionResolver({ supported: false, reason: 'not-supported' });
        });
        await flushHookEffects({ cycles: 2, turns: 2 });

        expect(browseScreenPropsRef.current).toBeNull();
        // The dismissal preserves the new-session context under the canonical
        // V2 target vocabulary instead of a bare '/new' href.
        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: expect.objectContaining({
                agentType: 'claude',
                dataId: routeParamsState.value.dataId,
                machineId: 'machine-cold',
                spawnServerId: 'server-cold',
            }),
        });
    });

    /**
     * Shares this file's harness because it needs the same thing: the REAL
     * `canBrowseExternalSessions`/`resolveExternalSessionBrowseLockedSource`
     * answering from a real daemon projection. A suite that stubs those
     * resolvers cannot see which interaction this route requests.
     */
    it('mounts the picker for an ACP-list resume-only source instead of dismissing itself', async () => {
        machineContributionRegistryProjectionDescribeMock.mockResolvedValue({
            supported: true,
            projection: PluginProjectionV2Schema.parse({
                v: 2,
                generation: 3,
                installedPackagesById: {
                    'happier.agent.claude': {
                        id: 'happier.agent.claude',
                        displayName: 'Claude',
                        enabled: true,
                        source: { kind: 'bundled', locator: 'happier.agent.claude' },
                    },
                },
                agentsById: {
                    claude: {
                        id: 'claude',
                        title: 'Claude',
                        catalogAgentId: 'claude',
                        iconAgentId: 'claude',
                        identity: { pluginId: 'happier.agent.claude', localId: 'claude' },
                        externalSessions: {
                            agent: { pluginId: 'happier.agent.claude', localId: 'claude' },
                            generation: 3,
                            operations: {
                                listCandidates: true,
                                resolveLinkIdentity: false,
                                pageTranscript: false,
                                readAfterTranscript: false,
                            },
                            sources: [{
                                sourceKind: 'claudeAcpSessionList',
                                resumeOnly: true,
                                schema: {
                                    fields: [{ name: 'kind', kind: 'literal', value: 'claudeAcpSessionList' }],
                                },
                                key: { segments: [{ kind: 'literal', value: 'claudeAcpSessionList' }] },
                                instances: [{ kind: 'default', constants: {} }],
                            }],
                        },
                    },
                },
            }),
        });

        const ResumeBrowsePickerScreen = (await import('@/app/(app)/new/pick/resume-browse')).default;
        await renderScreen(React.createElement(ResumeBrowsePickerScreen));
        await vi.waitFor(() => expect(browseScreenPropsRef.current).toEqual(expect.objectContaining({
            interaction: 'pickRemoteSessionId',
            lockScope: expect.objectContaining({
                machineId: 'machine-cold',
                providerId: 'claude',
                source: expect.objectContaining({ kind: 'claudeAcpSessionList' }),
            }),
        })));
        expect(routerMock.replace).not.toHaveBeenCalled();
        expect(routerMock.back).not.toHaveBeenCalled();
    });
});
