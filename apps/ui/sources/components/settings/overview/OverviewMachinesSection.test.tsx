import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
import { renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createProviderSettingsAccountHarness } from '@/dev/testkit/harness/providerSettingsHarness';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';

vi.mock('react-native', async () => {
    const { createReactNativeAppStateEmitter, createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({ AppState: createReactNativeAppStateEmitter('active').appState });
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: (key: string) => key }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);

const account = createProviderSettingsAccountHarness();
const { storage } = await import('@/sync/domains/state/storageStore');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { OverviewMachinesSection } = await import('./OverviewMachinesSection');
const { useMachineFleetModel, MachineFleetWidget } = await import('@/components/machines/widgets/MachineFleetWidget');
const { machineResourceStore } = await import('@/sync/domains/machines/resources/machineResourceStore');
const { recordMachineRequestFailed, clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
let releaseInventoryRead: (() => void) | null = null;

beforeEach(async () => {
    const { serverId } = await account.restore();
    await account.publishMachines(serverId, []);
    const pending = createDeferred<void>();
    releaseInventoryRead = pending.resolve;
    // Hold unsolicited Sync census reads; the cases below exercise real store transitions.
    account.home.answer(serverId, '/v1/machines', { respondAfter: pending.promise, body: [] });
});
afterEach(async () => {
    releaseInventoryRead?.();
    releaseInventoryRead = null;
    standardCleanup();
    clearMachineRequestReachabilityForTest();
    await account.reset();
});

describe('Settings › Overview Machines', () => {
    it('keeps a Home-A fleet widget and its demand on A while Home B is focused', async () => {
        const homeA = getActiveServerSnapshot().serverId;
        const machines = (prefix: string) => ['one', 'two'].map(name => createMachineFixture({
            id: `${prefix}-${name}`, active: true, activeAt: Date.now(),
            metadata: { ...createMachineFixture().metadata!, host: `${prefix}-${name}` },
        }));
        await account.publishMachines(homeA, machines('a'));
        const homeB = await account.addHome({ name: 'Fleet B', serverUrl: 'https://fleet-b.test', accountId: 'account-b', active: true });
        await account.publishMachines(homeB, machines('b'));
        expect(getActiveServerSnapshot().serverId).toBe(homeB);
        // The old hook accepts no arguments and ignores this owning Home at runtime; the RED stays type-safe.
        const scopedFleet: (serverId?: string) => ReturnType<typeof useMachineFleetModel> = useMachineFleetModel;
        const model = await renderHook(() => scopedFleet(homeA));
        let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
        machineResourceStore.reset();
        try {
            await vi.waitFor(() => expect(model.getCurrent().fleet.map(entry => [entry.serverId, entry.machine.id]))
                .toEqual([[homeA, 'a-one'], [homeA, 'a-two']]));
            const censusRequests = () => account.home.requests.filter(request => new URL(request.path, request.serverUrl).pathname === '/v1/machines');
            const beforeRefresh = censusRequests().length;
            await act(async () => { model.getCurrent().refresh(); });
            await vi.waitFor(() => expect(censusRequests().slice(beforeRefresh)
                .map(request => request.serverId)).toEqual([homeA]));
            screen = await renderScreen(<MachineFleetWidget serverId={homeA} input={{ metrics: ['cpu'] }} testID="fleet-a" />);
            const readA = { serverId: homeA, expectedAccountId: 'account-a', machineId: 'a-one', view: 'summary' as const };
            const readB = { serverId: homeB, expectedAccountId: 'account-b', machineId: 'b-one', view: 'summary' as const };
            await vi.waitFor(() => expect(machineResourceStore.isRefreshing(readA)
                || machineResourceStore.getState(readA).status !== 'loading').toBe(true));
            expect(machineResourceStore.isRefreshing(readB)).toBe(false);
            expect(machineResourceStore.getState(readB).status).toBe('loading');
            expect(screen.findByTestId('fleet-a.machine.b-one')).toBeNull();
            expect(getActiveServerSnapshot().serverId).toBe(homeB);
        } finally {
            await screen?.unmount();
            await model.unmount();
            machineResourceStore.reset();
        }
    });
    it('lists only the machines that need the person as rows, and counts the rest on the All machines row', async () => {
        const home = getActiveServerSnapshot().serverId;
        const memory = { key: 'memory', level: 'needs_you', since: Date.now() - 60_000, metric: 'memory',
            nextStep: 'review_processes', kind: 'memory_pressure', pressure: 'critical', swapping: true };
        const resources = (needsYou: boolean) => ({ v: 1, vitals: { state: 'reporting' }, host: { logicalCores: 8, memoryTotalBytes: 32e9, bootedAt: 1 },
            attention: needsYou ? { level: 'needs_you', reasons: [memory] } : { level: 'calm', reasons: [] } });
        const fleet = [
            createMachineFixture({ id: 'edge', active: true, activeAt: Date.now(), metadata: { ...createMachineFixture().metadata!, host: 'edge' }, daemonState: { status: 'running', resources: resources(true) } }),
            createMachineFixture({ id: 'nl2', active: true, activeAt: Date.now(), metadata: { ...createMachineFixture().metadata!, host: 'nl2' }, daemonState: { status: 'running', resources: resources(false) } }),
            createMachineFixture({ id: 'studio', active: false, activeAt: Date.now() - 86_400_000 * 3, metadata: { ...createMachineFixture().metadata!, host: 'studio' } }),
        ];
        storage.getState().applyMachines(fleet, true, { sourceServerId: home });
        const screen = await renderScreen(<OverviewMachinesSection testID="overview" />);
        expect(screen.findByTestId('overview.machine.edge')).toBeTruthy();
        expect(screen.findByTestId('overview.machine.nl2')).toBeNull();
        expect(screen.findByTestId('overview.machine.studio')).toBeNull();
        expect(screen.findByTestId('overview.all')).toBeTruthy();
        // The Overview summary owner's own sentence, never "N machines are calm".
        expect(screen.getTextContent()).toContain('machineAttention.fleet.otherOnlineCalm');
        expect(screen.getTextContent()).not.toContain('machines.widgets.body.fleet.othersCalm');
    });

    it('shows that it is reading, never "no machines", until the list has arrived', async () => {
        const home = getActiveServerSnapshot().serverId;
        storage.setState({ machines: {}, machineListByServerId: {}, machineListStatusByServerId: { [home]: 'loading' } });
        const screen = await renderScreen(<OverviewMachinesSection testID="overview" />);
        expect(screen.getTextContent()).not.toContain('machines.widgets.body.fleet.noMachines');
        expect(screen.findByTestId('overview.loading')).not.toBeNull();
        await act(async () => {
            storage.getState().applyMachines([], true, { sourceServerId: home });
            storage.getState().markMachineListSettled(home);
        });
        expect(screen.findByTestId('overview.loading')).toBeNull();
        expect(screen.getTextContent()).toContain('machines.widgets.body.fleet.noMachines');
    });

    it('keeps reachability and attention on the active Account across request failure and Account switching', async () => {
        const home = getActiveServerSnapshot().serverId;
        const machine = createMachineFixture({ id: 'edge', active: true, activeAt: Date.now(), daemonState: { status: 'running', resources: {
            v: 1, vitals: { state: 'reporting' }, host: { logicalCores: 8, memoryTotalBytes: 32e9, bootedAt: 1 },
            attention: { level: 'needs_you', reasons: [{ key: 'memory', level: 'needs_you', since: 1, metric: 'memory',
                nextStep: 'review_processes', kind: 'memory_pressure', pressure: 'critical', swapping: true }] },
        } } });
        const seed = () => storage.getState().applyMachines([machine], true, { sourceServerId: home });
        seed();
        const model = await renderHook(() => useMachineFleetModel());
        const screen = await renderScreen(<OverviewMachinesSection testID="overview" />);
        expect(model.getCurrent().fleet[0]?.online).toBe(true);
        expect(screen.findByTestId('overview.machine.edge')).not.toBeNull();
        await act(async () => { recordMachineRequestFailed({ serverId: home, accountId: 'account-a', machineId: 'edge' }); });
        expect(model.getCurrent().fleet[0]?.online).toBe(false);
        expect(screen.findByTestId('overview.machine.edge')).toBeNull();
        await act(async () => {
            await account.restore({ accountId: 'account-b' });
            seed();
        });
        expect(model.getCurrent().fleet[0]?.online).toBe(true);
        expect(screen.findByTestId('overview.machine.edge')).not.toBeNull();
    });

    it('projects loading, cold failure, settled empty and retained-data failure from the inventory owner', async () => {
        const home = getActiveServerSnapshot().serverId;
        storage.setState({ machines: {}, machineListByServerId: {}, machineListStatusByServerId: { [home]: 'loading' } });
        const model = await renderHook(() => useMachineFleetModel());
        const screen = await renderScreen(<OverviewMachinesSection testID="overview" />);
        await act(async () => {
            storage.setState({ machines: {}, machineListByServerId: {}, machineListStatusByServerId: { [home]: 'loading' } });
        });
        expect(model.getCurrent()).toMatchObject({ status: 'loading', settled: false, fleet: [] });
        await act(async () => { storage.getState().markMachineListUnavailable(home); });
        expect(model.getCurrent()).toMatchObject({ status: 'error', settled: false, fleet: [] });
        expect(screen.findByTestId('overview.error')).not.toBeNull();
        expect(screen.findByTestId('overview.loading')).toBeNull();
        expect(screen.getTextContent()).not.toContain('machines.widgets.body.fleet.noMachines');
        await act(async () => {
            storage.getState().applyMachines([], true, { sourceServerId: home });
            storage.getState().markMachineListSettled(home);
        });
        expect(model.getCurrent()).toMatchObject({ status: 'idle', settled: true, fleet: [] });
        expect(screen.findByTestId('overview.error')).toBeNull();
        expect(screen.getTextContent()).toContain('machines.widgets.body.fleet.noMachines');
        const machine = createMachineFixture({ id: 'retained', active: true, activeAt: Date.now() });
        await act(async () => {
            storage.getState().applyMachines([machine], true, { sourceServerId: home });
            storage.getState().markMachineListUnavailable(home);
        });
        expect(model.getCurrent()).toMatchObject({ status: 'error', settled: false, fleet: [{ machine: { id: 'retained' } }] });
        expect(screen.findByTestId('overview.freshness')).not.toBeNull();
        expect(screen.getTextContent()).not.toContain('machines.widgets.body.fleet.allCalm');
        releaseInventoryRead?.();
        await screen.pressByTestIdAsync('overview.retry');
        await vi.waitFor(() => expect(model.getCurrent()).toMatchObject({ status: 'idle', settled: true, fleet: [] }));
        expect(screen.findByTestId('overview.freshness')).toBeNull();
    });
});
