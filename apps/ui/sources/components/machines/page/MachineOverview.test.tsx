import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import { createMachineFixture, renderHook, renderScreen, standardCleanup } from '@/dev/testkit';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import type { MachinePageState } from './machinePageContext';

installDisconnectedServerSocketBoundary();
const boundary = vi.hoisted(() => ({ rpc: vi.fn<() => Promise<unknown>>(() => new Promise(() => {})) }));
// Machine RPC is the external network boundary; the scope, readiness and page logic stay real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(boundary.rpc);
});
const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { ModalProvider } = await import('@/modal');
const { storage } = await import('@/sync/domains/state/storageStore');
const { useServerCredentialAccountScopeBinding } = await import('@/sync/domains/scope/useServerCredentialAccountScopes');
const { MachinePageStateContext } = await import('./machinePageContext');
const { MachineOverview } = await import('./MachineOverview');
const { MachineVitalsBarAccessory } = await import('../vitals/MachineVitalsRangeBar');
const { machineResourceStore } = await import('@/sync/domains/machines/resources/machineResourceStore');
const { useManagedEnrolledMachine } = await import('@/components/settings/machines/managed/ManagedMachineSections');
const { recordMachineRequestFailed, clearMachineRequestReachabilityForTest } = await import('@/sync/domains/machines/reachability/machineReachability');
const { withdrawMachinePresenceForScope, captureMachinePresenceObservation } = await import('@/sync/domains/machines/reachability/machineReachability');
const { useMachineDaemonReadTarget, useMachineDaemonReadTargets } = await import('@/sync/domains/machines/useMachineDaemonReadTarget');
const { useMachineWidgetMachine } = await import('../widgets/machineWidgetKit');
const { MachineDaemonSection } = await import('../daemon/MachineDaemonSection');
const { t } = await import('@/text');

let accountConnection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
afterEach(async () => { standardCleanup(); machineResourceStore.reset(); boundary.rpc.mockReset(); boundary.rpc.mockImplementation(() => new Promise(() => {})); clearMachineRequestReachabilityForTest(); await accountConnection?.dispose(); accountConnection = null; });

