import { applyPickerFixtureSettings } from './testHarness';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { settingsParse } from '@/sync/domains/settings/settings';
import type { BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { SavedSecretSchema } from '@/sync/domains/settings/savedSecretTypes';
import { SavedSecretResourceMaterialsResponseV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { refreshSavedSecretCatalog } from '@/sync/engine/settings/savedSecretCatalogEngine';
import { getSavedSecretCatalogSnapshot } from '@/sync/store/settings/savedSecretCatalogSnapshot';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { AgentExecutionTargetV1Schema } from '@happier-dev/protocol/agents/executionTargetV1';
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
const routeParamsState = {
    current: {
        agentType: 'claude',
        ...createConfiguredBackendRouteParams('claude-sonnet'),
        dataId: 'draft-1',
        machineId: 'machine-2',
        spawnServerId: 'srv_picker_2',
    } as Record<string, string>,
};
const settingsState = {
    current: {
        lastUsedAgent: 'claude',
        lastUsedBackendTarget: null as BackendTargetRefV2 | null,
        backendEnabledByTargetKey: null as Record<string, boolean> | null,
    },
};
const machineContributionRegistryProjectionDescribe = createProjectionDescribeMock();
let selectableSecret: ReturnType<typeof SavedSecretSchema.parse>;
const selectedSecretRef = formatSharedSavedSecretRefV1('secret-picked');
let acpDefinitions: Array<ReturnType<typeof AcpBackendDefinitionV1Schema.parse>> = [];

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
                params: () => routeParamsState.current,
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

describe('SecretPickerScreen replace fallback', () => {
    beforeEach(() => {
        // The current resource catalog opens plain Account material in memory;
        // this fixture never writes a plaintext SecretString to device Settings.
        selectableSecret = SavedSecretSchema.parse({ id: selectedSecretRef, name: 'Picker fixture',
            encryptedValue: { _isSecretValue: true, value: 'test-only-secret' }, createdAt: 0, updatedAt: 3 });
        acpDefinitions = [];
        routeParamsState.current = {
            agentType: 'claude',
            ...createConfiguredBackendRouteParams('claude-sonnet'),
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'srv_picker_2',
        };
        settingsState.current = {
            lastUsedAgent: 'claude',
            lastUsedBackendTarget: null,
            backendEnabledByTargetKey: null,
        };
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
                    key: 'secret-picker-route',
                    name: '(app)/new/pick/secret',
                    path: '/new/pick/secret',
                },
            ],
        });
    });

    afterEach(() => {
        standardCleanup();
    });

    async function renderSecretPicker() {
        const scope = picker.accountScope;
        picker.homeBoundary.answer(scope.serverId, ACP_CATALOG_ROWS_ROUTE_V1, { body: AcpCatalogRowReadResponseV1Schema.parse({
            status: 'present', revision: 3, content: { t: 'plain', v: { v: 1, definitions: acpDefinitions } },
        }) });
        const { storage } = await import('@/sync/domains/state/storageStore');
        await applyPickerFixtureSettings(settingsParse(settingsState.current));
        picker.homeBoundary.answer(scope.serverId, '/v1/account/saved-secrets/resources/materials', {
            body: SavedSecretResourceMaterialsResponseV1Schema.parse({ resources: [{
                resourceId: 'secret-picked', encryptionMode: 'plain', recipientEnvelope: null,
                entry: { ref: selectedSecretRef, source: 'shared_resource', relationship: 'owner',
                    name: selectableSecret.name, kind: selectableSecret.kind, encryptionMode: 'plain',
                    ownerAccountId: scope.accountId, revision: 3, materialStatus: 'ready',
                    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true } },
                storedContent: { t: 'plain', v: { v: 1, name: selectableSecret.name, kind: selectableSecret.kind, value: 'test-only-secret' } },
            }] }),
        });
        const SecretPickerScreen = (await import('@/app/(app)/new/pick/secret')).default;
        const screen = await renderScreen(React.createElement(SecretPickerScreen));
        await act(async () => { await refreshAcpCatalog(scope); await refreshSavedSecretCatalog(scope); });
        await waitForHomeGovernance(() => {
            expect(getAcpCatalogSnapshot(scope)).toMatchObject({ scope, stale: false, catalog: { status: 'ready', revision: 3 } });
            expect(getSavedSecretCatalogSnapshot(scope)).toMatchObject({ scope, stale: false, status: 'ready',
                data: [expect.objectContaining({ ref: selectedSecretRef, relationship: 'owner', materialStatus: 'ready' })] });
        });
        return screen;
    }

    it('preserves the new-session context when the secret picker has to replace back to /new', async () => {
        const screen = await renderSecretPicker();

        const { SecretsList } = await import('@/components/secrets/SecretsList');
        const props = screen.findByType(SecretsList).props;
        expect(props.sharedEntries).toEqual([expect.objectContaining({ ref: selectedSecretRef,
            name: selectableSecret.name, relationship: 'owner', revision: 3, materialStatus: 'ready' })]);
        expect(props.resolveSharedReference(selectedSecretRef)).toMatchObject({ status: 'ready', secret: selectableSecret });
        expect(typeof props?.onSelectId).toBe('function');

        await act(async () => {
            await screen.pressByTestIdAsync(`saved-secret:${selectedSecretRef}`);
        });

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                ...createConfiguredAgentRouteParams('claude-sonnet'),
                agentType: 'claude',
                dataId: 'draft-1',
                machineId: 'machine-2',
                secretId: selectedSecretRef,
                spawnServerId: 'srv_picker_2',
            },
        });
        expect(routerMock.setParams).not.toHaveBeenCalled();
        expect(routerMock.back).not.toHaveBeenCalled();
    });

    it('rehydrates canonical configured backend params from settings when route params only carry legacy customAcp', async () => {
        routeParamsState.current = {
            agentType: 'customAcp',
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'srv_picker_2',
        };
        settingsState.current = {
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
            backendEnabledByTargetKey: null,
        };
        const screen = await renderSecretPicker();

        const { SecretsList } = await import('@/components/secrets/SecretsList');
        const props = screen.findByType(SecretsList).props;
        expect(props.sharedEntries).toEqual([expect.objectContaining({ ref: selectedSecretRef,
            name: selectableSecret.name, relationship: 'owner', revision: 3, materialStatus: 'ready' })]);
        expect(props.resolveSharedReference(selectedSecretRef)).toMatchObject({ status: 'ready', secret: selectableSecret });
        expect(typeof props?.onSelectId).toBe('function');

        await act(async () => {
            await screen.pressByTestIdAsync(`saved-secret:${selectedSecretRef}`);
        });

        expect(routerMock.replace).toHaveBeenCalledTimes(1);
        const [call] = routerMock.replace.mock.calls;
        const args = call?.[0];

        expect(args).toEqual(expect.objectContaining({
            pathname: '/new',
            params: expect.objectContaining({
                backendTargetKey: createConfiguredAgentRouteParams('review-bot').backendTargetKey,
                dataId: 'draft-1',
                machineId: 'machine-2',
                secretId: selectedSecretRef,
                spawnServerId: 'srv_picker_2',
            }),
        }));

        if (!args || typeof args !== 'object' || !('params' in args)) throw new Error('Expected returned route params');
        const returnedParams = args.params;
        if (!returnedParams || typeof returnedParams !== 'object' || !('backendTarget' in returnedParams)) {
            throw new Error('Expected returned Agent target');
        }
        const backendTarget = AgentExecutionTargetV1Schema.parse(parseJsonRouteParam(returnedParams.backendTarget));
        expect(backendTarget).toEqual({
            kind: 'agent', identity: { pluginId: 'happier.agent.custom-acp', localId: 'custom-acp' },
            definitionId: 'review-bot',
        });
    });

    it('retains explicit configured intent for repair when its definition is missing', async () => {
        routeParamsState.current = {
            agentType: 'customAcp',
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'srv_picker_2',
        };
        settingsState.current = {
            lastUsedAgent: 'codex',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'stale-review-bot', configuredBackendId: 'stale-review-bot', sourceKind: 'configured' },
            backendEnabledByTargetKey: { 'agent:codex': true },
        };
        acpDefinitions = createConfiguredAcpBackendCatalogSettings('review-bot').backends.map(definition => AcpBackendDefinitionV1Schema.parse(definition));
        const screen = await renderSecretPicker();

        const { SecretsList } = await import('@/components/secrets/SecretsList');
        const props = screen.findByType(SecretsList).props;
        expect(props.sharedEntries).toEqual([expect.objectContaining({ ref: selectedSecretRef,
            name: selectableSecret.name, relationship: 'owner', revision: 3, materialStatus: 'ready' })]);
        expect(props.resolveSharedReference(selectedSecretRef)).toMatchObject({ status: 'ready', secret: selectableSecret });
        expect(typeof props?.onSelectId).toBe('function');

        await act(async () => {
            await screen.pressByTestIdAsync(`saved-secret:${selectedSecretRef}`);
        });

        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                ...createConfiguredAgentRouteParams('stale-review-bot'),
                dataId: 'draft-1',
                machineId: 'machine-2',
                secretId: selectedSecretRef,
                spawnServerId: 'srv_picker_2',
            },
        });
    });

    it('falls back to the preferred built-in target when route params only carry legacy customAcp even when merged projection lists discovered plugin backends', async () => {
        routeParamsState.current = {
            agentType: 'customAcp',
            dataId: 'draft-1',
            machineId: 'machine-2',
            spawnServerId: 'srv_picker_2',
        };
        settingsState.current = {
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: null,
            backendEnabledByTargetKey: null,
        };
        machineContributionRegistryProjectionDescribe.mockResolvedValue(createDiscoveredPluginBackendDescribeResult());
        const screen = await renderSecretPicker();
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: 'machine-2', serverId: 'srv_picker_2' }))
                .toMatchObject({ kind: 'ready' });
        });

        const { SecretsList } = await import('@/components/secrets/SecretsList');
        const props = screen.findByType(SecretsList).props;
        expect(props.sharedEntries).toEqual([expect.objectContaining({ ref: selectedSecretRef,
            name: selectableSecret.name, relationship: 'owner', revision: 3, materialStatus: 'ready' })]);
        expect(props.resolveSharedReference(selectedSecretRef)).toMatchObject({ status: 'ready', secret: selectableSecret });
        expect(typeof props?.onSelectId).toBe('function');

        await act(async () => {
            await screen.pressByTestIdAsync(`saved-secret:${selectedSecretRef}`);
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
                secretId: selectedSecretRef,
                spawnServerId: 'srv_picker_2',
            },
        });
    });
});
