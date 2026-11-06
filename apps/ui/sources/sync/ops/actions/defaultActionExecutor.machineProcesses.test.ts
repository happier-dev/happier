import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { resetMmkvStoresForTests } from '@/dev/reactNativeMmkvStub';
import { buildGuardStopWarningPushDataV1 } from '@happier-dev/protocol/activity/webhookPayload';
import { PUSH_NOTIFICATION_ACTION_IDS } from '@happier-dev/protocol/push/pushNotificationActions';
import * as React from 'react';
import { createDeferred, renderScreen, flushHookEffects } from '@/dev/testkit';

const rpc = vi.hoisted(() => ({ machine: vi.fn() }));
const nativeNotifications = vi.hoisted(() => ({ listener: null as ((response: unknown) => void) | null,
    received: new Set<() => void>(),
    onDismiss: undefined as (() => void) | undefined,
    presented: [] as import('expo-notifications').Notification[], dismissed: [] as string[] }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock({ Platform: { OS: 'ios' } }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
// Only the OS notification delivery is replaced; parsing, routing and Action admission stay real.
vi.mock('@/utils/platform/loadExpoNotifications', () => ({ loadExpoNotifications: async () => ({
    DEFAULT_ACTION_IDENTIFIER: 'default', getLastNotificationResponseAsync: async () => null,
    getPresentedNotificationsAsync: async () => nativeNotifications.presented,
    dismissNotificationAsync: async (id: string) => { nativeNotifications.dismissed.push(id);
        nativeNotifications.presented = nativeNotifications.presented.filter(notice => notice.request.identifier !== id);
        nativeNotifications.onDismiss?.(); },
    addNotificationReceivedListener: (listener: () => void) => {
        nativeNotifications.received.add(listener);
        return { remove: () => { nativeNotifications.received.delete(listener); } };
    },
    addNotificationResponseReceivedListener: (listener: (response: unknown) => void) => {
        nativeNotifications.listener = listener;
        return { remove: () => { if (nativeNotifications.listener === listener) nativeNotifications.listener = null; } };
    },
}) }));
// These transport cases start after the present user accepts the shared confirmation.
vi.mock('@/modal', async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
// Only daemon network transport is replaced; Account capture, schemas and approval remain real.
vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', async () => {
    const { createServerScopedMachineRpcBoundaryMock } = await import('@/dev/testkit/mocks/serverScopedRpc');
    return createServerScopedMachineRpcBoundaryMock(rpc.machine);
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes); installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { parseNotificationTap } = await import('@/activity/notifications/notificationRouting');
const { createMachineGuardViewFixture } = await import('@/sync/domains/machines/guard/guardViewFixtures');
const { executeMachineProcessesActionV1, executeMachineProcessesLeftBehindCleanUpV1, executeMachineProcessesStartAgainV1 } = await import('@/sync/domains/machines/processes/machineProcessesActions');
const { createFrontDoorRuntimeActionExecutor } = await import('./frontDoorRuntimeActionExecutor');
const { keepMachineGuardWorkRunningViaAction, undoMachineGuardActivityViaAction } = await import('@/sync/domains/machines/guard/machineGuardRpc');
const { fetchMachineVitalsViaMachineRpc, fetchMachineVitalsHistoryViaMachineRpc, watchMachineVitalsViaMachineRpc } = await import('@/sync/domains/machines/resources/machineRpc');
const { fetchMachineProcessesViaMachineRpc, watchMachineProcessesViaMachineRpc } = await import('@/sync/domains/machines/processes/machineProcessesRpc');
const { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes');
const { executeGuardStopWarningAction, reconcileGuardStopWarningNotifications } = await import('@/activity/notifications/guardStopWarningLifecycle');
const { machineGuardStore } = await import('@/sync/domains/machines/guard/machineGuardStore');
const { storage } = await import('@/sync/domains/state/storage');
const initialStorage = storage.getState();
let serverId: string;
let savedHomeId: string;
beforeEach(async () => {
    await homes.reset();
    // The warmed reader case publishes and persists a real Settings baseline.
    // Retire that fixture state together, so the next Home reads its own policy.
    resetMmkvStoresForTests();
    storage.setState(initialStorage, true);
    await loadSyncSingletonForTests(); rpc.machine.mockReset();
    machineGuardStore.reset(); nativeNotifications.presented = []; nativeNotifications.dismissed = []; nativeNotifications.onDismiss = undefined;
    savedHomeId = await homes.addHome({ name: 'Process Home', serverUrl: 'https://process-actions.test', serverIdentityId: 'srv_process_actions', accountId: 'owner', currentAccount: true });
    // Harness mutations use their saved registration handle; Actions retain the advertised Home scope.
    serverId = 'srv_process_actions';
});
afterEach(async () => {
    vi.useRealTimers();
    await homes.reset();
    storage.setState(initialStorage, true);
    resetMmkvStoresForTests();
    machineGuardStore.reset();
});
const kill = { machineId: 'm', tree: true, targets: [{ ref: 'r', expect: { level: 'proven' as const, owner: { kind: 'session' as const, sessionId: 's' } } }] };
describe('machine process Actions through the captured UI Home', () => {
    it('offers the Machine marker inventory to agents through the same scoped Action used by the UI', async () => {
        rpc.machine.mockResolvedValue({ runs: [] });
        const executor = createDefaultActionExecutor();
        for (const surface of ['ui', 'agent'] as const) {
            expect(await executor.execute('machines.runs.list', { serverId, machineId: 'marker-machine' }, {
                surface, serverId, expectedAccountId: 'owner',
            })).toEqual({ ok: true, result: { runs: [] } });
        }
        const { machineExecutionRunsList } = await import('@/sync/ops/machineExecutionRuns');
        expect(await machineExecutionRunsList('marker-machine', { serverId, accountId: 'owner' }))
            .toEqual({ ok: true, runs: [] });
        expect(rpc.machine.mock.calls.map(([request]) => ({ method: request.method,
            serverId: request.serverId, accountId: request.accountId, machineId: request.machineId }))).toEqual([
            { method: RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST, serverId, accountId: 'owner', machineId: 'marker-machine' },
            { method: RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST, serverId, accountId: 'owner', machineId: 'marker-machine' },
            { method: RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST, serverId, accountId: 'owner', machineId: 'marker-machine' },
        ]);
        expect(homes.artifacts(savedHomeId).list()).toHaveLength(0);
    });

    it('settles the Machine marker inventory when its UI request owner cancels', async () => {
        const entered = createDeferred<void>();
        rpc.machine.mockImplementation(({ signal }: { signal?: AbortSignal }) => new Promise((_resolve, reject) => {
            entered.resolve();
            const aborted = () => reject(Object.assign(new Error('aborted'), { code: 'MACHINE_RPC_ABORTED' }));
            if (signal?.aborted) aborted();
            else signal?.addEventListener('abort', aborted, { once: true });
        }));
        const { machineExecutionRunsList } = await import('@/sync/ops/machineExecutionRuns');
        const controller = new AbortController();
        const result = machineExecutionRunsList('marker-machine', { serverId, accountId: 'owner', signal: controller.signal });
        await entered.promise;
        controller.abort();
        expect(await result).toMatchObject({ ok: false });
    });

    it('retains the Machine marker inventory Home when another Account is focused', async () => {
        await homes.addHome({ name: 'Unrelated Home', serverUrl: 'https://unrelated-markers.test',
            accountId: 'unrelated-owner', currentAccount: true });
        rpc.machine.mockResolvedValue({ runs: [] });
        const { machineExecutionRunsList } = await import('@/sync/ops/machineExecutionRuns');
        expect(await machineExecutionRunsList('marker-machine', { serverId, accountId: 'owner' }))
            .toEqual({ ok: true, runs: [] });
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId, accountId: 'owner', machineId: 'marker-machine' }));
    });

    it('retains a newly delivered warning when an already-demanded Guard view still has stale absence', async () => {
        const watching = createDeferred<void>();
        const freshRead = createDeferred<void>();
        const withdrawn = createDeferred<void>();
        nativeNotifications.onDismiss = () => { withdrawn.resolve(); };
        const parked = createDeferred<unknown>();
        let read = false;
        let current = createMachineGuardViewFixture({ idleTerminals: [] });
        rpc.machine.mockImplementation(async ({ method }: { method: string }) => {
            if (method === RPC_METHODS.MACHINES_GUARD_GET) { if (read) freshRead.resolve(); read = true; return current; }
            if (method === RPC_METHODS.DAEMON_GUARD_WATCH) { watching.resolve(); return parked.promise; }
            throw new Error(`Unexpected Guard operation ${method}`);
        });
        const { resolveNotificationSavedHome } = await import('@/activity/notifications/resolveNotificationSavedHome');
        const home = resolveNotificationSavedHome({ serverId: undefined, serverUrl: 'https://process-actions.test' });
        expect(home).not.toBeNull();
        const { resolveMachineDaemonReadServerId } = await import('@/sync/domains/machines/useMachineDaemonReadTarget');
        const key = { serverId: resolveMachineDaemonReadServerId(home!.id), expectedAccountId: 'owner', machineId: 'm' };
        const release = machineGuardStore.demandView(key);
        await watching.promise;
        expect(machineGuardStore.getView(key)).toMatchObject({ status: 'ready', pending: false, view: { idleTerminals: [] } });
        const { ActivityLocalNotificationRuntime } = await import('@/activity/notifications/runtime/ActivityLocalNotificationRuntime');
        const screen = await renderScreen(React.createElement(ActivityLocalNotificationRuntime));
        try {
            await flushHookEffects({ cycles: 20 });
            expect(nativeNotifications.received.size).toBeGreaterThan(0);
            current = createMachineGuardViewFixture({ idleTerminals: [{ terminalId: 'terminal', terminalKey: 'key', label: 'Shell', idleMs: 0,
                eligible: true, commandRunning: true, status: 'stops_at', stopAt: 300_000, reasons: [] }] });
            const data = { ...buildGuardStopWarningPushDataV1({ topic: 'guard_stop_warning', machineId: 'm', terminalId: 'terminal',
                terminalKey: 'key', rule: 'idle_terminals', stopAt: 300_000 }), serverUrl: 'https://process-actions.test' };
            nativeNotifications.presented = [{ date: 1, request: { identifier: 'new-terminal-os-id', trigger: null,
                content: { title: null, subtitle: null, body: null, data, sound: null, categoryIdentifier: null } } }];
            for (const listener of nativeNotifications.received) listener();
            // Await the actual boundary outcome, not a guessed number of async Account-admission turns.
            await Promise.race([freshRead.promise, withdrawn.promise]);
            await flushHookEffects({ cycles: 20 });
            expect(nativeNotifications.dismissed).toEqual([]);
            await vi.waitFor(() => {
                expect(machineGuardStore.getView(key)).toMatchObject({ pending: false, view: { idleTerminals: current.idleTerminals } });
            });
        } finally { await screen.unmount(); release(); }
    });
    it('withdraws a delivered terminal warning when another device clears it while the app stays active', async () => {
        const data = { ...buildGuardStopWarningPushDataV1({ topic: 'guard_stop_warning', machineId: 'm', terminalId: 'terminal',
            terminalKey: 'key', rule: 'idle_terminals', stopAt: 300_000 }), serverUrl: 'https://process-actions.test' };
        nativeNotifications.presented = [{ date: 1, request: { identifier: 'terminal-os-id', trigger: null,
            content: { title: null, subtitle: null, body: null, data, sound: null, categoryIdentifier: null } } }];
        const read = createDeferred<void>();
        const change = createDeferred<unknown>();
        const withdrawn = createDeferred<void>();
        nativeNotifications.onDismiss = () => { withdrawn.resolve(); };
        const parked = createDeferred<unknown>();
        let watched = false;
        const current = createMachineGuardViewFixture({ idleTerminals: [{ terminalId: 'terminal', terminalKey: 'key', label: 'Shell', idleMs: 0,
            eligible: true, commandRunning: true, status: 'stops_at', stopAt: 300_000, reasons: [] }] });
        rpc.machine.mockImplementation(async ({ method }: { method: string }) => {
            if (method === RPC_METHODS.MACHINES_GUARD_GET) { read.resolve(); return current; }
            if (method === RPC_METHODS.DAEMON_GUARD_WATCH) {
                if (watched) return parked.promise;
                watched = true;
                return change.promise;
            }
            throw new Error(`Unexpected Guard operation ${method}`);
        });
        const { ActivityLocalNotificationRuntime } = await import('@/activity/notifications/runtime/ActivityLocalNotificationRuntime');
        const screen = await renderScreen(React.createElement(ActivityLocalNotificationRuntime));
        try {
            await read.promise; await flushHookEffects();
            expect(rpc.machine.mock.calls.map(call => call[0].method)).toContain(RPC_METHODS.DAEMON_GUARD_WATCH);
            current.idleTerminals = [];
            change.resolve({ changed: true, since: 2, view: current });
            await withdrawn.promise;
            expect(nativeNotifications.dismissed).toEqual(['terminal-os-id']);
        } finally { await screen.unmount(); }
    });
    it('dispatches a real Guard push through the notification parser and canonical Action executor', async () => {
        let stopAt: number | undefined = 300_000;
        const dispatched = createDeferred<void>();
        rpc.machine.mockImplementation(async ({ method }: { method: string }) => {
            if (method === RPC_METHODS.MACHINES_GUARD_GET) return createMachineGuardViewFixture({ idle: stopAt === undefined ? [] : [{ sessionRef: 's', title: 'Session', agentId: 'codex',
                status: 'stops_at', stopAt, idleMs: 0 }] });
            dispatched.resolve(); return { status: 'kept' };
        });
        const data = { ...buildGuardStopWarningPushDataV1({ topic: 'guard_stop_warning', machineId: 'm',
            sessionId: 's', rule: 'idle_sessions', stopAt: 300_000 }), serverUrl: 'https://process-actions.test' };
        const response = {
            actionIdentifier: PUSH_NOTIFICATION_ACTION_IDS.guardKeepRunningV1,
            notification: { request: { identifier: data.notificationId, content: { data } } },
        };
        const parsed = parseNotificationTap({ defaultActionIdentifier: 'default', response });
        expect(parsed?.command.kind).toBe('executeAction');
        if (parsed?.command.kind !== 'executeAction') return;
        const command = parsed.command;
        const { useNotificationResponseRouting } = await import('@/activity/notifications/runtime/useNotificationResponseRouting');
        function Probe() { useNotificationResponseRouting({ enabled: true, refreshAuth: async () => {} }); return null; }
        const screen = await renderScreen(React.createElement(Probe));
        await flushHookEffects();
        expect(nativeNotifications.listener).not.toBeNull();
        nativeNotifications.listener?.(response);
        await dispatched.promise;
        await flushHookEffects();
        await screen.unmount();
        expect(rpc.machine).toHaveBeenCalledWith(expect.objectContaining({ serverId,
            accountId: 'owner', machineId: 'm', payload: expect.objectContaining({ sessionId: 's' }) }));
        rpc.machine.mockClear(); stopAt = 400_000;
        expect(await executeGuardStopWarningAction(command)).toBeNull();
        expect(rpc.machine.mock.calls.map(call => call[0].method)).toEqual([RPC_METHODS.MACHINES_GUARD_GET]);
        const dismissNotificationAsync = vi.fn(async () => {});
        const notifications = { dismissNotificationAsync, getPresentedNotificationsAsync: async () => [{ date: 1, request: {
            identifier: 'os-delivered-id', trigger: null,
            content: { title: null, subtitle: null, body: null, data, sound: null, categoryIdentifier: null },
        } }] };
        // Replacing a deadline withdraws only the superseded delivered occurrence.
        await reconcileGuardStopWarningNotifications({ notifications });
        expect(dismissNotificationAsync.mock.calls).toEqual([['os-delivered-id']]);
        dismissNotificationAsync.mockClear(); stopAt = 300_000;
        await reconcileGuardStopWarningNotifications({ notifications });
        expect(dismissNotificationAsync).not.toHaveBeenCalled();
        stopAt = undefined;
        await reconcileGuardStopWarningNotifications({ notifications });
        expect(dismissNotificationAsync.mock.calls).toEqual([['os-delivered-id']]);
    });
    it.each(['machines.processes.stop', 'machines.processes.kill', 'machines.processes.leftBehind.cleanUp'] as const)
    ('preserves the delayed %s receipt after cancellation and Account retirement', async actionId => {
        const controller = new AbortController();
        const input = actionId === 'machines.processes.leftBehind.cleanUp' ? { machineId: 'm', refs: ['r'] } :
            actionId === 'machines.processes.kill' ? kill : { machineId: 'm', targets: kill.targets };
        const receipt = actionId === 'machines.processes.leftBehind.cleanUp'
            ? { ended: [{ ref: 'r', freedBytes: 40 }], skipped: [] }
            : { status: 'ended', outcomes: [{ ref: 'r', outcome: 'ended', freedBytes: 40 }] };
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        rpc.machine.mockImplementationOnce((request: { operationTimeoutMs?: null }) => {
            entered();
            return new Promise((resolve, reject) => {
                const deadline = request.operationTimeoutMs === null ? null : setTimeout(() => reject(new Error('MACHINE_RPC_TIMEOUT')), DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS);
                setTimeout(() => { if (deadline) clearTimeout(deadline); resolve(receipt); }, DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1000);
            });
        });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const pending = executeMachineProcessesActionV1(actionId, input, { serverId, expectedAccountId: 'owner', signal: controller.signal });
        await started;
        controller.abort();
        await homes.switchAccount(savedHomeId, 'replacement');
        await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1000);
        expect(await pending).toEqual({ ok: true, result: receipt });
    });
    it.each(['keep', 'undo'] as const)('preserves delayed Guard %s through the real Action and UI result adapter', async kind => {
        const controller = new AbortController();
        const receipt = kind === 'keep' ? { status: 'kept' } : { outcomes: [{ entryId: 'e', status: 'restored', path: '/restored' }] };
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        rpc.machine.mockImplementationOnce((request: { operationTimeoutMs?: null }) => {
            entered();
            return new Promise((resolve, reject) => {
                const deadline = request.operationTimeoutMs === null ? null : setTimeout(() => reject(new Error('MACHINE_RPC_TIMEOUT')), DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS);
                setTimeout(() => { if (deadline) clearTimeout(deadline); resolve(receipt); }, DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1000);
            });
        });
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const key = { serverId, expectedAccountId: 'owner', machineId: 'm', signal: controller.signal };
        const pending = kind === 'keep' ? keepMachineGuardWorkRunningViaAction({ ...key, sessionId: 's' })
            : undoMachineGuardActivityViaAction({ ...key, entryId: 'e' });
        await started;
        controller.abort();
        await homes.switchAccount(savedHomeId, 'replacement');
        await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS + 1000);
        expect(await pending).toEqual({ ok: true, value: receipt });
    });
    it('withholds retired Process reads and refuses effects before dispatch when already cancelled', async () => {
        const controller = new AbortController();
        rpc.machine.mockImplementationOnce(async () => { controller.abort(); return { row: null }; });
        const executor = createDefaultActionExecutor();
        await expect(executor.execute('machines.processes.get', { machineId: 'm', ref: 'r' }, { surface: 'ui', serverId, signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
        rpc.machine.mockClear();
        await expect(executor.execute('machines.processes.kill', kill, { surface: 'ui', serverId, signal: controller.signal }))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(rpc.machine).not.toHaveBeenCalled();
    });
    it('enforces disabled resource read Actions on domain Retry while keeping parked watch demand on its transport', async () => {
        homes.answer(savedHomeId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, actions: { 'machines.vitals.get': { enabled: false },
                'machines.vitals.history.get': { enabled: false }, 'machines.processes.list': { enabled: false } } },
        } }, version: 1 } });
        const vitals = { machineId: 'm', serverId, view: 'overview' as const };
        const processes = { machineId: 'm', serverId, accountId: 'owner', scope: 'all' as const, view: 'tree' as const };
        rpc.machine.mockResolvedValue({ state: 'unavailable', series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] }, sample: null });
        expect(await fetchMachineVitalsViaMachineRpc(vitals)).toEqual({ ok: false, reason: 'request_failed', errorCode: 'action_disabled' });
        expect(await fetchMachineVitalsHistoryViaMachineRpc({ ...vitals, range: '7d' })).toEqual({ ok: false, reason: 'request_failed', errorCode: 'action_disabled' });
        expect(await fetchMachineProcessesViaMachineRpc(processes)).toEqual({ ok: false, reason: 'request_failed' });
        expect(rpc.machine).not.toHaveBeenCalled();
        rpc.machine.mockResolvedValue({ changed: false });
        expect(await watchMachineVitalsViaMachineRpc(vitals)).toEqual({ ok: true, value: { changed: false } });
        expect(await watchMachineProcessesViaMachineRpc(processes)).toEqual({ ok: true, value: { changed: false } });
        expect(rpc.machine.mock.calls.map(call => call[0].method)).toEqual([RPC_METHODS.DAEMON_VITALS_WATCH, RPC_METHODS.DAEMON_PROCESSES_WATCH]);
    });
    it('returns the same Vitals, history and Processes facts through warmed Actions without adding inventory requests', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { normalizeActionsSettingsV1 } = await import('@happier-dev/protocol/actions/actionSettings');
        const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
        // The running UI has already activated this Home's Account settings.
        const scope = { serverId, accountId: 'owner' };
        storage.setState({ settingsScope: scope, profileScope: scope });
        storage.getState().applySettingsForScope(scope, { ...storage.getState().settings,
            actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {} }) }, 1);
        const snapshot = { state: 'unavailable', sample: null, series5m: { cpu: [], memory: [], networkRx: [], networkTx: [] } };
        const history = { range: '1h', bucketMs: 60_000, points: [], today: { rxBytes: 0, txBytes: 0 } };
        const processes = { v: 1, machineId: 'm', capturedAtMs: 1000, state: 'live', platform: 'linux', evidenceModel: 'fenced', owners: [], leftBehind: [],
            totals: { happier: { processCount: 0, memoryBytes: 0 }, leftBehind: { processCount: 0, memoryBytes: 0 } } };
        const answerByMethod = new Map<string, unknown>([[RPC_METHODS.MACHINES_VITALS_GET, snapshot],
            [RPC_METHODS.MACHINES_VITALS_HISTORY_GET, history], [RPC_METHODS.MACHINES_PROCESSES_LIST, processes]]);
        rpc.machine.mockImplementation(async (request: { method: string }) => answerByMethod.get(request.method));
        const readers = [
            { method: RPC_METHODS.MACHINES_VITALS_GET, payload: { machineId: 'm', view: 'summary' },
                read: () => fetchMachineVitalsViaMachineRpc({ serverId, machineId: 'm', view: 'summary' }), answer: snapshot },
            { method: RPC_METHODS.MACHINES_VITALS_HISTORY_GET, payload: { machineId: 'm', range: '1h' },
                read: () => fetchMachineVitalsHistoryViaMachineRpc({ serverId, machineId: 'm', range: '1h' }), answer: history },
            { method: RPC_METHODS.MACHINES_PROCESSES_LIST, payload: { machineId: 'm', scope: 'happier', view: 'tree' },
                read: () => fetchMachineProcessesViaMachineRpc({ serverId, accountId: 'owner', machineId: 'm', scope: 'happier', view: 'tree' }), answer: processes },
        ];
        for (const row of readers) for (let i = 0; i < 5; i++) await row.read();
        const inventoryRequests = () => homes.requests.filter(request => request.path === '/v1/machines');
        const inventoryRequestsBefore = inventoryRequests().length;
        const measurements = [];
        for (const row of readers) {
            const directAt = performance.now();
            for (let i = 0; i < 40; i++) expect(await machineRpcWithServerScope({ serverId, machineId: 'm', method: row.method, payload: row.payload })).toEqual(row.answer);
            const directMs = (performance.now() - directAt) / 40;
            const actionTimes: number[] = [];
            for (let i = 0; i < 40; i++) {
                const actionAt = performance.now();
                const result = await row.read();
                actionTimes.push(performance.now() - actionAt);
                expect(result).toEqual({ ok: true, value: row.answer });
            }
            actionTimes.sort((a, b) => a - b);
            measurements.push({ method: row.method, directMs, actionMeanMs: actionTimes.reduce((sum, time) => sum + time, 0) / actionTimes.length,
                actionP50Ms: actionTimes[20], actionP95Ms: actionTimes[38] });
        }
        expect(inventoryRequests().length).toBe(inventoryRequestsBefore);
        console.info('FX26 warmed read timings (real Action logic, network boundary in memory)', JSON.stringify(measurements));
    });
    it('reaches the admitted machine family and preserves target/account capture and real waiver policy', async () => {
        const answer = { v: 1, machineId: 'm', capturedAtMs: 1000, state: 'live', platform: 'linux', evidenceModel: 'fenced', owners: [], leftBehind: [],
            totals: { happier: { processCount: 0, memoryBytes: 0 }, leftBehind: { processCount: 0, memoryBytes: 0 } } };
        homes.answer(savedHomeId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'machines.processes.kill': ['ui'], 'machines.processes.leftBehind.cleanUp': ['ui'] } },
        } }, version: 1 } });
        rpc.machine.mockResolvedValueOnce(answer);
        const executor = createDefaultActionExecutor();
        const context = { serverId, expectedAccountId: 'owner', surface: 'ui' as const };
        expect(await executor.execute('machines.processes.list', { machineId: 'm' }, context)).toEqual({ ok: true, result: answer });
        expect(rpc.machine.mock.calls[0][0]).toMatchObject({ serverId, accountId: 'owner', machineId: 'm', method: RPC_METHODS.MACHINES_PROCESSES_LIST,
            payload: { machineId: 'm', serverId }, preferScoped: true });
        const result = { status: 'ended', outcomes: [{ ref: 'r', outcome: 'ended', freedBytes: 40 }] };
        rpc.machine.mockResolvedValueOnce(result);
        expect(await executeMachineProcessesActionV1('machines.processes.kill', kill, { ...context, actionRequestId: 'captured-kill' })).toEqual({ ok: true, result });
        expect(rpc.machine.mock.calls[1][0]).toMatchObject({ serverId, accountId: 'owner', method: RPC_METHODS.MACHINES_PROCESSES_KILL, payload: { ...kill, serverId }, requestId: 'captured-kill' });
        const cleanUp = { ended: [{ ref: 'vite', freedBytes: 100 }], skipped: [] };
        rpc.machine.mockResolvedValueOnce(cleanUp);
        const rows = ['vite', 'sleep'].map((name, index) => ({ rowId: name, ref: name, name, pid: index + 20, startedAtMs: 1,
            level: 'left_behind' as const, memoryBytes: 100, memoryKind: 'rss' as const, owner: { kind: 'session' as const, sessionId: 's' }, confirmedAtMs: 100 }));
        expect(await executeMachineProcessesLeftBehindCleanUpV1('m', rows, { query: 'vite' }, context)).toEqual({ ok: true, result: cleanUp });
        expect(rpc.machine.mock.calls[2][0]).toMatchObject({ method: RPC_METHODS.MACHINES_PROCESSES_LEFT_BEHIND_CLEAN_UP,
            payload: { machineId: 'm', serverId, refs: ['vite'] } });
        const priorCalls = rpc.machine.mock.calls.length;
        expect(await executor.execute('machines.processes.list', { machineId: 'm', serverId: 'different' }, context)).toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
        expect(rpc.machine.mock.calls).toHaveLength(priorCalls);
    });
    it('creates the existing canonical approval Artifact without signaling the machine before review', async () => {
        await homes.requireUiApproval(savedHomeId, 'machines.processes.kill');
        const outcome = await createDefaultActionExecutor().execute('machines.processes.kill', kill, {
            serverId, expectedAccountId: 'owner', surface: 'ui', actionRequestId: 'review-kill',
        });
        expect(outcome, outcome.ok ? undefined : outcome.errorCode).toMatchObject({ ok: true });
        if (!outcome.ok) throw new Error(outcome.error);
        const approval = ActionApprovalRequestCreatedResultSchema.parse(outcome.result);
        expect(JSON.parse(homes.artifacts(savedHomeId).readPlainBody(approval.artifactId)!)).toMatchObject({ actionId: 'machines.processes.kill', actionArgs: kill, status: 'open' });
        expect(rpc.machine).not.toHaveBeenCalled();
    });
    it('resolves an explicit Process Action Home from its input rather than the focused Home', async () => {
        const targetHome = await homes.addHome({ name: 'Background Home', serverUrl: 'https://background-processes.test', accountId: 'background-owner', currentAccount: true, active: false });
        const answer = { v: 1, machineId: 'm', capturedAtMs: 1000, state: 'live', platform: 'linux', evidenceModel: 'fenced', owners: [], leftBehind: [],
            totals: { happier: { processCount: 0, memoryBytes: 0 }, leftBehind: { processCount: 0, memoryBytes: 0 } } };
        rpc.machine.mockResolvedValueOnce(answer);
        expect(await createDefaultActionExecutor().execute('machines.processes.list', { machineId: 'm', serverId: targetHome }, { surface: 'ui' }))
            .toEqual({ ok: true, result: answer });
        expect(rpc.machine.mock.calls[0][0]).toMatchObject({ serverId: targetHome, accountId: 'background-owner', machineId: 'm' });
    });
    it.each(['accept', 'decline', 'retire', 'wrong_machine', 'wrong_home', 'missing_target'] as const)
    ('joins the actual Service review only for the bound Process machine and current scope (%s)', async decision => {
        homes.answer(savedHomeId, '/v2/account/settings', { body: { content: { t: 'plain', v: {
            actionsSettingsV1: { v: 1, actions: {}, approvalWaivedSurfaces: { 'localServices.launcher.start': ['ui'] } },
        } }, version: 1 } });
        const machineId = decision === 'wrong_machine' ? 'other' : 'm';
        const workspace = { serverId: decision === 'wrong_home' ? 'different-home' : serverId, machineId, workspaceId: 'w', rootPath: '/accepted' };
        const request = { machineId, targetId: 'managed:preview', workspace, declaration: { workspaceRefId: 'w', selection: { kind: 'manifest' as const, name: 'preview' } }, expectedEffectDigest: 'a'.repeat(64) };
        const target = { id: request.targetId, machineId, workspace, declaration: request.declaration, title: 'Actual native Preview',
            source: 'managed_service' as const, sourceClass: { kind: 'managed_service' as const, managedServiceId: 'preview' },
            confidence: 'medium' as const, state: 'available' as const, actions: ['start' as const] };
        const snapshot = { v: 1 as const, machineId, updatedAt: 1000, targets: decision === 'missing_target' ? [] : [target] };
        const response = { protocolVersion: 1 as const, machineId, targetId: request.targetId, status: 'denied' as const,
            reasonCode: 'project_service_effect_changed', reviewedEffect: { v: 1, purpose: 'service' }, reviewedEffectDigest: 'b'.repeat(64), snapshot };
        rpc.machine.mockResolvedValueOnce({ status: 'refused', reasonCode: response.reasonCode, serviceStart: { request, response } });
        rpc.machine.mockResolvedValueOnce({ protocolVersion: 1, machineId, targetId: request.targetId, status: 'succeeded', snapshot });
        let current = true;
        const reviewEffect = vi.fn(async (_review: unknown) => { if (decision === 'retire') current = false; return decision !== 'decline'; });
        const outcome = await executeMachineProcessesStartAgainV1({ machineId: 'm', ref: 'service-ref' }, { serverId, expectedAccountId: 'owner' }, {
            runtimeActionExecute: createFrontDoorRuntimeActionExecutor(), isCurrent: () => current, reviewEffect,
        });
        expect(reviewEffect).toHaveBeenCalledTimes(['accept', 'decline', 'retire'].includes(decision) ? 1 : 0);
        expect(rpc.machine.mock.calls).toHaveLength(decision === 'accept' ? 2 : 1);
        if (decision === 'accept') {
            expect(reviewEffect.mock.calls[0][0]).toMatchObject({ target, reviewedEffectDigest: 'b'.repeat(64) });
            expect(rpc.machine.mock.calls[1][0]).toMatchObject({ machineId: 'm', payload: { ...request, expectedEffectDigest: 'b'.repeat(64) } });
            expect(outcome.serviceStartResponse).toMatchObject({ status: 'succeeded' });
        } else expect(outcome.processAction).toMatchObject({ ok: true, result: { status: 'refused' } });
    });
});
