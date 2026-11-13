import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { RunnerArtifactAvailabilityProjectionV1Schema } from '@happier-dev/protocol/ephemeralRunner/runnerArtifact';
import { EPHEMERAL_RUNNER_ARTIFACTS_PATH_V1 } from '@happier-dev/protocol/ephemeralRunner/routes';
import { machinePoolActionEndpointPathV1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import { MachinePoolListOutputV1Schema, MachinePoolResolveInputV1Schema, MachinePoolResolveResultV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import {
    renderHook,
    renderScreen,
    standardCleanup,
} from '@/dev/testkit';
import {
    createNavigationMock,
    createRouterMock,
    createStackOptionsCapture,
    enableReactActEnvironment,
    installPickerCommonModuleMocks,
} from './testHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';
import type { HomeGovernanceHarness } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const stackOptionsCapture = createStackOptionsCapture();
const pickerRouteBoundary = vi.hoisted(() => ({
    params: { selectedId: 'm1' } as Record<string, string | undefined>,
}));
const HOME_ID = 'srv_machine_presentation';
const HOME_URL = 'https://machine-presentation.example.test';
const ACCOUNT_ID = 'machine-presentation-account';
const POOL_ID = '3a948f0c-bc30-491c-b764-37f0e6744d1f';
const poolList = MachinePoolListOutputV1Schema.parse({ pools: [{
    pool: {
        id: POOL_ID, name: 'Development', description: null,
        revision: 1, createdAt: 1, updatedAt: 1,
        members: [{ machineId: 'machine-from-pool', priorityTier: 0, enabled: true, state: 'connected' }],
    },
    availability: { state: 'known', connectedCount: 1, enabledCount: 1 },
}] });
let homes: HomeGovernanceHarness;
let homeRecordId: string;
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let waitForHomeGovernance: typeof import('@/dev/testkit/harness/homeGovernanceHarness').waitForHomeGovernance;

await installPickerCommonModuleMocks({
    reactNative: async () =>
        (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({
            Platform: {
                OS: 'ios',
            },
        }),
    text: async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock(),
    unistyles: async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
    expoRouter: async () => {
        const module = (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({
            navigation: navigationMock,
            params: () => pickerRouteBoundary.params,
            router: {
                push: routerMock.push,
                back: routerMock.back,
                replace: routerMock.replace,
                setParams: routerMock.setParams,
            },
            stackOptionsCapture,
        }).module;
        return {
            ...module,
            useLocalSearchParams: () => pickerRouteBoundary.params,
        };
    },
});

await initializeRealAppRuntimeForTests();

describe('MachinePickerScreen (iOS presentation)', () => {

    afterEach(async () => {
        standardCleanup();
        await connection?.dispose();
        connection = undefined;
        await homes.reset();
    });

    beforeEach(async () => {
        pickerRouteBoundary.params = { selectedId: 'm1' };
        stackOptionsCapture.reset();
        routerMock.push.mockClear();
        routerMock.back.mockClear();
        routerMock.replace.mockClear();
        routerMock.setParams.mockClear();
        navigationMock.dispatch.mockClear();
        navigationMock.goBack.mockClear();
        navigationMock.setParams.mockClear();
        const homeHarness = await import(
            '@/dev/testkit/harness/homeGovernanceHarness'
        );
        waitForHomeGovernance = homeHarness.waitForHomeGovernance;
        homes = homeHarness.createHomeGovernanceHarness();
        homeHarness.installHomeGovernanceBoundaries(homes);
        await homes.reset();
        homeRecordId = await homes.addHome({ name: 'Home A', serverUrl: HOME_URL,
            serverIdentityId: HOME_ID, accountId: ACCOUNT_ID, machinePoolsEnabled: true });
        const { HomeConnectionDescriptorV1Schema } = await import('@happier-dev/protocol/auth/accountDirectory');
        const { adoptHomeProfile } = await import('@/sync/domains/server/serverProfiles');
        await adoptHomeProfile({
            descriptor: HomeConnectionDescriptorV1Schema.parse({
                v: 1, homeServerIdentityId: HOME_ID, canonicalServerUrl: HOME_URL,
                revision: 1, endpoints: [{ kind: 'https', url: HOME_URL }],
            }),
            source: 'manual', suggestedName: 'Home A',
        });
        const features = createRootLayoutFeaturesResponse({ capabilities: {
            serverIdentity: { serverIdentityId: HOME_ID },
        } });
        for (const feature of ['sessions', 'machines', 'sessions.drafts', 'sessions.ephemeralRunner', 'machines.pools'] as const) {
            if (!tryWriteServerEnabledBitInPlace(features, feature, true)) {
                throw new Error(`Could not seed the Home feature ${feature}`);
            }
        }
        homes.answer(homeRecordId, '/v1/features', { body: features });
        homes.answer(homeRecordId, '/v1/features/authenticated', { body: features });
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId: HOME_ID, snapshot: { status: 'ready', features } });
        homes.answer(homeRecordId, '/v1/machines', { body: [] });
        homes.answer(homeRecordId, machinePoolActionEndpointPathV1('machines.pools.list'), { body: poolList });
        homes.answer(homeRecordId, EPHEMERAL_RUNNER_ARTIFACTS_PATH_V1, {
            body: RunnerArtifactAvailabilityProjectionV1Schema.parse({ status: 'available', artifacts: [{
                identity: { product: 'happier-runner', version: '1.0.0-test', target: 'linux-x64', sha256: 'a'.repeat(64) },
                channel: 'test', url: 'https://example.test/runner',
                checksumsUrl: 'https://example.test/checksums', checksumsSignatureUrl: 'https://example.test/checksums.sig',
                sizeBytes: 123, entries: [{ path: 'happier-runner', kind: 'file', sizeBytes: 100, mode: 0o755 }],
            }] }),
        });
        const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        connection = await restoreServerAccountForTest({ serverUrl: HOME_URL,
            serverIdentityId: HOME_ID, accountId: ACCOUNT_ID, request: homes.request });
    });

    it('provides an explicit header Cancel on iOS', async () => {
        const MachinePickerScreen = (await import('@/app/(app)/new/pick/machine')).default;
        await renderScreen(React.createElement(MachinePickerScreen));

        const options = stackOptionsCapture.getResolved();
        expect(typeof options?.headerLeft).toBe('function');

        const backButton = options?.headerLeft?.();
        expect(typeof backButton?.props?.onPress).toBe('function');
        backButton?.props?.onPress?.();
        expect(navigationMock.goBack).toHaveBeenCalledTimes(1);
    });

    it('keeps the navigation options stable across an unrelated rerender', async () => {
        const { useMachinePickerScreenModel } = await import(
            '@/components/sessions/new/hooks/machines/useMachinePickerScreenModel'
        );
        const hook = await renderHook(() => useMachinePickerScreenModel());
        const firstOptions = hook.getCurrent().screenOptions;

        await hook.rerender();

        expect(hook.getCurrent().screenOptions).toBe(firstOptions);
    });

    it('renders and returns the restored Temporary computer target through the typed one-shot carrier', async () => {
        const { clearTempData, peekTempData, storeTempData } = await import('@/utils/sessions/tempDataStore');
        clearTempData();
        const dataId = storeTempData({
            prompt: 'Keep this draft',
            executionTarget: {
                kind: 'temporary_computer',
                serverId: HOME_ID,
                artifactTarget: 'linux-x64',
                workspace: { kind: 'choose_on_endpoint' },
            },
        });
        pickerRouteBoundary.params = { dataId, spawnServerId: HOME_ID };

        const { useMachinePickerScreenModel } = await import(
            '@/components/sessions/new/hooks/machines/useMachinePickerScreenModel'
        );
        const hook = await renderHook(() => useMachinePickerScreenModel());
        await waitForHomeGovernance(() => {
            expect(hook.getCurrent().content.props.temporaryComputers).toEqual([
                expect.objectContaining({ artifactTarget: 'linux-x64' }),
            ]);
            expect(hook.getCurrent().content.props.temporaryComputers[0]?.disabled).not.toBe(true);
        });
        const content = hook.getCurrent().content;
        const temporaryComputers = content.props.temporaryComputers;

        expect(temporaryComputers).toEqual([
            expect.objectContaining({
                serverId: HOME_ID,
                artifactTarget: 'linux-x64',
                selected: true,
                workspace: { kind: 'choose_on_endpoint' },
            }),
        ]);

        // The selection list confirms a row with the workspace and expiry it
        // exposes; the restored row carries both back unchanged.
        const restoredRow = temporaryComputers[0];
        const restoredWorkspace = restoredRow?.workspace;
        if (!restoredRow || !restoredWorkspace) {
            throw new Error('Expected the restored Temporary computer row to expose its workspace');
        }
        await act(async () => {
            restoredRow.onSelect(restoredWorkspace, restoredRow.packageExpiresAt);
        });
        expect(routerMock.replace).toHaveBeenCalledWith({
            pathname: '/new',
            params: expect.objectContaining({
                dataId: expect.any(String),
                spawnServerId: HOME_ID,
            }),
        });
        const returnedRoute = routerMock.replace.mock.calls.at(-1)?.[0];
        if (typeof returnedRoute !== 'object' || returnedRoute === null || !('params' in returnedRoute)) {
            throw new Error('Expected the restored Temporary computer selection to replace the route with params');
        }
        const returnedParams = returnedRoute.params;
        if (typeof returnedParams !== 'object' || returnedParams === null || !('dataId' in returnedParams)) {
            throw new Error('Expected the restored Temporary computer selection to preserve its draft id');
        }
        const returnedDataId = returnedParams.dataId;
        if (typeof returnedDataId !== 'string') {
            throw new Error('Expected the restored Temporary computer selection to preserve a string draft id');
        }
        expect(peekTempData(returnedDataId)).toEqual({
            prompt: 'Keep this draft',
            machineId: undefined,
            managedMachineSelection: null,
            temporaryComputerActivationRef: null,
            executionTarget: {
                kind: 'temporary_computer',
                serverId: HOME_ID,
                artifactTarget: 'linux-x64',
                workspace: { kind: 'choose_on_endpoint' },
            },
        });

        await hook.unmount();
        clearTempData();
    });

    it('keeps an explicit Machine pin selected over restored Temporary data', async () => {
        const { clearTempData, storeTempData } = await import('@/utils/sessions/tempDataStore');
        clearTempData();
        const dataId = storeTempData({
            executionTarget: {
                kind: 'temporary_computer',
                serverId: HOME_ID,
                artifactTarget: 'linux-x64',
                workspace: { kind: 'choose_on_endpoint' },
            },
        });
        pickerRouteBoundary.params = { dataId, selectedId: 'machine-explicit', spawnServerId: HOME_ID };

        const { useMachinePickerScreenModel } = await import(
            '@/components/sessions/new/hooks/machines/useMachinePickerScreenModel'
        );
        const hook = await renderHook(() => useMachinePickerScreenModel());

        await waitForHomeGovernance(() => expect(hook.getCurrent().content.props.temporaryComputers).toEqual([
            expect.objectContaining({ artifactTarget: 'linux-x64', selected: false }),
        ]));

        await hook.unmount();
        clearTempData();
    });

    it('does not reuse the draft selection identity when reopened over a committed Pool target', async () => {
        pickerRouteBoundary.params = {
            draftId: 'stable-draft',
            selectedId: 'machine-from-pool',
            machinePoolId: POOL_ID,
            spawnServerId: HOME_ID,
        };
        const resolvePath = machinePoolActionEndpointPathV1('machines.pools.resolve');
        homes.answer(homeRecordId, resolvePath, { body: MachinePoolResolveResultV1Schema.parse({
            kind: 'resolved', poolId: POOL_ID, machineId: 'machine-new-choice', priorityTier: 0,
        }) });

        const { useMachinePickerScreenModel } = await import(
            '@/components/sessions/new/hooks/machines/useMachinePickerScreenModel'
        );
        const hook = await renderHook(() => useMachinePickerScreenModel());

        await waitForHomeGovernance(() => expect(hook.getCurrent().content.props.poolGroups[0]).toMatchObject({
            serverId: HOME_ID, accountId: ACCOUNT_ID, projectionReady: true,
        }));
        const group = hook.getCurrent().content.props.poolGroups[0];
        await act(async () => {
            await hook.getCurrent().content.props.onSelectPool({ serverId: group.serverId,
                accountId: group.accountId, pool: group.pools[0] });
        });
        const resolveRequest = homes.requestsFor(resolvePath).at(-1);
        const input = MachinePoolResolveInputV1Schema.parse(resolveRequest?.input);
        expect(input.poolId).toBe(POOL_ID);
        expect(input.requestKey).toBeTruthy();
        expect(input.requestKey).not.toBe('stable-draft');
        expect(routerMock.replace).toHaveBeenCalledWith({ pathname: '/new', params: expect.objectContaining({
            machineId: 'machine-new-choice', machinePoolId: POOL_ID, spawnServerId: HOME_ID,
        }) });
        expect(resolveRequest?.serverId).toBe(homeRecordId);

        await hook.unmount();
    });

    it('recovers a failed Home Machine census without refreshing its retained Pool projection', async () => {
        const { sync } = await import('@/sync/sync');
        const { storage } = await import('@/sync/domains/state/storage');
        pickerRouteBoundary.params = { spawnServerId: HOME_ID };
        const machineRows = [createPlainMachineRowFixture({ id: 'machine-recovered', accountId: ACCOUNT_ID })];
        homes.answer(homeRecordId, '/v1/machines', { body: machineRows });
        await sync.refreshMachinesThrottled({ staleMs: 0, force: true });
        homes.answer(homeRecordId, '/v1/machines', { status: 503, body: { error: 'unavailable' } });
        await sync.refreshMachinesThrottled({ staleMs: 0, force: true }).catch(() => undefined);

        const MachinePickerScreen = (await import('@/app/(app)/new/pick/machine')).default;
        const screen = await renderScreen(React.createElement(MachinePickerScreen));
        await waitForHomeGovernance(() => {
            expect(storage.getState().machineListStatusByServerId[HOME_ID]).toBe('error');
            expect(storage.getState().machinePoolListByServerId[HOME_ID]).toEqual(poolList.pools);
            expect(storage.getState().machinePoolListStatusByServerId[HOME_ID]).toBe('idle');
            expect(screen.findByTestId(`new-session-machine-pool-refresh:${HOME_ID}`)).toBeTruthy();
        });
        // The real Home answers differently after recovery; keep its hydrated
        // Pool list as the continuity baseline instead of observing internal calls.
        const retainedPools = storage.getState().machinePoolListByServerId[HOME_ID];
        const listPath = machinePoolActionEndpointPathV1('machines.pools.list');
        const poolReadsBeforeRetry = homes.requestsFor(listPath).length;
        homes.answer(homeRecordId, '/v1/machines', { body: machineRows });

        await screen.pressByTestIdAsync(`new-session-machine-pool-refresh:${HOME_ID}`);
        await waitForHomeGovernance(() => {
            expect(storage.getState().machineListStatusByServerId[HOME_ID]).toBe('idle');
            expect(storage.getState().machineListByServerId[HOME_ID]).toEqual([
                expect.objectContaining({ id: 'machine-recovered', availability: { kind: 'available' } }),
            ]);
        });
        expect(storage.getState().machinePoolListByServerId[HOME_ID]).toBe(retainedPools);
        expect(homes.requestsFor(listPath)).toHaveLength(poolReadsBeforeRetry);
    });
});
