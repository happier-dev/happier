import { applyPickerFixtureSettings } from './testHarness';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

// Catalog owners import the Socket SDK before the runtime setup hook.
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { settingsParse } from '@/sync/domains/settings/settings';
import type { BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { refreshAcpCatalog } from '@/sync/engine/settings/acpCatalogEngine';
import { getAcpCatalogSnapshot } from '@/sync/store/settings/acpCatalogSnapshot';
import { readCachedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';

import {
    BUNDLED_AGENT_ROUTE_PARAMS,
    cloneNavigationState,
    createConfiguredAcpBackendCatalogSettings,
    createConfiguredBackendRouteParams,
    createConfiguredAgentRouteParams,
    createDiscoveredPluginBackendDescribeResult,
    createNavigationMock,
    createProjectionDescribeMock,
    createRouterMock,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
    PICKER_THEME_COLORS,
    type PickerNavigationState,
} from './testHarness';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const settingsState = {
    current: {
        lastUsedAgent: 'claude',
        lastUsedBackendTarget: null as BackendTargetRefV2 | null,
        backendEnabledByTargetKey: null as Record<string, boolean> | null,
    },
};
let acpDefinitions: Array<ReturnType<typeof AcpBackendDefinitionV1Schema.parse>> = [];
const machineContributionRegistryProjectionDescribe = createProjectionDescribeMock();
const pickerMachineMetadata = {
    host: 'tester.local',
    platform: 'darwin',
    happyCliVersion: '0.0.0-test',
    happyHomeDir: '/Users/tester/.happy-dev',
    homeDir: '/home/test',
} as const;
const defaultPickerMachine = createMachineFixture({
    id: 'machine-1',
    storageMode: 'plain',
    metadata: pickerMachineMetadata,
});
let pickerMachine = defaultPickerMachine;
let pathSelectionProps: (() => React.ComponentProps<typeof import('@/components/sessions/new/components/PathSelectionList').PathSelectionList>) | null = null;
let localSearchParams: Record<string, string> = {
    machineId: 'machine-1',
    selectedPath: '/repo/current',
};
let navigationState: PickerNavigationState = cloneNavigationState({
    index: 0,
    routes: [{ key: 'path-picker', name: '(app)/new/pick/path', path: '/new/pick/path' }],
});
const paramListeners = new Set<() => void>();

function emitLocalSearchParamsChange() {
    for (const listener of paramListeners) {
        listener();
    }
}
const picker = installPickerCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            Platform: { OS: 'web' },
        }),
    unistyles: async () =>
        (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
            theme: {
                colors: {
                    ...PICKER_THEME_COLORS,
                    input: { background: '#fff', placeholder: '#aaa', text: '#000' },
                },
            },
        }),
    expoRouter: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        const module = createExpoRouterMock({
            navigation: navigationMock,
            router: {
                push: routerMock.push,
                back: routerMock.back,
                replace: routerMock.replace,
                setParams: routerMock.setParams,
            },
        }).module;

        return {
            ...module,
            useNavigation: () => navigationMock,
            useLocalSearchParams: () =>
                React.useSyncExternalStore(
                    (listener) => {
                        paramListeners.add(listener);
                        return () => {
                            paramListeners.delete(listener);
                        };
                    },
                    () => localSearchParams,
                    () => localSearchParams,
                ),
        };
    },
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    projectionSeam: { describe: machineContributionRegistryProjectionDescribe,
        ownIsolationStatus: () => ({ protection: 'member_separated', status: { kind: 'effective', platform: 'linux' },
            directories: { home: '/member/home', workspace: '/member/workspace' } }), serverProfiles: [
        { id: 'srv_picker_2', serverUrl: 'https://server-2.example.test' },
        { id: 'server-legacy', serverUrl: 'https://server-legacy.example.test' },
    ] },
});

