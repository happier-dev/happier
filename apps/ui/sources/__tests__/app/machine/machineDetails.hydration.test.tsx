import React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createMachineFixture, flushHookEffects, standardCleanup } from '@/dev/testkit';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { installTerminalRouteCommonModuleMocks } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import { arrangeMachineDetailsHomeForTests, initializeMachineDetailsRuntimeForTests } from './machineDetailsRuntimeHarness';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { DaemonExecutionRunEntrySchema } from '@happier-dev/protocol/daemon/executionRuns';
import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { socketRpcCodec } from '@happier-dev/sync-client';
import { resolveSessionAutoResumeAdmissionV1 } from '@happier-dev/protocol/sessions/metadata/sessionExplicitStopV1';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

const stopDialogs = vi.hoisted(() => ({ alert: vi.fn(), confirm: vi.fn(async () => true),
    alertAsync: vi.fn<typeof import('@/modal').Modal.alertAsync>() }));
const routeParams = vi.hoisted(() => ({ current: { id: 'machine-missing' } as Record<string, string> }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({
    spies: stopDialogs,
}).module);

installTerminalRouteCommonModuleMocks({
    router: async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ params: () => routeParams.current }).module,
});
const network = await initializeMachineDetailsRuntimeForTests();
const disposeActionExecutorLoader = await installRealActionExecutorModuleLoader();
afterAll(disposeActionExecutorLoader);
const MachineDetailScreen = (await import('@/components/machines/page/MachinePageScreen')).MachinePageScreen;
stopDialogs.alertAsync.mockImplementation(async (title, message, buttons) => {
    stopDialogs.alert(title, message, buttons);
    buttons?.find(button => button.text === 'runs.stop.stopSession')?.onPress?.();
});

let home: Awaited<ReturnType<typeof arrangeMachineDetailsHomeForTests>> | undefined;
let deferred: ReturnType<typeof createDeferred<readonly Machine[]>> | undefined;
afterEach(async () => {
    deferred?.resolve([]);
    deferred = undefined;
    await standardCleanup();
    await home?.dispose();
    home = undefined;
    network.resetRequests();
    stopDialogs.alert.mockClear();
    stopDialogs.confirm.mockClear();
    routeParams.current = { id: 'machine-missing' };
});

