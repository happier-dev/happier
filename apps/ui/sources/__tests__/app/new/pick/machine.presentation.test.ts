import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { createUseSettingMock, createUseSettingMutableMockFromReader } from '@/dev/testkit/mocks/storage';

enableReactActEnvironment();

const routerMock = createRouterMock();
const navigationMock = createNavigationMock();
const stackOptionsCapture = createStackOptionsCapture();
const pickerRouteBoundary = vi.hoisted(() => ({
    params: { selectedId: 'm1' } as Record<string, string | undefined>,
}));
const temporaryComputerBoundary = vi.hoisted(() => ({
    cancelPendingSelection: vi.fn(),
    selectPool: vi.fn(),
    selectionParams: null as null | Readonly<{
        requestKey: string;
        requestKeyAlreadyConsumed?: boolean;
    }>,
}));
const machinePickerDataBoundary = vi.hoisted(() => ({
    machineGroups: [] as Array<{
        serverId: string;
        serverName: string;
        loading: boolean;
        signedOut: boolean;
        error?: boolean;
        machines: never[];
    }>,
    poolGroups: [] as Array<{
        serverId: string;
        accountId: string | null;
        serverName: string;
        status: 'idle' | 'loading' | 'error';
        projectionReady: boolean;
        pools: Array<{
            pool: {
                id: string;
                name: string;
                description: null;
                revision: number;
                createdAt: number;
                updatedAt: number;
                members: never[];
            };
            availability: { state: 'unknown' };
        }>;
    }>,
}));
const machineRefreshBoundary = vi.hoisted(() => ({
    refreshMachinesThrottled: vi.fn(async () => undefined),
    invalidateMachinePoolProjection: vi.fn(async () => undefined),
}));

installPickerCommonModuleMocks({
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
    storage: async (importOriginal) =>
        (await import('@/dev/testkit/mocks/storage')).createStorageModuleMock({
            importOriginal,
            overrides: {
                useAllMachines: () => [],
                useAllSessionListRenderables: () => [],
                useSetting: createUseSettingMock({ fallback: () => false }),
                useSettingMutable: createUseSettingMutableMockFromReader(() => [[], vi.fn()]),
            },
        }),
});

vi.mock('@/components/sessions/new/components/MachineSelector', () => ({
    MachineSelector: () => null,
}));

vi.mock('@/utils/sessions/recentMachines', () => ({
    getRecentMachinesFromSessions: () => [],
}));

vi.mock('@/sync/sync', () => ({
    sync: { refreshMachinesThrottled: machineRefreshBoundary.refreshMachinesThrottled },
}));

vi.mock('@/sync/engine/machines/machinePoolProjection', () => ({
    invalidateMachinePoolProjection: machineRefreshBoundary.invalidateMachinePoolProjection,
}));

vi.mock('@/hooks/server/useMachineCapabilitiesCache', () => ({
    prefetchMachineCapabilities: vi.fn(),
}));

vi.mock('@/hooks/machine/useMachineEnvPresence', () => ({
    invalidateMachineEnvPresence: vi.fn(),
}));

vi.mock('@/components/sessions/new/hooks/serverTarget/useNewSessionServerTargetState', () => ({
    useNewSessionServerTargetState: () => ({
        allowedTargetServerIds: ['server-a'],
        resolvedSettingsTarget: { allowedServerIds: ['server-a'] },
        targetServerId: 'server-a',
        targetServerProfile: {
            id: 'server-a',
            name: 'Home A',
            serverUrl: 'https://home-a.example.test',
            homeConnectionDescriptor: { homeServerIdentityId: 'home-a' },
        },
    }),
}));

vi.mock('@/components/sessions/new/hooks/serverTarget/useNewSessionActiveServerSource', () => ({
    useNewSessionActiveServerSource: () => ({
        activeServerId: 'server-a',
        serverProfiles: [],
        serverProfilesSignature: 'server-a',
    }),
}));

vi.mock('@/components/sessions/new/hooks/machines/useServerScopedMachineOptions', () => ({
    useServerScopedMachineOptions: () => machinePickerDataBoundary.machineGroups,
}));

vi.mock('@/components/sessions/new/hooks/machines/useMachinePoolGroups', () => ({
    useMachinePoolGroups: () => machinePickerDataBoundary.poolGroups,
}));

vi.mock('@/components/sessions/new/hooks/machines/useMachinePoolSelection', () => ({
    useMachinePoolSelection: (params: Readonly<{
        requestKey: string;
        requestKeyAlreadyConsumed?: boolean;
    }>) => {
        temporaryComputerBoundary.selectionParams = params;
        return ({
            status: { kind: 'idle' },
            selectPool: temporaryComputerBoundary.selectPool,
            cancelPendingSelection: temporaryComputerBoundary.cancelPendingSelection,
        });
    },
}));

vi.mock('@/components/sessions/new/hooks/useTemporaryComputerAvailability', () => ({
    resolveTemporaryComputerDestinationProjectionState: () => 'available',
    shouldOfferTemporaryComputerDestination: () => true,
    useTemporaryComputerAvailability: () => ({
        status: 'available',
        artifacts: [{
            identity: {
                product: 'happier-runner',
                version: '1.0.0-test',
                target: 'linux-x64',
                sha256: 'a'.repeat(64),
            },
            channel: 'test',
            url: 'https://example.test/runner',
            checksumsUrl: 'https://example.test/checksums',
            checksumsSignatureUrl: 'https://example.test/checksums.sig',
            sizeBytes: 123,
            entries: [{ path: 'happier-runner', kind: 'file', sizeBytes: 100, mode: 0o755 }],
        }],
        client: {},
        retry: vi.fn(),
    }),
}));

