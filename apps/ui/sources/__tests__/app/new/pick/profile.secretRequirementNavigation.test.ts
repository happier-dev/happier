import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
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
    PICKER_THEME_COLORS,
    PICKER_NAV_STATE,
} from './testHarness';
import {
    createMissingRequiredSecretScenario,
    profileSecretRequirementModalMock,
    resetProfileSecretRequirementHarness,
} from './profileSecretRequirementTestHarness';
import { settingsParse } from '@/sync/domains/settings/settings';
import { LaunchProfileV2Schema } from '@happier-dev/protocol/profiles/v2/schema';
import type { BackendTargetRefV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { ACP_CATALOG_ROWS_ROUTE_V1, AcpCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/acp/catalog/catalogRowsV1';
import { AcpBackendDefinitionV1Schema } from '@happier-dev/protocol/acp/catalog/settingsV1';
import { PROFILE_ROWS_ROUTE_V1, PROFILE_REFERENCE_GUARD_ROUTE_V1, ProfileRecordV1Schema,
    ProfileRowsListResponseV1Schema } from '@happier-dev/protocol/profiles/profileRecordV1';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { refreshAcpCatalog } from '@/sync/engine/settings/acpCatalogEngine';
import { getAcpCatalogSnapshot } from '@/sync/store/settings/acpCatalogSnapshot';
import { refreshProfileCatalog } from '@/sync/engine/settings/profileCatalogEngine';
import { getProfileCatalogSnapshot } from '@/sync/store/settings/profileCatalogSnapshot';
import { readCachedDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';

enableReactActEnvironment();

const missingRequiredSecretScenario = createMissingRequiredSecretScenario();
const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const routeParamsState = {
    value: {
        selectedId: '',
        dataId: 'draft-1',
        machineId: 'm1',
        agentType: 'customAcp',
        ...createConfiguredBackendRouteParams('review-bot'),
        spawnServerId: 'srv_picker_2',
    } as Record<string, string>,
};
const settingsState = {
    current: {
        lastUsedAgent: 'customAcp',
        lastUsedBackendTarget: null as BackendTargetRefV2 | null,
        backendEnabledByTargetKey: null as Record<string, boolean> | null,
    },
};
const machineContributionRegistryProjectionDescribe = createProjectionDescribeMock();

const picker = installPickerCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeNativeMock({ platformOS: 'ios' }),
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    unistyles: async () =>
        (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock({
            theme: { colors: PICKER_THEME_COLORS },
        }),
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
    modal: async () => profileSecretRequirementModalMock.module,
    projectionSeam: { describe: machineContributionRegistryProjectionDescribe },
});

async function renderProfilePicker() {
    const { storage } = await import('@/sync/domains/state/storageStore');
    const profile = LaunchProfileV2Schema.parse({
        v: 2, id: 'deepseek', name: 'DeepSeek', extraEnvironmentVariables: [],
        envVarRequirements: [{ name: missingRequiredSecretScenario.secretEnvVarName, kind: 'secret', required: true }],
        defaultPermissionModeByTargetKey: {}, defaultPersistenceModeByTargetKey: {},
        compatibilityByTargetKey: {}, createdAt: 1, updatedAt: 1,
    });
    storage.getState().applySettingsLocal(settingsParse({ ...settingsState.current, useProfiles: true }));
    const scope = picker.accountScope;
    picker.homeBoundary.answer(scope.serverId, ACP_CATALOG_ROWS_ROUTE_V1, { body: AcpCatalogRowReadResponseV1Schema.parse({
        status: 'present', revision: 3, content: { t: 'plain', v: { v: 1,
            definitions: settingsState.current.lastUsedBackendTarget
                ? createConfiguredAcpBackendCatalogSettings('review-bot').backends.map(definition => AcpBackendDefinitionV1Schema.parse(definition))
                : [] } },
    }) });
    const record = ProfileRecordV1Schema.parse({ v: 1, id: profile.id, definition: { kind: 'inline', profile },
        enabled: true, promptStack: [], secretBindings: {} });
    picker.homeBoundary.answer(scope.serverId, PROFILE_ROWS_ROUTE_V1, { body: ProfileRowsListResponseV1Schema.parse({
        status: 'listed', rows: [{ id: profile.id, revision: 2, content: { t: 'plain', v: record } }],
        nextCursor: null, complete: true, diagnostics: [], referenceGuardRevision: 3, transferControl: { status: 'absent' },
    }) });
    picker.homeBoundary.answer(scope.serverId, PROFILE_REFERENCE_GUARD_ROUTE_V1, { body: { status: 'ready', revision: 3 } });
    picker.homeBoundary.answer(scope.serverId, PROFILE_TRANSFER_ROUTE_V1, { body: { status: 'absent' } });
    const ProfilePickerScreen = (await import('@/app/(app)/new/pick/profile')).default;
    const screen = await renderScreen(React.createElement(ProfilePickerScreen));
    await act(async () => { await refreshAcpCatalog(scope); await refreshProfileCatalog(scope); });
    await waitForHomeGovernance(() => {
        expect(getAcpCatalogSnapshot(scope)).toMatchObject({ scope, stale: false, catalog: { status: 'ready' } });
        expect(getProfileCatalogSnapshot(scope)).toMatchObject({ scope, stale: false, catalog: { status: 'ready' } });
    });
    const { ProfilesList } = await import('@/components/profiles/ProfilesList');
    const props = screen.findByType(ProfilesList).props;
    const admittedProfile = props.customProfiles.find((candidate: { id: string }) => candidate.id === profile.id);
    expect(admittedProfile).toMatchObject({ id: profile.id, profileRecordRevision: 2 });
    return { screen, onPressProfile: props.onPressProfile, profile: admittedProfile };
}

describe('ProfilePickerScreen (native secret requirement)', () => {
    afterEach(async () => {
        standardCleanup();
        (await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool')).serverScopedRpcSocketPool.resetForTests();
        (await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool')).resetScopedMachineTransportCacheForTests();
    });

    it('cancels superseded profile checks and prevents navigation after unmount', async () => {
        resetProfileSecretRequirementHarness();
        routerMock.push.mockClear();
        const { screen, onPressProfile, profile } = await renderProfilePicker();
        const signals: AbortSignal[] = [];
        installSessionActionRpcBoundary((request, context) => {
            if (!request.method.endsWith('preview-env')) return {};
            signals.push(context.signal);
            return new Promise<never>(() => {});
        });
        (await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool')).serverScopedRpcSocketPool.resetForTests();
        const first = onPressProfile(profile);
        await vi.waitFor(() => expect(signals).toHaveLength(1));
        const second = onPressProfile(profile);
        await vi.waitFor(() => expect(signals).toHaveLength(2));
        await vi.waitFor(() => expect(signals[0]?.aborted).toBe(true));
        expect(signals[1]?.aborted).toBe(false);
        await screen.unmount();
        await vi.waitFor(() => expect(signals[1]?.aborted).toBe(true));
        await Promise.all([first, second]);
        expect(routerMock.push).not.toHaveBeenCalled();
    });

    it('navigates to the secret requirement screen when required secrets are missing', async () => {
        routeParamsState.value = {
            newSessionHostDraftId: 'docked-draft',
            selectedId: '',
            dataId: 'draft-1',
            machineId: 'm1',
            agentType: 'customAcp',
            ...createConfiguredBackendRouteParams('review-bot'),
            spawnServerId: 'srv_picker_2',
        };
        settingsState.current = {
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: null,
            backendEnabledByTargetKey: null,
        };

        resetProfileSecretRequirementHarness();
        routerMock.push.mockClear();
        machineContributionRegistryProjectionDescribe.mockReset();
        machineContributionRegistryProjectionDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' });
        navigationMock.getState = () => ({
            index: PICKER_NAV_STATE.index,
            routes: PICKER_NAV_STATE.routes.map((route) => ({ key: route.key })),
        });

        const { onPressProfile, profile } = await renderProfilePicker();

        await act(async () => {
            await onPressProfile(profile);
        });

        expect(profileSecretRequirementModalMock.spies.show).not.toHaveBeenCalled();
        expect(routerMock.push).toHaveBeenCalledTimes(1);
        expect(routerMock.push).toHaveBeenCalledWith({
            pathname: '/new/pick/secret-requirement',
            params: expect.objectContaining({
                newSessionHostDraftId: 'docked-draft',
                ...createConfiguredAgentRouteParams('review-bot'),
                dataId: 'draft-1',
                profileId: 'deepseek',
                machineId: 'm1',
                secretEnvVarName: missingRequiredSecretScenario.secretEnvVarName,
                secretEnvVarNames: missingRequiredSecretScenario.secretEnvVarNames.join(','),
                revertOnCancel: '0',
                spawnServerId: 'srv_picker_2',
            }),
        });
    });

    it('rehydrates configured backend params for secret requirement navigation when the route only carries legacy customAcp', async () => {
        routeParamsState.value = {
            selectedId: '',
            dataId: 'draft-1',
            machineId: 'm1',
            agentType: 'customAcp',
            spawnServerId: 'srv_picker_2',
        };
        settingsState.current = {
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: { kind: 'backend', backendId: 'review-bot', configuredBackendId: 'review-bot', sourceKind: 'configured' },
            backendEnabledByTargetKey: null,
        };

        resetProfileSecretRequirementHarness();
        routerMock.push.mockClear();
        navigationMock.getState = () => ({
            index: PICKER_NAV_STATE.index,
            routes: PICKER_NAV_STATE.routes.map((route) => ({ key: route.key })),
        });

        const { onPressProfile, profile } = await renderProfilePicker();

        await act(async () => {
            await onPressProfile(profile);
        });

        expect(routerMock.push).toHaveBeenCalledWith({
            pathname: '/new/pick/secret-requirement',
            params: expect.objectContaining({
                ...createConfiguredAgentRouteParams('review-bot'),
                dataId: 'draft-1',
                machineId: 'm1',
                spawnServerId: 'srv_picker_2',
            }),
        });
    });

    it('falls back to the preferred built-in target when route params only carry legacy customAcp and no explicit backend target is stored', async () => {
        routeParamsState.value = {
            selectedId: '',
            dataId: 'draft-1',
            machineId: 'm1',
            agentType: 'customAcp',
            spawnServerId: 'srv_picker_2',
        };
        settingsState.current = {
            lastUsedAgent: 'customAcp',
            lastUsedBackendTarget: null,
            backendEnabledByTargetKey: null,
        };
        machineContributionRegistryProjectionDescribe.mockReset();
        machineContributionRegistryProjectionDescribe.mockResolvedValue(createDiscoveredPluginBackendDescribeResult());

        resetProfileSecretRequirementHarness();
        routerMock.push.mockClear();
        navigationMock.getState = () => ({
            index: PICKER_NAV_STATE.index,
            routes: PICKER_NAV_STATE.routes.map((route) => ({ key: route.key })),
        });

        const { onPressProfile, profile } = await renderProfilePicker();

        await waitForHomeGovernance(async () => {
            await flushHookEffects();
            expect(readCachedDaemonMergedProjectionCacheEntry({ machineId: 'm1', serverId: 'srv_picker_2' }))
                .toMatchObject({ kind: 'ready' });
        });

        await act(async () => {
            await onPressProfile(profile);
        });

        expect(machineContributionRegistryProjectionDescribe).toHaveBeenCalledWith('m1', expect.objectContaining({
            serverId: 'srv_picker_2',
            accountId: 'account:srv_picker_2',
        }));
        expect(routerMock.push).toHaveBeenCalledWith({
            pathname: '/new/pick/secret-requirement',
            params: expect.objectContaining({
                ...BUNDLED_AGENT_ROUTE_PARAMS.claude,
                dataId: 'draft-1',
                machineId: 'm1',
                spawnServerId: 'srv_picker_2',
            }),
        });
        const pushedRoute = routerMock.push.mock.calls[0]?.[0];
        if (typeof pushedRoute !== 'object' || pushedRoute === null || !('params' in pushedRoute)) {
            throw new Error('Expected secret requirement navigation to include route params');
        }
        const pushedParams = pushedRoute.params;
        if (typeof pushedParams !== 'object' || pushedParams === null) {
            throw new Error('Expected secret requirement navigation params to be an object');
        }
        expect('agentType' in pushedParams ? pushedParams.agentType : undefined).toBeUndefined();
    });
});
