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
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { refreshAcpCatalog } from '@/sync/engine/settings/acpCatalogEngine';
import { getAcpCatalogSnapshot } from '@/sync/store/settings/acpCatalogSnapshot';
import { readCachedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import {
    BUNDLED_AGENT_ROUTE_PARAMS,
    createConfiguredAcpBackendCatalogSettings,
    createConfiguredBackendRouteParams,
    createConfiguredAgentRouteParams,
    createDiscoveredPluginBackendDescribeResult,
    createNavigationMock,
    createProjectionDescribeMock,
    createRouterMock,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
    parseJsonRouteParam,
} from './testHarness';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const routeParamsState = vi.hoisted(() => ({
    value: {
        agentType: 'claude',
        dataId: 'draft-1',
        machineId: 'machine-2',
        spawnServerId: 'srv_picker_2',
    } as Record<string, string>,
}));
const settingsState = vi.hoisted(() => ({
    current: {
        lastUsedAgent: 'claude',
        lastUsedBackendTarget: null as BackendTargetRefV2 | null,
        backendEnabledByTargetKey: null as Record<string, boolean> | null,
    },
}));
let acpDefinitions: Array<ReturnType<typeof AcpBackendDefinitionV1Schema.parse>> = [];
const machineContributionRegistryProjectionDescribe = createProjectionDescribeMock();

const previewMachine = createMachineFixture({
    id: 'machine-picked',
    storageMode: 'plain',
    activeAt: Date.now(),
});

const picker = await installPickerCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }),
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
    projectionSeam: { describe: machineContributionRegistryProjectionDescribe },
});

