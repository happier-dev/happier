import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const home = createHomeGovernanceHarness();
const clipboard = vi.hoisted(() => ({ write: vi.fn(async (_text: string) => true) }));
const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
let restoreClock: (() => void) | undefined;
installHomeGovernanceBoundaries(home);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// Device clipboard is the system boundary. The Action admission and diagnostic exporter stay real.
vi.mock('expo-clipboard', () => ({ setStringAsync: clipboard.write }));
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () =>
    (await import('@/dev/testkit/mocks/serverScopedRpc')).createServerScopedMachineRpcBoundaryMock(rpc.machine));

// Resolve the full source graph during collection, after system boundaries are installed.
// Cold graph preparation must not consume an individual diagnostic operation's test budget.
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { DiagnosisView } = await import('./DiagnosisView');
const { SystemStatusView } = await import('../systemStatus/SystemStatusView');

// The package cleanup retires runtimeFetch after each case; each new fixture
// reclaims its own HTTP boundary before adding the next Home.
beforeEach(async () => { await home.reset(); });

afterEach(async () => {
    (await import('@/sync/domains/machines/reachability/machineReachability')).clearMachineRequestReachabilityForTest();
    await standardCleanup(); await home.reset(); clipboard.write.mockClear(); rpc.machine.mockReset();
    restoreClock?.(); restoreClock = undefined;
});

const probePath = '/v1/diagnostics/bug-report-snapshot?lines=50';

it.each(['diagnostics.daemons.check', 'diagnostics.diagnosis.run'] as const)('explicitly checks a daemon even after a request marked it unreachable through $0', async actionId => {
    const serverId = await home.addHome({ name: 'Recovery', serverUrl: 'https://daemon-check-recovery.test', accountId: 'alice' });
    const { getStorage } = await import('@/sync/domains/state/storage');
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    const { recordMachineRequestFailed } = await import('@/sync/domains/machines/reachability/machineReachability');
    getStorage().getState().applyMachines([
        createMachineFixture({ id: 'recovering-daemon', activeAt: Date.now() }),
        createMachineFixture({ id: 'locked-daemon', activeAt: Date.now(), availability: { kind: 'locked', reason: 'content_unreadable' } }),
        createMachineFixture({ id: 'revoked-daemon', activeAt: Date.now(), revokedAt: Date.now() }),
        createMachineFixture({ id: 'replaced-daemon', activeAt: Date.now(), replacedByMachineId: 'recovering-daemon' }),
    ], true, { sourceServerId: serverId });
    recordMachineRequestFailed({ serverId, accountId: 'alice', machineId: 'recovering-daemon', observedAtMs: Date.now() });
    rpc.machine.mockImplementation(async () => ({ doctorSnapshot: {
        capturedAt: new Date().toISOString(), machineId: 'recovering-daemon', accountId: 'alice',
        server: { activeServerId: serverId, serverUrl: 'https://daemon-check-recovery.test', publicServerUrl: 'https://daemon-check-recovery.test', webappUrl: 'https://app.test' },
        settings: { activeServerId: serverId, servers: [], knownAccountIds: ['alice'] },
    } }));
    await renderScreen(actionId === 'diagnostics.daemons.check' ? <SystemStatusView /> : <DiagnosisView />);
    let result: Awaited<ReturnType<ReturnType<typeof createDefaultActionExecutor>['execute']>> | undefined;
    await act(async () => { result = await createDefaultActionExecutor().execute(actionId, {}, { surface: 'ui', serverId }); });
    expect(result).toMatchObject({ ok: true, result: { status: 'completed' } });
    expect(new Set(rpc.machine.mock.calls.map(([request]) => request.machineId))).toEqual(new Set(['recovering-daemon']));
    if (actionId === 'diagnostics.daemons.check') expect(result).toMatchObject({ result: { machines: [{ machineId: 'recovering-daemon', status: 'ready' }] } });
});

it('runs diagnosis through the admitted mounted owner and returns findings without raw diagnostics', async () => {
    const serverId = await home.addHome({ name: 'Diagnosis', serverUrl: 'https://diagnosis-action.test', accountId: 'alice' });
    home.answer(serverId, probePath, { status: 401, body: { privateLogs: 'secret' } });
    const screen = await renderScreen(<DiagnosisView />);
    const executor = createDefaultActionExecutor();
    let result: Awaited<ReturnType<typeof executor.execute>> | undefined;
    await act(async () => { result = await executor.execute('diagnostics.diagnosis.run', {}, { surface: 'ui', serverId }); });
    expect(result).toMatchObject({ ok: true, result: { status: 'completed', report: { findings: expect.arrayContaining([
        expect.objectContaining({ code: 'machine.none_online' }), expect.objectContaining({ code: 'auth.server_401' }),
    ]) } } });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(home.requestsFor(probePath)).toHaveLength(1);
    expect(screen.findByTestId('diagnosis-accessibility-status')?.props.children).toBeTruthy();
});