it('withdraws resource admission without presenting an unobserved Machine as offline, and restores only its exact Account', async () => {
    const serverId = await home.addHome({ name: 'Presence Home', serverUrl: 'https://resource-presence.test', accountId: 'owner' });
    const machine = createMachineFixture({ id: 'presence-machine', active: true, activeAt: Date.now(), storageMode: 'plain' });
    storage.setState({ machines: {}, machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    const hook = await renderHook(() => ({
        read: useMachineDaemonReadTarget({ serverId, machineId: machine.id }),
        fleet: useMachineDaemonReadTargets({ serverId, machineIds: [machine.id] }),
        widget: useMachineWidgetMachine({ serverId, machineId: machine.id }),
    }));
    await vi.waitFor(() => expect(hook.getCurrent().read.enabled).toBe(true));
    const scope = { serverId, accountId: 'owner' };
    await act(async () => { withdrawMachinePresenceForScope(scope); });
    expect(hook.getCurrent().read).toMatchObject({ enabled: false, offline: false });
    expect(hook.getCurrent().fleet[0]).toMatchObject({ enabled: false, offline: false });
    expect(hook.getCurrent().widget.online).toBeNull();
    const daemon = await renderScreen(<MachineDaemonSection serverId={serverId} machine={machine} />);
    expect(daemon.findByProps({ title: t('machine.status') }).props.detail).toBe(t('common.unknown'));
    expect(daemon.findByTestId('machine-detail-stop-daemon-button')?.props.disabled).toBe(true);
    await act(async () => { captureMachinePresenceObservation({ ...scope, accountId: 'other' })([machine.id]); });
    expect(hook.getCurrent().widget.online).toBeNull();
    await act(async () => { captureMachinePresenceObservation(scope)([machine.id]); });
    expect(hook.getCurrent().read).toMatchObject({ enabled: true, offline: false });
    expect(hook.getCurrent().widget.online).toBe(true);
    await act(async () => { recordMachineRequestFailed({ ...scope, machineId: machine.id }); });
    expect(hook.getCurrent().read).toMatchObject({ enabled: false, offline: true });
    expect(hook.getCurrent().widget.online).toBe(false);
});

it('shares the Account-qualified Overview sample and retries the same retained read from the tab bar', async () => {
    const serverId = await home.addHome({ name: 'Freshness Home', serverUrl: 'https://overview-freshness.test', accountId: 'owner' });
    // The real resource Action needs the Home's authenticated runtime authority as well as stored credentials.
    home.answer(serverId, '/v1/machines', { body: [], respondAfter: new Promise<void>(() => {}) });
    accountConnection = await restoreServerAccountForTest({ serverUrl: 'https://overview-freshness.test', accountId: 'owner', request: home.request });
    const machine = createMachineFixture({ id: 'freshness-machine', active: true, activeAt: Date.now(), storageMode: 'plain' });
    storage.setState({ machines: {}, machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    const authority = await renderHook(() => ({ binding: useServerCredentialAccountScopeBinding(serverId).binding,
        managedEnrolled: useManagedEnrolledMachine({ enrolledMachineId: machine.id, serverId }) }));
    await vi.waitFor(() => expect(authority.getCurrent().binding?.isCurrent()).toBe(true));
    const key = { serverId, expectedAccountId: 'owner', machineId: machine.id, view: 'overview' as const };
    let sampledAt = Date.now() - 60_000;
    let snapshot = { state: 'reporting', sample: { v: 1, sampledAt, intervalMs: 15_000,
        cpu: { reported: true, busyPct: 12 },
        memory: { reported: true, totalBytes: 128e9, availableBytes: 71e9, usedBytes: 57e9, pressure: { level: 'calm', source: 'psi' } },
        disk: { reported: true, volumes: [] }, network: { reported: true, rxBps: 12, txBps: 3 } },
        series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] }, attention: { level: 'calm', reasons: [] } };
    boundary.rpc.mockResolvedValue(snapshot);
    await machineResourceStore.read(key);
    expect(machineResourceStore.getState(key).status).toBe('ready');
    const state = { target: { machineId: machine.id, requestedServerId: serverId, serverId, activeServerId: serverId, machine,
        machineName: 'Freshness Machine', machineSentenceName: 'Freshness Machine', isServerSwitching: false, isHydratingMachine: false, switchReady: true },
        managedEnrolled: authority.getCurrent().managedEnrolled, refreshKey: 0, reload: async () => {} } satisfies MachinePageState;
    const screen = await renderScreen(<MachinePageStateContext.Provider value={state}>
        <MachineVitalsBarAccessory serverId={serverId} machineId={machine.id} online />
    </MachinePageStateContext.Provider>);
    expect(screen.findByTestId('machine-vitals-retry')).not.toBeNull();
    expect(screen.findByTestId('machine-vitals-range:1h')).not.toBeNull();
    const pending = createDeferred<unknown>();
    boundary.rpc.mockImplementation(() => pending.promise);
    let refreshing!: Promise<void>;
    await act(async () => { refreshing = machineResourceStore.retry(key); });
    expect(screen.findByTestId('machine-vitals-checking')).not.toBeNull();
    expect(screen.findByTestId('machine-vitals-retry')).toBeNull();
    sampledAt = Date.now();
    snapshot = { ...snapshot, sample: { ...snapshot.sample, sampledAt } };
    await act(async () => { pending.resolve(snapshot); await refreshing; });
    expect(screen.findByTestId('machine-vitals-live')).not.toBeNull();
    boundary.rpc.mockRejectedValue(new Error('transport unavailable'));
    await act(async () => { await machineResourceStore.retry(key); });
    expect(machineResourceStore.getState(key).snapshot?.sample?.sampledAt).toBe(sampledAt);
    expect(screen.findByTestId('machine-vitals-retry')).not.toBeNull();
    boundary.rpc.mockResolvedValue(snapshot);
    await screen.pressByTestIdAsync('machine-vitals-retry');
    await vi.waitFor(() => expect(machineResourceStore.getState(key).status).toBe('ready'));
    expect(screen.findByTestId('machine-vitals-live')).not.toBeNull();
});

it('uses the page Home credential scope rather than treating a reachable Machine as unavailable', async () => {
    const serverId = await home.addHome({ name: 'Overview Home', serverUrl: 'https://overview-scope.test', accountId: 'owner' });
    const machine = createMachineFixture({ id: 'overview-machine', active: true, activeAt: Date.now(), storageMode: 'plain' });
    storage.setState({ machines: {}, machineListByServerId: { [serverId]: [machine] }, machineListStatusByServerId: { [serverId]: 'idle' } });
    const authority = await renderHook(() => ({ binding: useServerCredentialAccountScopeBinding(serverId).binding,
        managedEnrolled: useManagedEnrolledMachine({ enrolledMachineId: machine.id, serverId }) }));
    await vi.waitFor(() => expect(authority.getCurrent().binding?.isCurrent()).toBe(true));
    const state = {
        target: { machineId: machine.id, requestedServerId: serverId, serverId, activeServerId: serverId, machine,
            machineName: 'Overview Machine', machineSentenceName: 'Overview Machine', isServerSwitching: false, isHydratingMachine: false, switchReady: true },
        managedEnrolled: authority.getCurrent().managedEnrolled, refreshKey: 0, reload: async () => {},
    } satisfies MachinePageState;
    const frame = (state: MachinePageState, online = true) => (
        <AuthProvider initialCredentials={{ token: `e30.${Buffer.from(JSON.stringify({ sub: 'owner' })).toString('base64url')}.signature` }}>
            <ModalProvider><MachinePageStateContext.Provider value={state}>
                <MachineOverview serverId={serverId} machineId={machine.id} machineName="Overview Machine" online={online}
                    params={{ id: 'overview' }} setParams={() => {}} />
            </MachinePageStateContext.Provider></ModalProvider>
        </AuthProvider>
    );
    const screen = await renderScreen(frame(state));
    expect(screen.findByTestId('machine-detail-unavailable')).toBeNull();
    await act(async () => { recordMachineRequestFailed({ ...authority.getCurrent().binding!.scope, machineId: machine.id }); });
    await screen.update(frame(state, false));
    // Offline is said once, by the quiet banner above what the machine last reported (lab `rv` OS 3), never by the
    // checks for a machine that is online but cannot start sessions.
    expect(screen.findByTestId('machine-detail-unavailable')).toBeNull();
    expect(screen.findByTestId('machine-vitals-offline')).not.toBeNull();
});