describe('PreviewMachinePickerScreen replace fallback', () => {
    beforeEach(() => {
        routeParamsState.value = {
            agentType: 'claude',
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'srv_picker_2',
        };
        settingsState.current = {
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: null,
            backendEnabledByTargetKey: null,
        };
        acpDefinitions = [];
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

    async function prepareAcpCatalog() {
        const scope = picker.accountScope;
        picker.homeBoundary.answer(scope.serverId, ACP_CATALOG_ROWS_ROUTE_V1, { body: AcpCatalogRowReadResponseV1Schema.parse({
            status: 'present', revision: 3, content: { t: 'plain', v: { v: 1, definitions: acpDefinitions } },
        }) });
    }

    async function awaitRenderedCatalog() {
        const scope = picker.accountScope;
        await act(async () => { await refreshAcpCatalog(scope); });
        await waitForHomeGovernance(() => expect(getAcpCatalogSnapshot(scope)).toMatchObject({
            scope, stale: false, catalog: { status: 'ready', revision: 3 },
        }));
    }

    it('opens resolved shared Machine names beneath one offline fold per ownership section', async () => {
        await prepareAcpCatalog();
        const { storage } = await import('@/sync/domains/state/storageStore');
        const { publishMachineActivityForTest } = await import('@/dev/testkit/harness/machinePresence');
        const { getActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        await applyPickerFixtureSettings(settingsParse(settingsState.current));
        const serverId = getActiveServerId();
        const named = ['owned-1', 'owned-2', 'shared-1', 'shared-2'].map((id, index) => createMachineFixture({
            id, active: false, activeAt: 0, storageMode: 'plain',
            metadata: { ...previewMachine.metadata!, displayName: id },
            ...(index >= 2 ? { isShared: true, access: { custodian: { accountId: 'qa-c', displayName: 'qa-c' },
                role: 'use' as const, resourceMode: 'plain' as const, accessState: 'ready' as const } } : {}),
        }));
        // Cold shells have no availability verdict until their content is opened.
        storage.getState().applyMachines(named.map(machine => ({ ...machine, metadata: null, availability: undefined })), true, { sourceServerId: serverId });
        publishMachineActivityForTest(named);
        storage.setState({ machineListByServerId: { [serverId]: named.map(machine => ({ ...machine, metadata: null, availability: undefined })) }, machineListStatusByServerId: { [serverId]: 'loading' } });
        const PreviewMachinePickerScreen = (await import('@/app/(app)/new/pick/preview-machine')).default;
        const { SelectionList } = await import('@/components/ui/selectionList');
        const screen = await renderScreen(<PreviewMachinePickerScreen />);
        await awaitRenderedCatalog();
        const coldSections = screen.findByType(SelectionList).props.rootStep.sections as readonly import('@/components/ui/selectionList').SelectionListSectionDescriptor[];
        const coldMachineRows = coldSections.flatMap(section => section.kind === 'static' ? section.options : [])
            .filter(option => named.some(machine => machine.id === option.id));
        expect(coldMachineRows).toEqual([]);
        await act(async () => {
            storage.setState({ machineListByServerId: { [serverId]: named }, machineListStatusByServerId: { [serverId]: 'idle' } });
        });
        const sections = () => screen.findByType(SelectionList).props.rootStep.sections;
        const folds = () => sections().flatMap((section: import('@/components/ui/selectionList').SelectionListSectionDescriptor) =>
            section.kind === 'static' ? section.options.filter(option => option.id.startsWith('offline:')) : []);
        expect(folds().map((fold: { id: string }) => fold.id)).toEqual(['offline:all', 'offline:shared:qa-c']);
        for (const fold of folds()) await act(async () => { fold.onSelect(); });
        const options = sections().flatMap((section: import('@/components/ui/selectionList').SelectionListSectionDescriptor) => section.kind === 'static' ? section.options : []);
        for (const machine of named) expect(options.find((option: { id: string }) => option.id === machine.id)?.label)
            .toBe(machine.metadata?.displayName ?? machine.metadata?.host);
        expect(folds()).toHaveLength(2);
        await screen.unmount();
    });

    it('preserves the new-session context when the preview machine picker has to replace back to /new', async () => {
        await prepareAcpCatalog();
        const { storage } = await import('@/sync/domains/state/storageStore');
        await applyPickerFixtureSettings(settingsParse(settingsState.current));
        storage.getState().applyMachines([previewMachine], true, { sourceServerId: 'srv_picker_2' });
        const PreviewMachinePickerScreen = (await import('@/app/(app)/new/pick/preview-machine')).default;

        const screen = await renderScreen(React.createElement(PreviewMachinePickerScreen));
        await awaitRenderedCatalog();

        const { MachineSelector } = await import('@/components/sessions/new/components/MachineSelector');
        const props = screen.findByType(MachineSelector).props;
        expect(typeof props?.onSelect).toBe('function');

        await act(async () => {
            await props?.onSelect?.(previewMachine);
        });

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                // A real bundled `agentType` already on the route survives as
                // the UI placeholder next to the qualified V2 target.
                agentType: 'claude',
                ...BUNDLED_AGENT_ROUTE_PARAMS.claude,
                dataId: 'draft-1',
                machineId: 'machine-2',
                previewMachineId: 'machine-picked',
                spawnServerId: 'srv_picker_2',
            },
        });
        expect(routerMock.setParams).not.toHaveBeenCalled();
        expect(routerMock.back).not.toHaveBeenCalled();
    });

    it('preserves configured backend route params when replace fallback is needed without reserializing the legacy customAcp agentType', async () => {
        await prepareAcpCatalog();
        routeParamsState.value = {
            agentType: 'customAcp',
            ...createConfiguredBackendRouteParams('review-bot'),
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'srv_picker_2',
        };
        const { storage } = await import('@/sync/domains/state/storageStore');
        await applyPickerFixtureSettings(settingsParse(settingsState.current));
        storage.getState().applyMachines([previewMachine], true, { sourceServerId: 'srv_picker_2' });
        const PreviewMachinePickerScreen = (await import('@/app/(app)/new/pick/preview-machine')).default;

        const screen = await renderScreen(React.createElement(PreviewMachinePickerScreen));
        await awaitRenderedCatalog();

        const { MachineSelector } = await import('@/components/sessions/new/components/MachineSelector');
        const props = screen.findByType(MachineSelector).props;
        expect(typeof props?.onSelect).toBe('function');

        await act(async () => {
            await props?.onSelect?.(previewMachine);
        });

        expect(routerMock.replace).toHaveBeenCalledTimes(1);
        const [call] = routerMock.replace.mock.calls;
        const args = call?.[0];

        expect(args).toEqual(expect.objectContaining({
            pathname: '/new',
            params: expect.objectContaining({
                backendTargetKey: 'agent:happier.agent.custom-acp/custom-acp:definition:review-bot',
                dataId: 'draft-1',
                machineId: 'machine-2',
                previewMachineId: 'machine-picked',
                spawnServerId: 'srv_picker_2',
            }),
        }));
        if (!args || typeof args !== 'object' || !('params' in args) || !args.params || typeof args.params !== 'object') {
            throw new Error('Expected a configured Agent return route');
        }
        expect(args.params).not.toHaveProperty('agentType');
        const backendTarget = AgentExecutionTargetV1Schema.parse(parseJsonRouteParam(Reflect.get(args.params, 'backendTarget')));
        expect(backendTarget).toMatchObject({
            kind: 'agent',
            identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' },
            definitionId: 'review-bot',
        });
    });

    it('rehydrates canonical configured backend params from settings when route params only carry legacy customAcp', async () => {
        settingsState.current = {
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
            backendEnabledByTargetKey: null,
        };
        acpDefinitions = createConfiguredAcpBackendCatalogSettings('review-bot').backends.map(definition => AcpBackendDefinitionV1Schema.parse(definition));
        await prepareAcpCatalog();
        routeParamsState.value = {
            agentType: 'customAcp',
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'srv_picker_2',
        };
        const { storage } = await import('@/sync/domains/state/storageStore');
        await applyPickerFixtureSettings(settingsParse(settingsState.current));
        storage.getState().applyMachines([previewMachine], true, { sourceServerId: 'srv_picker_2' });
        const PreviewMachinePickerScreen = (await import('@/app/(app)/new/pick/preview-machine')).default;

        const screen = await renderScreen(React.createElement(PreviewMachinePickerScreen));
        await awaitRenderedCatalog();

        const { MachineSelector } = await import('@/components/sessions/new/components/MachineSelector');
        const props = screen.findByType(MachineSelector).props;
        expect(typeof props?.onSelect).toBe('function');

        await act(async () => {
            await props?.onSelect?.(previewMachine);
        });

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                ...createConfiguredAgentRouteParams('review-bot'),
                dataId: 'draft-1',
                machineId: 'machine-2',
                previewMachineId: 'machine-picked',
                spawnServerId: 'srv_picker_2',
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
        await prepareAcpCatalog();
        routeParamsState.value = {
            agentType: 'customAcp',
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'srv_picker_2',
        };
        const { storage } = await import('@/sync/domains/state/storageStore');
        await applyPickerFixtureSettings(settingsParse(settingsState.current));
        storage.getState().applyMachines([previewMachine], true, { sourceServerId: 'srv_picker_2' });
        const PreviewMachinePickerScreen = (await import('@/app/(app)/new/pick/preview-machine')).default;

        const screen = await renderScreen(React.createElement(PreviewMachinePickerScreen));
        await awaitRenderedCatalog();

        const { MachineSelector } = await import('@/components/sessions/new/components/MachineSelector');
        const props = screen.findByType(MachineSelector).props;
        expect(typeof props?.onSelect).toBe('function');

        await act(async () => {
            await props?.onSelect?.(previewMachine);
        });

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                ...createConfiguredAgentRouteParams('stale-review-bot'),
                dataId: 'draft-1',
                machineId: 'machine-2',
                previewMachineId: 'machine-picked',
                spawnServerId: 'srv_picker_2',
            },
        });
    });

    it('falls back to the preferred built-in target when route params only carry legacy customAcp even when merged projection lists discovered plugin backends', async () => {
        settingsState.current = {
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: null,
            backendEnabledByTargetKey: null,
        };
        await prepareAcpCatalog();
        routeParamsState.value = {
            agentType: 'customAcp',
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'srv_picker_2',
        };
        machineContributionRegistryProjectionDescribe.mockResolvedValue(createDiscoveredPluginBackendDescribeResult());
        const { storage } = await import('@/sync/domains/state/storageStore');
        await applyPickerFixtureSettings(settingsParse(settingsState.current));
        storage.getState().applyMachines([previewMachine], true, { sourceServerId: 'srv_picker_2' });
        const PreviewMachinePickerScreen = (await import('@/app/(app)/new/pick/preview-machine')).default;

        const screen = await renderScreen(React.createElement(PreviewMachinePickerScreen));
        await awaitRenderedCatalog();

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: 'machine-2', serverId: 'srv_picker_2' }))
                .not.toBeNull();
        });
        const projection = readCachedDaemonMergedProjectionCacheEntry({ machineId: 'machine-2', serverId: 'srv_picker_2' });
        expect(projection?.kind === 'error' ? projection.reason : projection?.kind).toBe('ready');

        const { MachineSelector } = await import('@/components/sessions/new/components/MachineSelector');
        const props = screen.findByType(MachineSelector).props;
        expect(typeof props?.onSelect).toBe('function');

        await act(async () => {
            await props?.onSelect?.(previewMachine);
        });

        expect(machineContributionRegistryProjectionDescribe).toHaveBeenCalledWith('machine-2', expect.objectContaining({
            serverId: 'srv_picker_2',
            accountId: 'account:srv_picker_2',
        }));
        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                ...BUNDLED_AGENT_ROUTE_PARAMS.claude,
                dataId: 'draft-1',
                machineId: 'machine-2',
                previewMachineId: 'machine-picked',
                spawnServerId: 'srv_picker_2',
            },
        });
    });
});