describe('MachinePickerScreen (iOS presentation)', () => {
    afterEach(() => {
        standardCleanup();
    });

    beforeEach(() => {
        pickerRouteBoundary.params = { selectedId: 'm1' };
        stackOptionsCapture.reset();
        routerMock.push.mockClear();
        routerMock.back.mockClear();
        routerMock.replace.mockClear();
        routerMock.setParams.mockClear();
        navigationMock.dispatch.mockClear();
        navigationMock.goBack.mockClear();
        navigationMock.setParams.mockClear();
        temporaryComputerBoundary.cancelPendingSelection.mockClear();
        temporaryComputerBoundary.selectPool.mockClear();
        temporaryComputerBoundary.selectionParams = null;
        machinePickerDataBoundary.machineGroups = [];
        machinePickerDataBoundary.poolGroups = [];
        machineRefreshBoundary.refreshMachinesThrottled.mockClear();
        machineRefreshBoundary.invalidateMachinePoolProjection.mockClear();
    });

    it('presents as containedModal on iOS and provides an explicit header back button', async () => {
        const MachinePickerScreen = (await import('@/app/(app)/new/pick/machine')).default;
        await renderScreen(React.createElement(MachinePickerScreen));

        const options = stackOptionsCapture.getResolved();
        expect(options?.presentation).toBe('containedModal');
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
                serverId: 'server-a',
                artifactTarget: 'linux-x64',
                workspace: { kind: 'choose_on_endpoint' },
            },
        });
        pickerRouteBoundary.params = { dataId, spawnServerId: 'server-a' };

        const { useMachinePickerScreenModel } = await import(
            '@/components/sessions/new/hooks/machines/useMachinePickerScreenModel'
        );
        const hook = await renderHook(() => useMachinePickerScreenModel());
        const content = hook.getCurrent().content;
        const temporaryComputers = content.props.temporaryComputers;

        expect(temporaryComputers).toEqual([
            expect.objectContaining({
                serverId: 'server-a',
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
                spawnServerId: 'server-a',
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
            executionTarget: {
                kind: 'temporary_computer',
                serverId: 'server-a',
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
                serverId: 'server-a',
                artifactTarget: 'linux-x64',
                workspace: { kind: 'choose_on_endpoint' },
            },
        });
        pickerRouteBoundary.params = { dataId, selectedId: 'machine-explicit', spawnServerId: 'server-a' };

        const { useMachinePickerScreenModel } = await import(
            '@/components/sessions/new/hooks/machines/useMachinePickerScreenModel'
        );
        const hook = await renderHook(() => useMachinePickerScreenModel());

        expect(hook.getCurrent().content.props.temporaryComputers[0]?.selected).toBe(false);

        await hook.unmount();
        clearTempData();
    });

    it('does not reuse the draft selection identity when reopened over a committed Pool target', async () => {
        pickerRouteBoundary.params = {
            draftId: 'stable-draft',
            selectedId: 'machine-from-pool',
            machinePoolId: 'pool-a',
            spawnServerId: 'server-a',
        };

        const { useMachinePickerScreenModel } = await import(
            '@/components/sessions/new/hooks/machines/useMachinePickerScreenModel'
        );
        const hook = await renderHook(() => useMachinePickerScreenModel());

        expect(temporaryComputerBoundary.selectionParams).toMatchObject({
            requestKey: 'stable-draft',
            requestKeyAlreadyConsumed: true,
        });

        await hook.unmount();
    });

    it('routes a failed Home retry through the existing Machine refresh owner only', async () => {
        machinePickerDataBoundary.machineGroups = [{
            serverId: 'server-a',
            serverName: 'Home A',
            loading: false,
            signedOut: false,
            error: true,
            machines: [],
        }];
        machinePickerDataBoundary.poolGroups = [{
            serverId: 'server-a',
            accountId: 'account-a',
            serverName: 'Home A',
            status: 'idle',
            projectionReady: true,
            pools: [{
                pool: {
                    id: '3a948f0c-bc30-491c-b764-37f0e6744d1f',
                    name: 'Development',
                    description: null,
                    revision: 1,
                    createdAt: 1,
                    updatedAt: 1,
                    members: [],
                },
                availability: { state: 'unknown' },
            }],
        }];

        const { useMachinePickerScreenModel } = await import(
            '@/components/sessions/new/hooks/machines/useMachinePickerScreenModel'
        );
        const hook = await renderHook(() => useMachinePickerScreenModel());
        const screen = await renderScreen(hook.getCurrent().content);

        // Ignore the route's normal initial Machine refresh. The recovery action below is the
        // behavior under test and must not be confused with Pool-projection recovery.
        machineRefreshBoundary.refreshMachinesThrottled.mockClear();
        machineRefreshBoundary.invalidateMachinePoolProjection.mockClear();

        await screen.pressByTestIdAsync('new-session-machine-pool-refresh:server-a');
        await vi.waitFor(() => {
            expect(machineRefreshBoundary.refreshMachinesThrottled).toHaveBeenCalledOnce();
        });
        expect(machineRefreshBoundary.invalidateMachinePoolProjection).not.toHaveBeenCalled();

        await hook.unmount();
    });
});