describe('MachineDetailScreen canonical Stop fallback', () => {
    it('invokes eligible Voice run Stop through the actual scoped executor', async () => {
        const machine = createMachineFixture({ id: 'voice-stop-machine', activeAt: Date.now() });
        const session = createSessionFixture({ id: 'voice-stop-session', active: true,
            metadata: { ...createSessionFixture().metadata!, machineId: machine.id } });
        home = await arrangeMachineDetailsHomeForTests(network, {
            serverUrl: 'https://machine-voice-stop.example.test', machines: [machine], sessions: [session],
            settings: { experiments: true, featureToggles: { voice: true, 'execution.runs': true },
                actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                    approvalWaivedSurfaces: { 'execution.run.stop': ['voice'] } }) },
        });
        home.storage.setState({ sessions: { [session.id]: { ...session, serverId: home.home.id } } });
        network.setRpcResponder(async request => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.payload,
                `${request.targetId}:${request.method}`);
            return await socketRpcCodec.encodeResponse({ mode: 'plain' }, { ok: true }, decoded.callId);
        });
        const { getActionSpec } = await import('@happier-dev/protocol/actions/actionSpecs');
        const { createVoiceToolHandlers } = await import('@/voice/tools/handlers');
        const name = getActionSpec('execution.run.stop').bindings?.voiceClientToolName;
        expect(name).toBeTruthy();
        const handlers = createVoiceToolHandlers({ resolveSessionId: () => session.id });
        const result = JSON.parse(await handlers[name!]!({ sessionId: session.id, runId: 'voice-run' },
            { serverId: home.home.id }));
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
        expect(network.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP)
            .map(request => ({ serverUrl: request.serverUrl, targetId: request.targetId })))
            .toEqual([{ serverUrl: home.home.serverUrl, targetId: session.id }]);
    });

    it.each(['abort', 'account-retirement'] as const)(
        'does not issue cold Session Stop after %s during the exact-Home snapshot read', async interruption => {
            const machine = createMachineFixture({ id: 'cold-stop-machine', activeAt: Date.now() });
            const session = createSessionFixture({ id: 'cold-stop-session', active: true,
                metadata: { ...createSessionFixture().metadata!, machineId: machine.id } });
            home = await arrangeMachineDetailsHomeForTests(network, {
                serverUrl: `https://machine-stop-cold-${interruption}.example.test`, machines: [machine], sessions: [session],
                settings: { actionsSettingsV1: ActionsSettingsV1Schema.parse({ v: 1,
                    approvalWaivedSurfaces: { 'session.stop': ['ui'] } }) },
            });
            home.storage.setState({ sessions: {}, sessionListRowsByServerId: {} });
            const controller = new AbortController();
            const { captureLazyActionAccountContext } = await import('@/sync/ops/actions/actionAccountContext');
            const account = await captureLazyActionAccountContext(home.home.id, controller.signal);
            let boundaryEntered = false;
            const released = createDeferred<void>();
            home.state.beforeSessionRead = async () => { boundaryEntered = true; await released.promise; };
            network.setRpcResponder(async request => {
                const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.payload,
                    `${request.targetId}:${request.method}`);
                return await socketRpcCodec.encodeResponse({ mode: 'plain' }, { status: 'stopped' }, decoded.callId);
            });
            const { stopSessionUsingCanonicalStrategy } = await import('@/sync/ops/sessionStopStrategy');
            // The caller supplies its real admitted lifetime, not a newly resolved Home Account.
            const invocation = { sessionId: session.id, serverId: home.home.id,
                scope: account.accountLifetime.scope, isCurrent: account.accountLifetime.isCurrent, signal: controller.signal };
            const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
            const stopped = interruption === 'abort'
                ? createDefaultActionExecutor().execute('session.stop', { sessionId: session.id },
                    { surface: 'ui', serverId: home.home.id, signal: controller.signal })
                : stopSessionUsingCanonicalStrategy(invocation);
            try {
                await vi.waitFor(() => expect(boundaryEntered).toBe(true));
                if (interruption === 'abort') controller.abort();
                else {
                    const { TokenStorage } = await import('@/auth/storage/tokenStorage');
                    const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
                    expect(await TokenStorage.setCredentialsForServerUrl(home.home.serverUrl,
                        { serverId: home.home.id }, { token: createAccountTokenForTests('replacement-account') })).toBe(true);
                    await network.setAccount(home.home.serverUrl, 'replacement-account');
                }
                expect(account.accountLifetime.isCurrent()).toBe(false);
                released.resolve();
                // The explicit-stop hold fails before any physical Stop, so an aborted caller gets the typed
                // "Stop control unavailable" refusal (sessionStopWithServerScope) rather than a rejection.
                if (interruption === 'abort') expect(await stopped).toMatchObject({ ok: true,
                    result: { success: false, stopped: false, code: 'session_stop_control_unavailable' } });
                else expect(await stopped).toMatchObject({ success: false, reason: 'failed', errorCode: 'action_account_scope_changed' });
                expect(network.requests.filter(request => request.method === RPC_METHODS.STOP_SESSION
                    || request.method === 'killSession')).toEqual([]);
            } finally {
                released.resolve();
                account.dispose();
            }
        },
    );

    it.each(['disabled', 'refused', 'requested', 'unavailable', 'route-home'] as const)(
        'preserves %s session.stop settlement after an issued run Stop fails', async settlement => {
            const machine = createMachineFixture({ id: 'machine-missing', activeAt: Date.now() });
            const session = createSessionFixture({ id: 'stop-session', active: true,
                metadata: { ...createSessionFixture().metadata!, machineId: machine.id } });
            const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1,
                approvalWaivedSurfaces: { 'execution.run.stop': ['ui'], 'session.stop': ['ui'] },
                ...(settlement === 'disabled' ? { actions: { 'session.stop': { disabledSurfaces: ['ui'] } } } : {}),
            });
            home = await arrangeMachineDetailsHomeForTests(network, {
                serverUrl: `https://machine-stop-${settlement}.example.test`, machines: [machine], sessions: [session],
                settings: { actionsSettingsV1 },
            });
            routeParams.current = { id: machine.id, tab: 'overview' };
            if (settlement === 'route-home') {
                routeParams.current = { id: machine.id, serverId: home.home.id, tab: 'overview' };
                const focused = await network.addHome('https://machine-stop-focused-elsewhere.example.test', 'focused-account');
                const { setActiveServerId, getActiveServerId } = await import('@/sync/domains/server/serverProfiles');
                const { resolveRoutineServerSelectionScope } = await import('@/sync/domains/server/selection/serverSelectionScope');
                const { Platform } = await import('react-native');
                const { isDesktopHost } = await import('@/utils/platform/desktopHost');
                const { restoreConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
                await setActiveServerId(focused.id, { scope: resolveRoutineServerSelectionScope(Platform.OS, isDesktopHost()) });
                await restoreConnectionToActiveServer({ token: focused.token });
                await home.sync.awaitBootstrapForegroundAcquisition();
                expect(getActiveServerId()).toBe(focused.id);
                home.storage.setState({ machineListByServerId: { ...home.storage.getState().machineListByServerId,
                    [home.home.id]: [machine] } });
            }
            home.storage.setState({ sessions: { [session.id]: { ...session, serverId: home.home.id } } });
            const run = DaemonExecutionRunEntrySchema.parse({
                happyHomeDir: '/test/happier', pid: 123, happySessionId: session.id,
                runId: 'stop-run', callId: 'call', sidechainId: 'side', intent: 'review',
                backendTarget: { kind: 'backend', backendId: 'codex' },
                runClass: 'bounded', ioMode: 'request_response', retentionPolicy: 'ephemeral',
                status: 'running', startedAtMs: 1, updatedAtMs: 1,
            });
            network.setRpcResponder(async request => {
                const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.payload,
                    `${request.targetId}:${request.method}`);
                const response = request.method === RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST ? { runs: [run] }
                    : request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP
                        ? { ok: false, error: 'Run control failed', errorCode: 'execution_run_failed' }
                    : request.method === RPC_METHODS.STOP_SESSION
                        ? settlement === 'unavailable' ? { error: 'RPC method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }
                            : settlement === 'refused' ? { status: 'incomplete', reason: 'destroy_failed' } : { status: 'requested' }
                    : request.method === 'killSession'
                        ? { success: false, message: 'RPC method not available', errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE }
                    : {};
                return await socketRpcCodec.encodeResponse({ mode: 'plain' }, response, decoded.callId);
            });
            const fallbackConfirmation = createDeferred<void>();
            stopDialogs.alertAsync.mockImplementationOnce(async (title, message, buttons) => {
                stopDialogs.alert(title, message, buttons);
                await fallbackConfirmation.promise;
                buttons?.find(button => button.text === 'runs.stop.stopSession')?.onPress?.();
            });
            const screen = await home.render(MachineDetailScreen);
            await vi.waitFor(() => expect(screen.findAllByProps({ accessibilityLabel: 'runs.stop.stopRunA11y' }).length).toBeGreaterThan(0));
            const stop = screen.findAllByProps({ accessibilityLabel: 'runs.stop.stopRunA11y' })[0]!.props.onPress;
            let stopping: Promise<void> | undefined;
            try {
                await act(async () => {
                    stopping = stop();
                    await flushHookEffects({ cycles: 2, turns: 2 });
                });
                await vi.waitFor(() => expect(stopDialogs.alert).toHaveBeenCalledWith(
                    'runs.stop.stopRunFailedTitle', 'runs.stop.stopRunFailedBody',
                    expect.arrayContaining([expect.objectContaining({ text: 'runs.stop.stopSession', onPress: expect.any(Function) })]),
                ));
                expect(network.requests.filter(request => request.method === RPC_METHODS.STOP_SESSION)).toEqual([]);
            } finally {
                await act(async () => {
                    fallbackConfirmation.resolve();
                    await stopping;
                    await flushHookEffects({ cycles: 2, turns: 2 });
                });
            }
            // A genuine issued run failure, not a pre-issuance policy/setup refusal, offers fallback.
            expect(network.requests.some(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP)).toBe(true);
            expect(network.requests.filter(request => request.method === SESSION_RPC_METHODS.EXECUTION_RUN_STOP
                || request.method === RPC_METHODS.DAEMON_EXECUTION_RUNS_LIST).every(request => request.serverUrl === home!.home.serverUrl)).toBe(true);
            expect(stopDialogs.confirm).not.toHaveBeenCalled();
            const stopEffects = network.requests.filter(request => request.method === RPC_METHODS.STOP_SESSION);
            if (settlement === 'disabled') {
                expect(stopEffects).toEqual([]);
                expect(stopDialogs.alert).toHaveBeenCalledWith('common.error', expect.stringContaining('action_disabled'));
            } else {
                expect(stopEffects.map(request => ({ serverUrl: request.serverUrl, machineId: request.targetId })), JSON.stringify({
                    alerts: stopDialogs.alert.mock.calls,
                    sessionReads: network.httpRequests.map(request => request.url).filter(url => url.includes(`/sessions/${session.id}`)),
                }))
                    .toEqual([{ serverUrl: home.home.serverUrl, machineId: machine.id }]);
                if (settlement === 'refused') expect(stopDialogs.alert).toHaveBeenCalledWith('common.error',
                    'Session stop incomplete: destroy_failed');
                else if (settlement === 'unavailable') expect(stopDialogs.alert).toHaveBeenCalledWith('errors.daemonUnavailableTitle',
                    expect.any(String), expect.arrayContaining([expect.objectContaining({ text: 'common.retry', onPress: expect.any(Function) })]));
                else expect(stopDialogs.alert.mock.calls.filter(([title]) => title !== 'runs.stop.stopRunFailedTitle')).toEqual([]);
                const state = home.storage.getState();
                if (settlement === 'route-home') {
                    // The Machine page intentionally focuses the Home named by its route.
                    // The separate explicit-Home strategy test covers ambient same-id data.
                    expect(state.profileScope).toMatchObject({ serverId: home.home.id, accountId: 'machine-viewer' });
                    expect(state.settingsScope).toMatchObject({ serverId: home.home.id, accountId: 'machine-viewer' });
                    expect(state.sessions[session.id]).toBeUndefined();
                    expect(state.sessionListRowsByServerId[home.home.id]?.[session.id]).toBeUndefined();
                } else {
                    // A request receipt is not evidence that the process became inactive.
                    expect(state.sessions[session.id]?.active).toBe(true);
                    // The real session.stop Action must preserve lifecycle_control semantics:
                    // accepting this fallback must not fence the next ordinary-message wake.
                    expect(readSessionOwnerMetadataView(state.sessions[session.id])?.sessionExplicitStopV1).toBeUndefined();
                    expect(resolveSessionAutoResumeAdmissionV1({ metadata: readSessionOwnerMetadataView(state.sessions[session.id]),
                        archivedAt: null, authorityAvailable: true, machineAvailable: true })).toBe('eligible');
                }
            }
            expect(screen.findAllByProps({ accessibilityLabel: 'runs.stop.stopRunA11y' })[0]!.props.disabled).toBe(false);
        },
    );

    it('resolves the canonical Stop strategy machine from its explicit Home despite an ambient same-id Session', async () => {
        const machine = createMachineFixture({ id: 'machine-exact', activeAt: Date.now() });
        home = await arrangeMachineDetailsHomeForTests(network, {
            serverUrl: 'https://machine-stop-exact-home.example.test', machines: [machine],
        });
        const ambient = await network.addHome('https://machine-stop-ambient.example.test', 'other-account');
        const session = createSessionFixture({ id: 'same-session', serverId: ambient.id, active: true,
            metadata: { ...createSessionFixture().metadata!, machineId: 'machine-ambient' } });
        home.storage.setState({
            sessions: { [session.id]: session },
            machines: { 'machine-ambient': createMachineFixture({ id: 'machine-ambient', activeAt: Date.now() }) },
            sessionListRowsByServerId: { [home.home.id]: { [session.id]: createSessionListRenderableSessionFixture({
                id: session.id, active: true, metadata: { path: '/exact/project', machineId: machine.id },
            }) } },
            machineListByServerId: { [home.home.id]: [machine] },
        });
        network.setRpcResponder(async request => {
            const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.payload,
                `${request.targetId}:${request.method}`);
            return await socketRpcCodec.encodeResponse({ mode: 'plain' }, { status: 'stopped' }, decoded.callId);
        });
        const { stopSessionUsingCanonicalStrategy } = await import('@/sync/ops/sessionStopStrategy');
        expect(await stopSessionUsingCanonicalStrategy({ sessionId: session.id, serverId: home.home.id }))
            .toEqual({ success: true, effect: 'process_stopped', method: 'daemon_machine_rpc' });
        expect(network.requests.filter(request => request.method === RPC_METHODS.STOP_SESSION)
            .map(request => ({ serverUrl: request.serverUrl, machineId: request.targetId })))
            .toEqual([{ serverUrl: home.home.serverUrl, machineId: machine.id }]);
    });
});