it('does not disclose a diagnosis after its mounted Account retires', async () => {
    const serverId = await home.addHome({ name: 'Diagnosis', serverUrl: 'https://diagnosis-retirement.test', accountId: 'alice' });
    let release!: () => void;
    home.answer(serverId, probePath, { status: 401, respondAfter: new Promise<void>(resolve => { release = resolve; }) });
    const screen = await renderScreen(<DiagnosisView />);
    // Fail immediately for a missing Action; a held transport is only meaningful once it exists.
    const { getActionSpec } = await import('@happier-dev/protocol');
    expect(getActionSpec('diagnostics.diagnosis.run').id).toBe('diagnostics.diagnosis.run');
    const executor = createDefaultActionExecutor();
    let pending!: ReturnType<typeof executor.execute>;
    await act(async () => {
        pending = executor.execute('diagnostics.diagnosis.run', {}, { surface: 'ui', serverId });
        await waitForHomeGovernance(() => expect(home.requestsFor(probePath)).toHaveLength(1));
    });
    await act(async () => { await home.switchAccount(serverId, 'bob'); release(); await pending; });
    expect(await pending).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
    expect(screen.findByTestId('diagnosis-accessibility-status')).toBeNull();
});

it('checks the incumbent System status sample through the doctor owner without exposing cached snapshots', async () => {
    const serverId = await home.addHome({ name: 'System status', serverUrl: 'https://daemon-check-action.test', accountId: 'alice' });
    const { getStorage } = await import('@/sync/domains/state/storage');
    const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
    getStorage().getState().applyMachines(Array.from({ length: 4 }, (_, index) =>
        createMachineFixture({ id: `diagnostic-machine-${index}`, activeAt: Date.now() })), true, { sourceServerId: serverId });
    rpc.machine.mockImplementation(async ({ machineId }: { machineId: string }) => ({
        doctorSnapshot: { capturedAt: new Date().toISOString(), machineId, accountId: 'alice',
            server: { activeServerId: serverId, serverUrl: 'https://daemon-check-action.test',
                publicServerUrl: 'https://daemon-check-action.test', webappUrl: 'https://app.test' },
            settings: { activeServerId: serverId, servers: [], knownAccountIds: ['alice'] } },
        privateLogs: 'native-secret',
    }));
    await renderScreen(<SystemStatusView />);
    const executor = createDefaultActionExecutor();
    let result: Awaited<ReturnType<typeof executor.execute>> | undefined;
    await act(async () => { result = await executor.execute('diagnostics.daemons.check', {}, { surface: 'ui', serverId }); });
    expect(result).toEqual({ ok: true, result: { status: 'completed', machines: [
        { machineId: 'diagnostic-machine-0', status: 'ready' },
        { machineId: 'diagnostic-machine-1', status: 'ready' },
        { machineId: 'diagnostic-machine-2', status: 'ready' },
    ] } });
    expect(JSON.stringify(result)).not.toContain('native-secret');
    expect(new Set(rpc.machine.mock.calls.map(([request]) => request.machineId))).toEqual(new Set([
        'diagnostic-machine-0', 'diagnostic-machine-1', 'diagnostic-machine-2',
    ]));
    expect(home.requestsFor(probePath)).toHaveLength(0);
});

it('reports a missing client surface without navigating or probing another Home', async () => {
    const serverId = await home.addHome({ name: 'Diagnosis', serverUrl: 'https://diagnosis-unmounted.test', accountId: 'alice' });
    const executor = createDefaultActionExecutor();
    await expect(executor.execute('diagnostics.diagnosis.run', {}, { surface: 'ui', serverId })).resolves.toEqual({ ok: true, result: { status: 'unavailable' } });
    await expect(executor.execute('diagnostics.daemons.check', {}, { surface: 'ui', serverId })).resolves.toEqual({ ok: true, result: { status: 'unavailable' } });
    await expect(executor.execute('diagnostics.status.get', {}, { surface: 'ui', serverId })).resolves.toEqual({ ok: true, result: { status: 'unavailable' } });
    expect(home.requestsFor(probePath)).toHaveLength(0);
});

it('copies the same System status export returned by its admitted read owner', async () => {
    // A constant clock isolates serializer equality from two independently fresh capture times.
    const clock = vi.spyOn(Date.prototype, 'toISOString').mockReturnValue('2026-10-12T10:00:00Z');
    restoreClock = () => clock.mockRestore();
    const serverId = await home.addHome({ name: 'System status', serverUrl: 'https://status-export-action.test', accountId: 'alice' });
    const screen = await renderScreen(<SystemStatusView />);
    const executor = createDefaultActionExecutor();
    let exported: Awaited<ReturnType<typeof executor.execute>> | undefined;
    await act(async () => { exported = await executor.execute('diagnostics.status.get', {}, { surface: 'ui', serverId }); });
    expect(exported).toMatchObject({ ok: true, result: { status: 'available', json: expect.any(String) } });
    await act(async () => {
        await screen.pressByTestIdAsync('system-status-copy-json');
        await waitForHomeGovernance(() => expect(clipboard.write).toHaveBeenCalled());
    });
    expect(exported).toEqual({ ok: true, result: { status: 'available', json: clipboard.write.mock.calls[0]?.[0] } });
});
