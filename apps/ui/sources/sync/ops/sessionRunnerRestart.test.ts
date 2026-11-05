import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderConnectionIdSchema } from '@happier-dev/protocol';
import { RestartSessionRunnerRequestV2Schema } from '@happier-dev/protocol/sessions/control/sessionRunnerRestartV2';
import type { SessionRunnerRuntimeStateV1 } from '@happier-dev/protocol/sessions/control/sessionRunnerRuntimeV1';
import { RPC_ERROR_CODES, RPC_METHODS, SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS } from '@happier-dev/protocol/rpc';
import { createSessionFixture, createSessionListRenderableSessionFixture } from '@/dev/testkit';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

// Real Home/Account routing and response decoding; only network/device credentials are replaced.
const boundary = await installSessionOpsNetworkBoundary();
const { socketRpcCodec } = await import('@happier-dev/sync-client');
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const ops = await import('./sessionRunnerRestart');
const { storage } = await import('@/sync/domains/state/storage');
const { Modal } = await import('@/modal');
let home: Awaited<ReturnType<typeof boundary.addHome>>;
let response: (method: string) => unknown | Promise<unknown>;
const decodedRequests: Array<{ method: string; payload: unknown }> = [];

beforeEach(async () => {
    boundary.resetRequests();
    storage.setState({ sessions: {}, sessionListRowsByServerId: {} });
    vi.mocked(Modal.confirm).mockReset();
    vi.mocked(Modal.confirm).mockResolvedValue(true);
    resetScopedMachineTransportCacheForTests();
    home = await boundary.addHome('https://restart.example.test', 'account-a');
    boundary.setHttpResponder(async input => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: {} } });
        return null;
    });
    decodedRequests.length = 0;
    response = () => ({ ok: true, status: 'restarted', sessionId: 's1' });
    boundary.setRpcResponder(async request => {
        const decoded = await socketRpcCodec.decodeRequestParams({ mode: 'plain' }, request.payload, `${request.targetId}:${request.method}`);
        decodedRequests.push({ method: request.method, payload: decoded.params });
        return await socketRpcCodec.encodeResponse({ mode: 'plain' }, await response(request.method), decoded.callId);
    });
});
afterEach(async () => {
    vi.useRealTimers();
    await serverScopedRpcSocketPool.stopAll();
    await resetServerReachabilitySupervisors();
});
afterAll(() => boundary.dispose());

const runtimeState = {
    v: 1,
    sessionId: 's1',
    machineId: 'm1',
    daemonId: 'd1',
    observedAtMs: 1_700_000_000_000,
    runner: {
        pid: 123,
        runtimeId: 'runner-runtime-old',
        cliVersion: '1.0.0',
        entrypointVersion: 'entry-old',
        processCommandHash: 'hash-old',
        entrypointSource: 'process_command',
        startedBy: 'daemon',
        startingMode: 'remote',
    },
    daemon: {
        cliVersion: '1.1.0',
        startedWithCliVersion: '1.1.0',
        currentEntrypointVersion: 'runner-runtime-new',
        currentEntrypointSource: 'packaged_runtime',
    },
    versionState: 'stale',
    statusSource: 'daemon_tracking',
    plannedRestart: {
        supported: true,
        eligible: true,
        disabledReason: null,
    },
} as const;

const processIdentity = { pid: 123, processStartTimeMs: 1_700_000_000_000 } as const;
const launchBinding = {
    v: 1,
    connectionId: ProviderConnectionIdSchema.parse('pc_gateway'),
    contributionKey: null,
    connectionRevision: 1,
    protocol: 'openai-responses',
    materialization: 'engineConfig',
    compatibilityFingerprint: 'compatibility:v1:a',
    bindingSecurityFingerprint: 'binding-security:v1:a',
    displaySnapshot: { providerName: 'Gateway', connectionName: 'Work', connectionRole: 'named', connectionDisplayNameMode: 'custom' },
} as const;
const replacedState = { ...runtimeState, versionState: 'current', runner: { ...runtimeState.runner, pid: 456 } } as const;
const bindingConfirmation = { v: 1, sessionId: 's1', connectionId: launchBinding.connectionId,
    previousBindingSecurityFingerprint: launchBinding.bindingSecurityFingerprint,
    nextBindingSecurityFingerprint: 'binding-security:v1:b' } as const;