describe('MachineDetailScreen hydration', () => {
    it('keeps its header and loading state until the actual machine refresh supplies the missing row', async () => {
        home = await arrangeMachineDetailsHomeForTests(network, { serverUrl: 'https://machine-hydration-pending.example.test' });
        deferred = createDeferred<readonly Machine[]>();
        home.state.readMachines = () => deferred!.promise;
        const beforeRequests = home.state.machineListRequests;
        const screen = await home.render(MachineDetailScreen);
        await vi.waitFor(() => expect(home!.state.machineListRequests).toBeGreaterThan(beforeRequests));
        expect(screen.getTextContent()).toContain('common.loading');
        expect(screen.getTextContent()).not.toContain('machine.notFound');
        expect(screen.findAllByProps({ testID: 'machine-detail-header' }).length).toBeGreaterThan(0);
        await act(async () => {
            deferred!.resolve([createMachineFixture({
                id: 'machine-missing', activeAt: Date.now(),
                metadata: { ...createMachineFixture().metadata!, displayName: 'Recovered Machine', host: 'host', platform: 'darwin' },
            })]);
            await flushHookEffects({ cycles: 2, turns: 2 });
        });
        await vi.waitFor(() => expect(home!.storage.getState().machines['machine-missing']?.metadata?.displayName,
            JSON.stringify({ machines: home!.storage.getState().machines, scope: home!.storage.getState().profileScope,
                lists: home!.storage.getState().machineListByServerId })).toBe('Recovered Machine'));
        await vi.waitFor(() => expect(screen.getTextContent()).not.toContain('common.loading'));
        expect(screen.getTextContent()).not.toContain('machine.notFound');
        expect(home.storage.getState().machines['machine-missing']?.metadata?.displayName).toBe('Recovered Machine');
    });

    it('retains the page header with not-found after a real successful empty refresh', async () => {
        home = await arrangeMachineDetailsHomeForTests(network, { serverUrl: 'https://machine-hydration-empty.example.test' });
        const screen = await home.render(MachineDetailScreen);
        await vi.waitFor(() => expect(screen.getTextContent()).toContain('machine.notFound'));
        expect(screen.findAllByProps({ testID: 'machine-detail-header' }).length).toBeGreaterThan(0);
    });

    it('retries an unavailable machine without using the pull-to-refresh spinner', async () => {
        const offline = createMachineFixture({
            id: 'machine-missing', active: false, activeAt: Date.now() - 86_400_000,
            metadata: { ...createMachineFixture().metadata!, displayName: 'Offline Machine', host: 'host', platform: 'darwin' },
        });
        home = await arrangeMachineDetailsHomeForTests(network, {
            serverUrl: 'https://machine-hydration-offline.example.test', machines: [offline],
        });
        expect(home.storage.getState().machines['machine-missing']?.metadata?.displayName,
            JSON.stringify({ machines: home.storage.getState().machines, scope: home.storage.getState().profileScope,
                lists: home.storage.getState().machineListByServerId })).toBe('Offline Machine');
        const screen = await home.render(MachineDetailScreen);
        await vi.waitFor(() => expect(screen.findByTestId('machine-vitals-offline')).not.toBeNull());
        deferred = createDeferred<readonly Machine[]>();
        home.state.readMachines = () => deferred!.promise;
        const beforeRequests = home.state.machineListRequests;
        const action = () => screen.findAllByProps({ testID: 'machine-vitals-offline' })[0]!.props.action;
        const refreshing = () => screen.tree.root.findAll(node => Boolean(node.props.refreshControl))[0]!.props.refreshControl.props.refreshing;
        expect(action().loading).toBeFalsy();
        await act(async () => { action().onPress(); await flushHookEffects({ cycles: 1, turns: 1 }); });
        await vi.waitFor(() => expect(home!.state.machineListRequests).toBeGreaterThan(beforeRequests));
        expect(action().loading).toBe(true);
        expect(refreshing()).toBe(false);
        await act(async () => { deferred!.resolve([offline]); await flushHookEffects({ cycles: 2, turns: 2 }); });
        await vi.waitFor(() => expect(action().loading).toBe(false));
        expect(refreshing()).toBe(false);
    });
});