describe('PathPickerScreen', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        pickerMachine = defaultPickerMachine;
        pathSelectionProps = null;
        localSearchParams = {
            machineId: 'machine-1',
            selectedPath: '/repo/current',
        };
        settingsState.current = {
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: null,
            backendEnabledByTargetKey: null,
        };
        acpDefinitions = [];
        paramListeners.clear();
        routerMock.setParams.mockReset();
        routerMock.replace.mockReset();
        routerMock.back.mockReset();
        navigationMock.goBack.mockReset();
        navigationMock.dispatch.mockReset();
        machineContributionRegistryProjectionDescribe.mockReset();
        machineContributionRegistryProjectionDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' });
        navigationState = {
            index: 0,
            routes: [{ key: 'path-picker', name: '(app)/new/pick/path', path: '/new/pick/path' }],
        };
        navigationMock.getState = () => navigationState;
    });

    async function renderPathPicker() {
        if (localSearchParams.spawnServerId === 'server-legacy') await picker.restoreHome('server-legacy');
        const scope = picker.accountScope;
        picker.homeBoundary.answer(scope.serverId, ACP_CATALOG_ROWS_ROUTE_V1, { body: AcpCatalogRowReadResponseV1Schema.parse({
            status: 'present', revision: 3, content: { t: 'plain', v: { v: 1, definitions: acpDefinitions } },
        }) });
        const { storage } = await import('@/sync/domains/state/storageStore');
        await applyPickerFixtureSettings(settingsParse({ ...settingsState.current, usePathPickerSearch: false, favoriteDirectories: [] }));
        storage.getState().applyMachines([pickerMachine], true, { sourceServerId: scope.serverId });
        const PathPickerScreen = (await import('@/app/(app)/new/pick/path')).default;
        const screen = await renderScreen(React.createElement(PathPickerScreen));
        if (localSearchParams.spawnServerId) {
            await act(async () => { await refreshAcpCatalog(scope); });
            await waitForHomeGovernance(() => expect(getAcpCatalogSnapshot(scope)).toMatchObject({
                scope, stale: false, catalog: { status: 'ready', revision: 3 },
            }));
        }
        const { PathSelectionList } = await import('@/components/sessions/new/components/PathSelectionList');
        pathSelectionProps = () => {
            // React's renderer SDK erases component prop types; retain the real
            // queried props while exposing the canonical required fields.
            const props = screen.findByType(PathSelectionList).props;
            return {
                ...props,
                initialValue: props.initialValue,
                favorites: props.favorites,
                recents: props.recents,
                machineHomeDir: props.machineHomeDir,
                machineId: props.machineId,
                onCommit: props.onCommit,
                onRequestClose: props.onRequestClose,
            };
        };
        return { PathPickerScreen, screen };
    }

    it.each([false, true])('resolves requester folders for member placement (shared %s)', async isShared => {
        pickerMachine = createMachineFixture({ ...defaultPickerMachine, isShared,
            access: { custodian: { accountId: isShared ? 'custodian-account' : picker.accountScope.accountId, displayName: 'Machine owner' },
                role: isShared ? 'use' : 'manage', resourceMode: 'plain', accessState: 'ready' }, metadata: { ...pickerMachineMetadata,
            platform: 'linux', agentIsolation: { enabled: true, memberProvisioning: 'linuxUsersV1' } } });
        localSearchParams = { machineId: 'machine-1' };
        await renderPathPicker();
        await vi.waitFor(async () => {
            await flushHookEffects();
            expect(pathSelectionProps?.().machineHomeDir).toBe('/member/home');
        });
        await act(async () => { await pathSelectionProps?.().onCommit(''); });
        expect(routerMock.replace).toHaveBeenCalledWith(expect.objectContaining({
            params: expect.objectContaining({ directoryKind: 'path', directory: '/member/workspace' }),
        }));
    });

    it('replaces to new session with path params when confirming without a previous route', async () => {
        await renderPathPicker();
        await flushHookEffects({ cycles: 1, turns: 2 });

        expect(pathSelectionProps).toBeTruthy();

        await act(async () => {
            await pathSelectionProps?.().onCommit('/repo/selected');
        });

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                ...BUNDLED_AGENT_ROUTE_PARAMS.claude,
                machineId: 'machine-1',
                directoryKind: 'path',
                directory: '/repo/selected',
                path: undefined,
            },
        });
        expect(routerMock.setParams).not.toHaveBeenCalled();
        expect(navigationMock.goBack).not.toHaveBeenCalled();
    });

    it('replaces back to /new instead of mutating a non-new previous route under the modal stack', async () => {
        navigationState = {
            index: 1,
            routes: [
                {
                    key: 'session-route',
                    name: '(app)/session/[id]',
                    path: '/session/s1',
                    params: { id: 's1' },
                },
                {
                    key: 'path-picker',
                    name: '(app)/new/pick/path',
                    path: '/new/pick/path',
                },
            ],
        };

        await renderPathPicker();

        await act(async () => {
            await Promise.resolve();
        });

        expect(pathSelectionProps).toBeTruthy();

        await act(async () => {
            await pathSelectionProps?.().onCommit('/repo/selected');
        });

        expect(navigationMock.dispatch).not.toHaveBeenCalled();
        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                ...BUNDLED_AGENT_ROUTE_PARAMS.claude,
                machineId: 'machine-1',
                directoryKind: 'path',
                directory: '/repo/selected',
                path: undefined,
            },
        });
        expect(navigationMock.goBack).not.toHaveBeenCalled();
    });

    it('preserves configured backend route params on replace fallback without reserializing the legacy customAcp agentType', async () => {
        localSearchParams = {
            agentType: 'customAcp',
            ...createConfiguredBackendRouteParams('review-bot'),
            machineId: 'machine-1',
            selectedPath: '/repo/current',
            spawnServerId: 'srv_picker_2',
        };
        navigationState = {
            index: 1,
            routes: [
                {
                    key: 'session-route',
                    name: '(app)/session/[id]',
                    path: '/session/s1',
                    params: { id: 's1' },
                },
                {
                    key: 'path-picker',
                    name: '(app)/new/pick/path',
                    path: '/new/pick/path',
                },
            ],
        };

        await renderPathPicker();

        expect(pathSelectionProps).toBeTruthy();

        await act(async () => {
            await pathSelectionProps?.().onCommit('/repo/selected');
        });

        expect(routerMock.replace).toHaveBeenCalledTimes(1);
        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                ...createConfiguredAgentRouteParams('review-bot'),
                machineId: 'machine-1',
                directoryKind: 'path',
                directory: '/repo/selected',
                path: undefined,
                spawnServerId: 'srv_picker_2',
            },
        });
    });

    it('falls back to the preferred built-in target when route params only carry legacy customAcp and no explicit backend target is stored', async () => {
        localSearchParams = {
            agentType: 'customAcp',
            machineId: 'machine-1',
            selectedPath: '/repo/current',
            spawnServerId: 'srv_picker_2',
        };
        settingsState.current = {
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: null,
            backendEnabledByTargetKey: null,
        };
        navigationState = {
            index: 1,
            routes: [
                {
                    key: 'session-route',
                    name: '(app)/session/[id]',
                    path: '/session/s1',
                    params: { id: 's1' },
                },
                {
                    key: 'path-picker',
                    name: '(app)/new/pick/path',
                    path: '/new/pick/path',
                },
            ],
        };
        machineContributionRegistryProjectionDescribe.mockResolvedValue(createDiscoveredPluginBackendDescribeResult());

        await renderPathPicker();
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: 'machine-1', serverId: 'srv_picker_2' }))
                .toMatchObject({ kind: 'ready' });
        });

        expect(pathSelectionProps).toBeTruthy();

        await act(async () => {
            await pathSelectionProps?.().onCommit('/repo/selected');
        });

        expect(machineContributionRegistryProjectionDescribe).toHaveBeenCalledWith('machine-1', expect.objectContaining({
            serverId: 'srv_picker_2',
            accountId: 'account:srv_picker_2',
        }));
        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                ...BUNDLED_AGENT_ROUTE_PARAMS.claude,
                machineId: 'machine-1',
                directoryKind: 'path',
                directory: '/repo/selected',
                path: undefined,
                spawnServerId: 'srv_picker_2',
            },
        });
    });

    it('rehydrates canonical configured backend params from settings when route params only carry legacy customAcp', async () => {
        settingsState.current = {
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
            backendEnabledByTargetKey: null,
        };
        acpDefinitions = createConfiguredAcpBackendCatalogSettings('review-bot').backends.map(definition => AcpBackendDefinitionV1Schema.parse(definition));
        localSearchParams = {
            agentType: 'customAcp',
            machineId: 'machine-1',
            selectedPath: '/repo/current',
            spawnServerId: 'server-legacy',
        };
        navigationState = {
            index: 1,
            routes: [
                {
                    key: 'session-route',
                    name: '(app)/session/[id]',
                    path: '/session/s1',
                    params: { id: 's1' },
                },
                {
                    key: 'path-picker',
                    name: '(app)/new/pick/path',
                    path: '/new/pick/path',
                },
            ],
        };

        await renderPathPicker();

        expect(pathSelectionProps).toBeTruthy();

        await act(async () => {
            await pathSelectionProps?.().onCommit('/repo/selected');
        });

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                ...createConfiguredAgentRouteParams('review-bot'),
                machineId: 'machine-1',
                directoryKind: 'path',
                directory: '/repo/selected',
                path: undefined,
                spawnServerId: 'server-legacy',
            },
        });
    });

    it('retains explicit configured intent for repair when its definition is missing', async () => {
        settingsState.current = {
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'stale-review-bot', configuredBackendId: 'stale-review-bot', sourceKind: 'configured' },
            backendEnabledByTargetKey: { 'agent:codex': true },
        };
        acpDefinitions = createConfiguredAcpBackendCatalogSettings('review-bot').backends.map(definition => AcpBackendDefinitionV1Schema.parse(definition));
        localSearchParams = {
            agentType: 'customAcp',
            machineId: 'machine-1',
            selectedPath: '/repo/current',
            spawnServerId: 'srv_picker_2',
        };
        navigationState = {
            index: 1,
            routes: [
                {
                    key: 'session-route',
                    name: '(app)/session/[id]',
                    path: '/session/s1',
                    params: { id: 's1' },
                },
                {
                    key: 'path-picker',
                    name: '(app)/new/pick/path',
                    path: '/new/pick/path',
                },
            ],
        };

        await renderPathPicker();

        expect(pathSelectionProps).toBeTruthy();

        await act(async () => {
            await pathSelectionProps?.().onCommit('/repo/selected');
        });

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                ...createConfiguredAgentRouteParams('stale-review-bot'),
                machineId: 'machine-1',
                directoryKind: 'path',
                directory: '/repo/selected',
                path: undefined,
                spawnServerId: 'srv_picker_2',
            },
        });
    });

    it('returns path updates to the actual /new screen instead of an intermediate picker route', async () => {
        navigationState = {
            index: 3,
            routes: [
                {
                    key: 'session-route',
                    name: '(app)/session/[id]',
                    path: '/session/s1',
                    params: { id: 's1' },
                },
                {
                    key: 'new-route',
                    name: '(app)/new/index',
                    path: '/new',
                    params: { machineId: 'machine-1' },
                },
                {
                    key: 'profile-picker',
                    name: '(app)/new/pick/profile',
                    path: '/new/pick/profile',
                    params: { profileId: 'profile-1' },
                },
                {
                    key: 'path-picker',
                    name: '(app)/new/pick/path',
                    path: '/new/pick/path',
                },
            ],
        };

        await renderPathPicker();

        expect(pathSelectionProps).toBeTruthy();

        await act(async () => {
            await pathSelectionProps?.().onCommit('/repo/selected');
        });

        expect(navigationMock.dispatch).toHaveBeenCalledWith(expect.objectContaining({
            source: 'new-route',
            payload: expect.objectContaining({
                params: expect.objectContaining({
                    directory: '/repo/selected',
                }),
            }),
        }));
        expect(routerMock.replace).not.toHaveBeenCalled();
        expect(navigationMock.goBack).toHaveBeenCalledOnce();
    });

    it('uses the direct-entry path query as a fallback selected path', async () => {
        localSearchParams = {
            machineId: 'machine-1',
            path: '/repo/direct-entry',
        };

        await renderPathPicker();

        expect(pathSelectionProps?.().initialValue).toBe('/repo/direct-entry');
    });

    it('updates the selected path when route params change after mount', async () => {
        await renderPathPicker();

        expect(pathSelectionProps?.().initialValue).toBe('/repo/current');

        localSearchParams = {
            machineId: 'machine-1',
            selectedPath: '/repo/updated',
        };

        act(() => {
            emitLocalSearchParamsChange();
        });

        expect(pathSelectionProps?.().initialValue).toBe('/repo/updated');
    });
});