function statusResponse(state: SessionRunnerRuntimeStateV1 = replacedState) {
    return { v: 2, state, runnerProcessIdentity: { ...processIdentity, pid: state.runner.pid } };
}

const restartCases = [
    ['stale', () => ops.restartSessionRunnerOnCurrentRuntime({ runtimeState, serverId: home.id }), RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART],
    ['provider binding', () => ops.restartSessionRunnerForProviderBindingChange({ runtimeState, serverId: home.id,
        runnerProcessIdentity: processIdentity, providerBindingSecurityChangeConfirmationV1: bindingConfirmation }), RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2],
] as const;

describe('session runner restart op', () => {
    it.each(['binding', 'same-session-model'])('executes the reviewed binding restart through the public runtime Action (%s)', async kind => {
        const confirmation = { v: 1, sessionId: 's1', connectionId: launchBinding.connectionId,
            previousBindingSecurityFingerprint: launchBinding.bindingSecurityFingerprint,
            nextBindingSecurityFingerprint: 'binding-security:v1:b' };
        response = method => method === RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET
            ? statusResponse(runtimeState) : { ok: true, status: 'restarted', sessionId: 's1' };
        const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
        const result = await createDefaultActionExecutor().execute('session.runtime.refresh', {
            sessionId: 's1', machineId: 'm1', serverId: home.id, mode: 'force_current_cli',
            ...(kind === 'binding' ? { providerBindingSecurityChangeConfirmationV1: confirmation } : {}),
        }, { surface: 'ui', authority: 'present_user', serverId: home.id, actionCaller: { kind: 'host' } });
        expect(result).toEqual({ ok: true, result: { ok: true, status: 'restarted', sessionId: 's1' } });
        expect(decodedRequests).toEqual([
            { method: RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET, payload: { sessionId: 's1' } },
            { method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2, payload: {
                v: 2, sessionId: 's1', mode: 'force_current_cli', reason: 'provider_binding_change_recovery',
                expectedRunnerPid: 123, expectedProcessCommandHash: 'hash-old',
                expectedRunnerEntrypointIdentity: 'runner-runtime-old', expectedRunnerProcessIdentity: processIdentity,
                ...(kind === 'binding' ? { providerBindingSecurityChangeConfirmationV1: confirmation } : {}),
            } },
        ]);
    });
    it.each([
        ['no runner yet', () => ({ v: 2, state: { ...runtimeState, machineId: null, runner: { ...runtimeState.runner, pid: null } }, runnerProcessIdentity: null }), 'runner_not_active', undefined],
        ['wrong machine', () => statusResponse({ ...runtimeState, machineId: 'other-machine' }), 'partial_failure', 'invalid_response'],
        ['transport failure', () => ({ ok: false, errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE, error: 'unreachable' }), 'partial_failure', RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE],
        ['method unavailable', () => ({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, error: 'unavailable' }), 'partial_failure', RPC_ERROR_CODES.METHOD_NOT_AVAILABLE],
        ['old daemon', () => ({ ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'Method not found' }), 'unsupported_daemon', undefined],
    ] as const)('keeps the refresh refusal honest for %s without dispatching a restart', async (_label, status, expectedStatus, errorCode) => {
        response = status;
        const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
        const { ActionIdSchema } = await import('@happier-dev/protocol/actions/actionIds');
        const result = await createDefaultActionExecutor().execute(ActionIdSchema.parse('session.runtime.refresh'),
            { sessionId: 's1', machineId: 'm1', serverId: home.id },
            { surface: 'ui', authority: 'present_user', serverId: home.id, actionCaller: { kind: 'host' } });
        expect(result).toMatchObject({ ok: true, result: { ok: false, status: expectedStatus,
            ...(errorCode ? { diagnostics: { errorCode } } : {}) } });
        expect(decodedRequests.map(request => request.method)).toEqual(expectedStatus === 'unsupported_daemon'
            ? [RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET, RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_GET]
            : [RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET]);
    });

    it('refreshes from the public Action through the banner primitive and exact Home RPC', async () => {
        response = method => method === RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART
            ? { ok: true, status: 'restarted', sessionId: 's1' } : statusResponse(runtimeState);
        const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
        const { ActionIdSchema } = await import('@happier-dev/protocol/actions/actionIds');
        const result = await createDefaultActionExecutor().execute(ActionIdSchema.parse('session.runtime.refresh'),
            { sessionId: 's1', machineId: 'm1', serverId: home.id },
            { surface: 'ui', authority: 'present_user', serverId: home.id, actionCaller: { kind: 'host' } });
        expect(result).toMatchObject({ ok: true, result: { ok: true, status: 'restarted', sessionId: 's1' } });
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(decodedRequests).toContainEqual({ method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART, payload: {
            sessionId: 's1', mode: 'if_stale', reason: 'ui_stale_runner_banner', expectedRunnerPid: 123,
            expectedProcessCommandHash: 'hash-old', expectedRunnerEntrypointIdentity: 'runner-runtime-old',
        } });
    });

    function installActivity(foreground = false) {
        storage.setState({ sessions: { s1: createSessionFixture({ id: 's1', serverId: home.id,
            active: true, activeAt: Date.now(), presence: 'online',
            latestTurnStatus: foreground ? 'in_progress' : null,
            runtimeActivityState: 'active', runtimeActivityActiveCount: 2,
            runtimeActivityObservedAt: Date.now(), runtimeActivityRevision: 1,
        }) } });
    }

    const confirmedMethod = RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_CONFIRMED_BACKGROUND;
    it.each([false, true])('confirms underlying provider activity even with foreground work (%s)', async foreground => {
        installActivity(foreground);
        await restartCases[0][1]();
        expect(Modal.confirm).toHaveBeenCalledWith(expect.any(String), expect.any(String),
            expect.objectContaining({ destructive: true }));
        expect(decodedRequests.map(request => request.method)).toEqual([confirmedMethod]);
    });

    it('cancels without a restart RPC', async () => {
        installActivity();
        vi.mocked(Modal.confirm).mockResolvedValue(false);
        await expect(restartCases[0][1]()).resolves.toBeNull();
        expect(decodedRequests).toEqual([]);
    });

    it.each(['missing detail', 'other Home detail'] as const)('protects exact-Home list activity with %s', async detail => {
        storage.setState({
            sessions: detail === 'missing detail' ? {} : { s1: createSessionFixture({
                id: 's1', serverId: 'other-home', runtimeActivityState: 'idle', runtimeActivityActiveCount: 9,
            }) },
            sessionListRowsByServerId: { [home.id]: { s1: createSessionListRenderableSessionFixture({
                id: 's1', runtimeActivityState: 'active', runtimeActivityActiveCount: 3,
            }) } },
        });
        vi.mocked(Modal.confirm).mockResolvedValue(false);
        await expect(restartCases[0][1]()).resolves.toBeNull();
        expect(Modal.confirm).toHaveBeenCalledWith(expect.any(String), expect.stringContaining('3'),
            expect.objectContaining({ destructive: true }));
        expect(decodedRequests).toEqual([]);
    });

    it('protects an applied-Home legacy carrier while another Home is staged', async () => {
        const { getAppliedActiveServerSnapshot, isAppliedActiveServerRuntimeAvailable,
            publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { setActiveServerId } = await import('@/sync/domains/server/serverProfiles');
        const previousApplied = getAppliedActiveServerSnapshot();
        const previousAvailable = isAppliedActiveServerRuntimeAvailable();
        const previousActive = getActiveServerSnapshot();
        const previousScope = storage.getState().sessionLocalStateScope;
        const staged = await boundary.addHome('https://staged-restart.example.test', 'account-b');
        try {
            publishAppliedActiveServerSnapshot({ serverId: home.id, serverUrl: home.serverUrl, generation: 1 }, false);
            await setActiveServerId(staged.id);
            installActivity();
            const session = storage.getState().sessions.s1!;
            storage.setState({ sessions: { s1: { ...session, serverId: undefined } },
                sessionLocalStateScope: { serverId: home.id, accountId: home.accountId } });
            vi.mocked(Modal.confirm).mockResolvedValue(false);
            await expect(ops.restartSessionRunnerOnCurrentRuntime({ runtimeState })).resolves.toBeNull();
            expect(decodedRequests).toEqual([]);
        } finally {
            publishAppliedActiveServerSnapshot(previousApplied, previousAvailable);
            await setActiveServerId(previousActive.serverId);
            storage.setState({ sessionLocalStateScope: previousScope });
        }
    });

    it('honors the caller lifetime after the dialog resolves', async () => {
        installActivity();
        const controller = new AbortController();
        vi.mocked(Modal.confirm).mockImplementation(async () => { controller.abort(); return true; });
        await expect(ops.restartSessionRunnerOnCurrentRuntime({ runtimeState, serverId: home.id,
            signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
        expect(decodedRequests).toEqual([]);
    });

    it.each(['METHOD_NOT_FOUND', 'METHOD_NOT_AVAILABLE'])('falls back to V1 only after consent when %s', async code => {
        installActivity();
        response = method => method === confirmedMethod ? { ok: false, errorCode: code }
            : { ok: true, status: 'restarted', sessionId: 's1' };
        await expect(restartCases[0][1]()).resolves.toMatchObject({ status: 'restarted' });
        expect(decodedRequests.map(request => request.method)).toEqual([confirmedMethod, RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART]);
        expect(decodedRequests[0]?.payload).toEqual(decodedRequests[1]?.payload);
    });

    it('does not downgrade an authorization denial', async () => {
        installActivity();
        response = method => method === confirmedMethod ? { ok: false, errorCode: 'FORBIDDEN', error: 'Method not found' } : statusResponse(runtimeState);
        vi.useFakeTimers();
        const pending = restartCases[0][1]();
        await vi.waitFor(() => expect(decodedRequests.length).toBeGreaterThan(0));
        await vi.advanceTimersByTimeAsync(15_000);
        await expect(pending).resolves.toMatchObject({ ok: false });
        expect(decodedRequests.filter(request => request.method === RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART)).toEqual([]);
    });

    it.each([true, false])('uses the same confirmation from the UI Action (accepted: %s)', async accepted => {
        installActivity(true);
        vi.mocked(Modal.confirm).mockResolvedValue(accepted);
        response = method => method === confirmedMethod
            ? { ok: true, status: 'restarted', sessionId: 's1' } : statusResponse(runtimeState);
        const { createDefaultActionExecutor } = await import('./actions/defaultActionExecutor');
        const { ActionIdSchema } = await import('@happier-dev/protocol/actions/actionIds');
        const result = await createDefaultActionExecutor().execute(ActionIdSchema.parse('session.runtime.refresh'),
            { sessionId: 's1', machineId: 'm1', serverId: home.id },
            { surface: 'ui', authority: 'present_user', serverId: home.id, actionCaller: { kind: 'host' } });
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
        expect(result).toMatchObject(accepted ? { ok: true, result: { status: 'restarted' } }
            : { ok: false, errorCode: 'cancelled' });
        expect(decodedRequests.filter(request => request.method.startsWith('daemon.sessionRunner.restart'))
            .map(request => request.method)).toEqual(accepted ? [confirmedMethod] : []);
    });

    it.each(['accept', 'cancel', 'older daemon'] as const)('protects background work for a provider-binding restart (%s)', async outcome => {
        installActivity(true);
        vi.mocked(Modal.confirm).mockResolvedValue(outcome !== 'cancel');
        response = method => method === confirmedMethod && outcome === 'older daemon'
            ? { ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND }
            : { ok: true, status: 'restarted', sessionId: 's1' };
        const result = await restartCases[1][1]();
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
        if (outcome === 'cancel') {
            expect(result).toBeNull();
            expect(decodedRequests).toEqual([]);
            return;
        }
        expect(decodedRequests.map(request => request.method)).toEqual(outcome === 'older daemon'
            ? [confirmedMethod, RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2] : [confirmedMethod]);
        expect(decodedRequests[0]?.payload).toMatchObject({ v: 2,
            expectedRunnerProcessIdentity: processIdentity,
            providerBindingSecurityChangeConfirmationV1: { previousBindingSecurityFingerprint: 'binding-security:v1:a',
                nextBindingSecurityFingerprint: 'binding-security:v1:b' },
        });
        if (outcome === 'older daemon') expect(decodedRequests[1]?.payload).toEqual(decodedRequests[0]?.payload);
    });

    it('protects retained activity independently of Session presentation availability', async () => {
        installActivity();
        const session = storage.getState().sessions.s1!;
        storage.setState({ sessions: { s1: { ...session, archivedAt: 1, active: false, presence: 1,
            runtimeActivityObservedAt: 1 } } });
        await restartCases[0][1]();
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
        expect(decodedRequests.map(request => request.method)).toEqual([confirmedMethod]);
    });

    it.each(restartCases.flatMap(([name, restart, method]) => [
        { name, restart, method, accept: true }, { name, restart, method, accept: false },
    ]))('confirms late native activity for $name (accepted: $accept)', async ({ restart, method, accept }) => {
        vi.mocked(Modal.confirm).mockResolvedValue(accept);
        response = requestedMethod => requestedMethod === method
            ? { ok: false, status: 'busy', sessionId: 's1', diagnostics: { busySource: 'native_background_work' } }
            : { ok: true, status: 'restarted', sessionId: 's1' };
        const result = await restart();
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
        expect(decodedRequests.map(request => request.method)).toEqual(accept ? [method, confirmedMethod] : [method]);
        if (accept) expect(result).toMatchObject({ status: 'restarted' });
        else expect(result).toBeNull();
        if (accept) expect(decodedRequests[1]?.payload).toEqual(decodedRequests[0]?.payload);
    });

    it.each(restartCases)('accepts a %s restart acknowledgement after deferred child work', async (_name, restart, method) => {
        let release: (() => void) | undefined;
        response = requestedMethod => requestedMethod === method
            ? new Promise(resolve => { release = () => resolve({ ok: true, status: 'restarted', sessionId: 's1' }); })
            : statusResponse(runtimeState);
        vi.useFakeTimers();
        const pending = restart();
        let settled = false;
        void pending.finally(() => { settled = true; });
        await vi.waitFor(() => expect(release).toBeDefined());
        try {
            expect(boundary.requests.find(request => request.method === method)?.timeoutMs).toBeNull();
            await vi.advanceTimersByTimeAsync(120_000);
            expect(settled).toBe(false);
        } finally {
            release?.();
        }
        await expect(pending).resolves.toMatchObject({ ok: true, status: 'restarted' });
        expect(boundary.requests.find(request => request.method === method)?.timeoutMs).toBeNull();
    });

    it('sends V1 aggregate guards and session-write authorization on the selected Home', async () => {
        await expect(restartCases[0][1]()).resolves.toMatchObject({ status: 'restarted' });
        expect(decodedRequests).toEqual([{ method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART, payload: {
            sessionId: 's1', mode: 'if_stale', reason: 'ui_stale_runner_banner', expectedRunnerPid: 123,
            expectedProcessCommandHash: 'hash-old', expectedRunnerEntrypointIdentity: 'runner-runtime-old',
        } }]);
        expect(boundary.requests[0]).toMatchObject({ serverUrl: home.serverUrl, token: home.token, targetId: 'm1' });
        // The guarded RPC carries authorization beside its encoded domain payload.
        const sent = boundary.socketBoundaries.flatMap(item => item.socket.emitWithAck.mock.calls);
        expect(sent).toContainEqual(expect.arrayContaining([expect.objectContaining({ authorization: {
            kind: SOCKET_RPC_AUTHORIZATION_CONTEXT_KINDS.SESSION_WRITE, sessionId: 's1',
        } })]));
    });

    it('cancels deferred refresh with the caller lifetime without starting reconciliation', async () => {
        response = () => new Promise(() => {});
        const controller = new AbortController();
        const pending = ops.restartSessionRunnerOnCurrentRuntime({ runtimeState, serverId: home.id,
            signal: controller.signal });
        let settled: unknown;
        void pending.then(value => { settled = value; }, error => { settled = error; });
        await vi.waitFor(() => expect(decodedRequests).toHaveLength(1));
        controller.abort();
        await vi.waitFor(() => expect(settled).toBeDefined());
        expect(settled).toMatchObject({ name: 'AbortError' });
        expect(decodedRequests.map(request => request.method)).toEqual([RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART]);
    });

    it('confirms the exact provider security change through V2', async () => {
        await restartCases[1][1]();
        expect(RestartSessionRunnerRequestV2Schema.safeParse(decodedRequests[0]?.payload).success).toBe(true);
        expect(decodedRequests[0]).toMatchObject({ method: RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART_V2, payload: {
            v: 2, mode: 'force_current_cli', reason: 'provider_binding_change_recovery', expectedRunnerProcessIdentity: processIdentity,
            providerBindingSecurityChangeConfirmationV1: { v: 1, sessionId: 's1', connectionId: 'pc_gateway',
                previousBindingSecurityFingerprint: 'binding-security:v1:a', nextBindingSecurityFingerprint: 'binding-security:v1:b' },
        } });
    });

    it('returns the typed stale outcome without effects when the runtime PID and process witness disagree', async () => {
        await expect(ops.restartSessionRunnerForProviderBindingChange({
            runtimeState: replacedState,
            runnerProcessIdentity: processIdentity,
            serverId: home.id,
            providerBindingSecurityChangeConfirmationV1: bindingConfirmation,
        })).resolves.toEqual({ ok: false, status: 'runner_identity_changed', sessionId: 's1' });
        expect(boundary.requests).toEqual([]);
        expect(Modal.confirm).not.toHaveBeenCalled();
    });

    it.each(['partial_failure', 'stop_failed', 'spawn_failed', 'runner_identity_changed', 'not_found'] as const)('reconciles ambiguous %s with daemon-owned current runtime', async status => {
        response = method => method === RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART
            ? { ok: false, status, sessionId: 's1' } : statusResponse();
        await expect(restartCases[0][1]()).resolves.toMatchObject({ ok: true, status: 'restarted' });
    });

    it.each([
        ['current runtime on the same process', { ...runtimeState, versionState: 'current' }],
        ['replacement before currentness is published', { ...runtimeState, runner: { ...runtimeState.runner, pid: 456 } }],
    ] as const)('reconciles a stale restart from %s', async (_name, state) => {
        response = method => method === RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART
            ? { ok: false, status: 'partial_failure', sessionId: 's1' } : statusResponse(state);
        await expect(restartCases[0][1]()).resolves.toMatchObject({ ok: true, status: 'restarted' });
    });

    it('reconciles with a supported older daemon aggregate when V2 status is unavailable', async () => {
        response = method => method === RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART
            ? { ok: false, status: 'runner_identity_changed', sessionId: 's1' }
            : method === RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET
                ? { ok: false, errorCode: 'METHOD_NOT_FOUND' } : replacedState;
        await expect(restartCases[0][1]()).resolves.toMatchObject({ ok: true, status: 'restarted' });
    });

    it('observes a lost acknowledgement through the real status RPC', async () => {
        response = method => {
            if (method === RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART) throw new Error('operation has timed out');
            return statusResponse();
        };
        await expect(restartCases[0][1]()).resolves.toMatchObject({ ok: true, status: 'restarted' });
    });

    it('waits for the daemon to publish the replacement after an ambiguous acknowledgement', async () => {
        let reads = 0;
        response = method => method === RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART
            ? { ok: false, status: 'partial_failure', sessionId: 's1' }
            : statusResponse(++reads > 1 ? replacedState : runtimeState);
        vi.useFakeTimers();
        const pending = restartCases[0][1]();
        await vi.waitFor(() => expect(reads).toBeGreaterThan(0));
        await vi.advanceTimersByTimeAsync(1_500);
        await expect(pending).resolves.toMatchObject({ ok: true, status: 'restarted' });
    });

    it('retains binding failure without applied-binding evidence', async () => {
        response = method => method === RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET
            ? statusResponse() : { ok: false, status: 'partial_failure', sessionId: 's1' };
        await expect(restartCases[1][1]()).resolves.toMatchObject({ ok: false, status: 'partial_failure' });
    });

    it.each(['busy', 'ineligible', 'version_unknown', 'unsupported_daemon', 'restart_admission_unsupported', 'not_tracked', 'runner_not_active', 'missing_resume_snapshot', 'missing_spawn_options'] as const)('retains definitive %s outcomes without observing', async status => {
        response = () => ({ ok: false, status, sessionId: 's1' });
        await expect(restartCases[0][1]()).resolves.toMatchObject({ ok: false, status });
        expect(decodedRequests.map(request => request.method)).toEqual([RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART]);
    });

    it.each([RPC_ERROR_CODES.FORBIDDEN, RPC_ERROR_CODES.METHOD_NOT_AVAILABLE])('retains %s from restart without observing or falling back', async errorCode => {
        response = () => ({ ok: false, errorCode, error: 'request refused' });
        await expect(restartCases[0][1]()).resolves.toMatchObject({ ok: false, status: 'partial_failure', diagnostics: { errorCode } });
        expect(decodedRequests.map(request => request.method)).toEqual([RPC_METHODS.DAEMON_SESSION_RUNNER_RESTART]);
    });

    it('fails closed without effects when machine, aggregate identity, or V2 process witness is absent', async () => {
        await expect(ops.restartSessionRunnerOnCurrentRuntime({ runtimeState: { ...runtimeState, machineId: null } })).resolves.toMatchObject({ status: 'partial_failure', diagnostics: { errorCode: 'invalid_response' } });
        await expect(ops.restartSessionRunnerOnCurrentRuntime({ runtimeState: { ...runtimeState, runner: { ...runtimeState.runner, runtimeId: null } } })).resolves.toMatchObject({ status: 'version_unknown' });
        await expect(ops.restartSessionRunnerForProviderBindingChange({ runtimeState, runnerProcessIdentity: null })).resolves.toMatchObject({ status: 'version_unknown', reasonCode: 'runner_generation_unattested' });
        await expect(ops.restartSessionRunnerForProviderBindingChange({ runtimeState: { ...runtimeState, runner: { ...runtimeState.runner, pid: null } }, runnerProcessIdentity: null })).resolves.toMatchObject({ status: 'runner_not_active', reasonCode: 'no_tracked_process' });
        expect(boundary.requests).toEqual([]);
    });

    it('fetches exact V2 witness and falls back to a V1 aggregate for unsupported or malformed V2', async () => {
        response = () => statusResponse(runtimeState);
        const request = { sessionId: 's1', machineId: 'm1', serverId: home.id };
        await expect(ops.getSessionRunnerRuntimeStatusSnapshot(request)).resolves.toEqual({ state: runtimeState, runnerProcessIdentity: processIdentity });
        for (const v2 of [{ ok: false, errorCode: 'METHOD_NOT_FOUND' }, { v: 2, state: runtimeState, runnerProcessIdentity: { pid: 123 } }]) {
            response = method => method === RPC_METHODS.DAEMON_SESSION_RUNNER_STATUS_V2_GET ? v2 : runtimeState;
            await expect(ops.getSessionRunnerRuntimeStatusSnapshot(request)).resolves.toEqual({ state: runtimeState, runnerProcessIdentity: null });
        }
        response = () => ({ ok: true });
        await expect(ops.getSessionRunnerRuntimeStatusSnapshot(request)).resolves.toBeNull();
    });
});
