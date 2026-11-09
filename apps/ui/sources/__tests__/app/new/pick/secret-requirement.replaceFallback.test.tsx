import { applyPickerFixtureSettings } from './testHarness';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

// Catalog owners import the Socket SDK before the runtime setup hook.
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { LaunchProfileV2Schema } from '@happier-dev/protocol/profiles/v2/schema';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1, ProfileRecordV1Schema,
    ProfileRowsListResponseV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { refreshAcpCatalog } from '@/sync/engine/settings/acpCatalogEngine';
import { getAcpCatalogSnapshot } from '@/sync/store/settings/acpCatalogSnapshot';
import { refreshProfileCatalog } from '@/sync/engine/settings/profileCatalogEngine';
import { getProfileCatalogSnapshot } from '@/sync/store/settings/profileCatalogSnapshot';
import { readCachedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import {
    BUNDLED_AGENT_ROUTE_PARAMS,
    createDiscoveredPluginBackendDescribeResult,
    createNavigationMock,
    createProjectionDescribeMock,
    createRouterMock,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
} from './testHarness';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const routeParamsState = vi.hoisted(() => ({
    current: {
        agentType: 'customAcp',
        dataId: 'draft-1',
        profileId: 'deepseek',
        machineId: 'machine-2',
        secretEnvVarName: 'DEPLOY_TOKEN',
        secretEnvVarNames: 'DEPLOY_TOKEN',
        spawnServerId: 'srv_picker_2',
    } as Record<string, string>,
}));
const settingsState = vi.hoisted(() => ({
    current: {
        lastUsedAgent: 'customAcp',
        lastUsedBackendTarget: null as unknown,
        backendEnabledByTargetKey: null as Record<string, boolean> | null,
    },
}));
const machineContributionRegistryProjectionDescribe = createProjectionDescribeMock();

const picker = installPickerCommonModuleMocks({
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

describe('SecretRequirementPickerScreen replace fallback', () => {
    beforeEach(() => {
        routeParamsState.current = {
            agentType: 'customAcp',
            dataId: 'draft-1',
            profileId: 'deepseek',
            machineId: 'machine-2',
            secretEnvVarName: 'DEPLOY_TOKEN',
            secretEnvVarNames: 'DEPLOY_TOKEN',
            spawnServerId: 'srv_picker_2',
        };
        settingsState.current = {
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: null,
            backendEnabledByTargetKey: null,
        };
        routerMock.replace.mockClear();
        routerMock.push.mockClear();
        routerMock.back.mockClear();
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
                    key: 'secret-requirement-picker-route',
                    name: '(app)/new/pick/secret-requirement',
                    path: '/new/pick/secret-requirement',
                },
            ],
        });
    });

    afterEach(() => {
        standardCleanup();
    });

    it('falls back to the preferred built-in target when route params only carry legacy customAcp and no explicit backend target is stored', async () => {
        machineContributionRegistryProjectionDescribe.mockResolvedValue(createDiscoveredPluginBackendDescribeResult());

        const { storage } = await import('@/sync/domains/state/storageStore');
        await applyPickerFixtureSettings(settingsParse(settingsState.current));
        const profile = LaunchProfileV2Schema.parse({
            v: 2, id: 'deepseek', name: 'DeepSeek', extraEnvironmentVariables: [],
            envVarRequirements: [{ name: 'DEPLOY_TOKEN', kind: 'secret', required: true }],
            defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {},
            compatibilityByTargetKey: {}, createdAt: 1, updatedAt: 1,
        });
        const scope = picker.accountScope;
        picker.homeBoundary.answer(scope.serverId, ACP_CATALOG_ROWS_ROUTE_V1, { body: AcpCatalogRowReadResponseV1Schema.parse({
            status: 'present', revision: 3, content: { t: 'plain', v: { v: 1, definitions: [] } },
        }) });
        const record = ProfileRecordV1Schema.parse({ v: 1, id: profile.id, definition: { kind: 'inline', profile },
            enabled: true, promptStack: [], secretBindings: {} });
        picker.homeBoundary.answer(scope.serverId, PROFILE_ROWS_ROUTE_V1, { body: ProfileRowsListResponseV1Schema.parse({
            status: 'listed', rows: [{ id: profile.id, revision: 2, content: { t: 'plain', v: record } }],
            nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: 3, transferControl: { status: 'absent' },
        }) });
        picker.homeBoundary.answer(scope.serverId, PROFILE_REFERENCE_GUARD_ROUTE_V1, { body: { status: 'ready', revision: 3 } });
        picker.homeBoundary.answer(scope.serverId, PROFILE_TRANSFER_ROUTE_V1, { body: { status: 'absent' } });
        const SecretRequirementPickerScreen = (await import('@/app/(app)/new/pick/secret-requirement')).default;
        const screen = await renderScreen(React.createElement(SecretRequirementPickerScreen));
        await act(async () => { await refreshAcpCatalog(scope); await refreshProfileCatalog(scope); });
        await waitForHomeGovernance(() => {
            expect(getAcpCatalogSnapshot(scope)).toMatchObject({ scope, stale: false, catalog: { status: 'ready' } });
            expect(getProfileCatalogSnapshot(scope)).toMatchObject({ scope, catalog: { status: 'ready' }, stale: false });
        });
        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: 'machine-2', serverId: 'srv_picker_2' }))
                .toMatchObject({ kind: 'ready' });
        });

        const { SecretRequirementScreen } = await import('@/components/secrets/requirements');
        const props = screen.findByType(SecretRequirementScreen).props;
        expect(typeof props?.onResolve).toBe('function');

        await act(async () => {
            await props?.onResolve?.({ action: 'cancel' });
        });

        expect(machineContributionRegistryProjectionDescribe).toHaveBeenCalledWith('machine-2', expect.objectContaining({
            serverId: 'srv_picker_2',
            accountId: 'account:srv_picker_2',
        }));
        expect(routerMock.replace).toHaveBeenCalledTimes(1);
        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: {
                ...BUNDLED_AGENT_ROUTE_PARAMS.claude,
                dataId: 'draft-1',
                machineId: 'machine-2',
                profileId: 'deepseek',
                secretRequirementResultId: expect.any(String),
                spawnServerId: 'srv_picker_2',
            },
        });
        const resultHref = routerMock.replace.mock.calls[0]?.[0];
        if (typeof resultHref !== 'object' || resultHref === null || !('params' in resultHref)) {
            throw new Error('Expected the returned secret result carrier');
        }
        const resultParams = resultHref.params;
        if (!resultParams || typeof resultParams !== 'object' || !('secretRequirementResultId' in resultParams)
            || typeof resultParams.secretRequirementResultId !== 'string') {
            throw new Error('Expected a real one-shot secret result id');
        }
        const { getTempData, peekTempData } = await import('@/utils/sessions/tempDataStore');
        const expectedResult = { profileId: 'deepseek', revertOnCancel: false, result: { action: 'cancel' } };
        expect(peekTempData(resultParams.secretRequirementResultId)).toEqual(expectedResult);
        expect(getTempData(resultParams.secretRequirementResultId)).toEqual(expectedResult);
        expect(peekTempData(resultParams.secretRequirementResultId)).toBeNull();
    });
});
