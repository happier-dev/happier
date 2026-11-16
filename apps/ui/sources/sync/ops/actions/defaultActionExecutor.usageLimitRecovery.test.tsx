import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { StoredApprovalRequestSchema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { ConnectedServiceUxDiagnosticV1Schema } from '@happier-dev/protocol/connect/connectedServiceUxDiagnostics';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createMachineFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createSessionFixture, createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';

vi.mock('socket.io-client', async importOriginal => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    return { ...original, createFrontDoorActionExecute:
        (await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary')).createFrontDoorActionExecuteForVitest(original) };
});
installDisconnectedServerSocketBoundary();
const { storage } = await import('@/sync/domains/state/storage');
const { settingsDefaults } = await import('@/sync/domains/settings/settings');
const { useMountedActionExecution } = await import('@/components/approvals/useMountedActionExecution');
const { SessionUsageLimitRecoveryBanner } = await import('@/components/sessions/usageLimitRecovery/SessionUsageLimitRecoveryBanner');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');

afterEach(() => { standardCleanup(); vi.restoreAllMocks(); });

it('binds the recovery Action to the existing Session RPC adapter for an agent', async () => {
    await loadSyncSingletonForTests();
    const home = createHomeGovernanceHarness();
    installHomeGovernanceBoundaries({ ...home, request: createSessionReadBatchFetchBoundary(home.request) });
    const serverId = await home.addHome({ name: 'Recovery port', serverUrl: 'https://recovery-port.test', accountId: 'recovery-account' });
    const session = createSessionFixture({ id: 'port-session', serverId, active: true, encryptionMode: 'plain' });
    home.answer(serverId, `/v2/sessions/${session.id}`, { body: createPlainSessionByIdResponseFixture(session) });
    const effects: string[] = [];
    let reply: unknown = { ok: true, status: 'waiting', sessionId: session.id };
    installDisconnectedServerSocketBoundary(socket => {
        configureConnectedServerSocketBoundary(socket);
        vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload: unknown) => {
            if (event !== 'rpc-call') return {};
            if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string') throw new Error('Malformed RPC');
            effects.push(payload.method);
            return { ok: true, result: reply };
        });
    });
    try {
        const result = await createDefaultActionExecutor().execute('session.usageLimit.waitResume.enable', { sessionId: session.id }, {
            surface: 'agent', serverId, authority: 'account_automation', actionCaller: { kind: 'host' }, defaultSessionId: session.id,
        });
        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { ok: true, status: 'waiting', sessionId: session.id } });
        expect(effects).toEqual([`${session.id}:${SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE}`]);
        reply = { ok: false, status: 'rate_limited', sessionId: session.id, errorCode: 'rate_limited', retryAfterMs: 123,
            uxDiagnostic: ConnectedServiceUxDiagnosticV1Schema.parse({ code: 'recovery_retry_scheduled', failurePhase: 'runtime_auth_recovery',
                source: 'usage_limit_recovery', serviceId: 'happier.agent.codex/openai-codex', agentId: 'codex',
                retryable: true, suggestedActions: ['retry'] }) };
        expect(await createDefaultActionExecutor().execute('session.usageLimit.waitResume.enable', { sessionId: session.id }, {
            surface: 'agent', serverId, authority: 'account_automation', actionCaller: { kind: 'host' }, defaultSessionId: session.id,
        })).toMatchObject({ ok: false, errorCode: 'rate_limited', details: reply });
    } finally {
        await serverScopedRpcSocketPool.stopAll(); resetScopedMachineTransportCacheForTests();
        installDisconnectedServerSocketBoundary(); await home.reset();
    }
});

const controls = [
    ['Check', 'session.usageLimit.checkNow', RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW, {}],
    ['Wait', 'session.usageLimit.waitResume.enable', RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE, { remember: true }],
    ['Cancel', 'session.usageLimit.waitResume.cancel', RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL,
        { issueFingerprint: 'usage-limit:one', armedAtMs: 123, runtimeAuthRecoveryAttemptId: 'attempt-1' }],
    ['Credit', 'session.usageLimit.consumeResetCredit', RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT,
        { issueFingerprint: 'usage-limit:one' }],
] as const;

it.each(controls.flatMap(control => (['approve', 'reject'] as const).map(decision => ({ control, decision }))))(
    'governs mounted $control.0 with Require approval ($decision)', async ({ control: [label, actionId, method, args], decision }) => {
        const bridge = await loadSyncSingletonForTests();
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries({ ...home, request: createSessionReadBatchFetchBoundary(home.request) });
        const actionsSettingsV1 = ActionsSettingsV1Schema.parse({ v: 1, actions: {
            [actionId]: { approvalRequiredSurfaces: ['ui'] },
        } });
        const serverUrl = 'https://session-recovery-admission.test';
        const serverId = await home.addHome({ name: 'Recovery', serverUrl, serverIdentityId: 'srv_recovery',
            accountId: 'recovery-account', currentAccount: true });
        const session = createSessionFixture({ id: 'recovery-session', serverId, active: false, encryptionMode: 'plain',
            metadata: { machineId: 'recovery-machine', path: '/repo', host: 'Recovery' } });
        home.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: { actionsSettingsV1 } }, version: 1 } });
        home.answer(serverId, '/v2/sessions', { body: { sessions: [], nextCursor: null, hasNext: false } });
        home.answer(serverId, '/v2/sessions/active', { body: { sessions: [], nextCursor: null, hasNext: false } });
        home.answer(serverId, `/v2/sessions/${session.id}`, { body: createPlainSessionByIdResponseFixture(session) });
        const machine = createPlainMachineRowFixture({ id: 'recovery-machine', accountId: 'recovery-account' });
        home.answer(serverId, '/v1/machines', { body: [machine] });
        home.answer(serverId, '/v1/machines/recovery-machine', { body: { machine } });
        const token = home.findByServerUrl(serverUrl)?.token;
        if (!token) throw new Error('Missing test Account credential');
        const account = await restoreServerAccountForTest({ serverUrl, serverIdentityId: 'srv_recovery',
            accountId: 'recovery-account', credentials: { token }, request: createSessionReadBatchFetchBoundary(async (url, init) => {
                const response = await home.request(url, init);
                return response.status === 404
                    ? createEmptyAccountBootstrapHttpResponse(new URL(String(url)).pathname, init) ?? response : response;
            }) });
        storage.setState({ settings: { ...settingsDefaults, actionsSettingsV1 }, settingsVersion: 1, isDataReady: true });
        storage.getState().applySessions([session]);
        storage.getState().applyMachines([createMachineFixture({ id: machine.id, activeAt: Date.now() })], true, { sourceServerId: serverId });
        const effects: Array<{ method: string; payload: unknown }> = [];
        installDisconnectedServerSocketBoundary(socket => {
            configureConnectedServerSocketBoundary(socket);
            vi.spyOn(socket, 'emitWithAck').mockImplementation(async (event, payload: unknown) => {
                if (event !== 'rpc-call') return { v: 1, ok: true, admittedSessionIds: [] };
                if (!payload || typeof payload !== 'object' || !('method' in payload) || typeof payload.method !== 'string'
                    || !('params' in payload)) throw new Error('Malformed RPC request');
                const actualMethod = payload.method.slice(payload.method.indexOf(':') + 1);
                effects.push({ method: actualMethod, payload: payload.params });
                return { ok: true, result: { ok: true, sessionId: session.id, status: 'waiting' } };
            });
        });
        let pending: Promise<unknown> | undefined;
        let outcome: unknown;
        let ready = false;
        function Recovery() {
            const mounted = useMountedActionExecution({ serverId: account.serverId, accountId: 'recovery-account' });
            const { execute } = mounted;
            ready = mounted.ready;
            return <SessionUsageLimitRecoveryBanner testID="recovery" title="Usage limit" body="Waiting"
                actionLabel={label} actionTestID="recovery-action" onActionPress={() => {
                    pending = execute(actionId, { sessionId: session.id, ...args }, { defaultSessionId: session.id }).then(result => { outcome = result; });
                }} />;
        }
        const screen = await renderScreen(<Recovery />);
        try {
            await waitForHomeGovernance(() => expect(ready).toBe(true));
            await screen.pressByTestIdAsync('recovery-action');
            await Promise.race([
                pending!.then(() => { throw new Error(`Recovery settled before approval: ${JSON.stringify(outcome)}`); }),
                waitForHomeGovernance(() => expect(home.artifacts(serverId).list()).toHaveLength(1)),
            ]);
            expect(effects).toEqual([]);
            expect(outcome).toBeUndefined();
            const artifactId = home.artifacts(serverId).list()[0]!.id;
            expect(StoredApprovalRequestSchema.parse(JSON.parse(home.artifacts(serverId).readPlainBody(artifactId)!)))
                .toMatchObject({ status: 'open', actionId, actionArgs: { sessionId: session.id, ...args } });
            expect(await decideApprovalAsInbox(serverId, artifactId, decision)).toMatchObject({ ok: true });
            if (decision === 'approve') {
                expect(StoredApprovalRequestSchema.parse(JSON.parse(home.artifacts(serverId).readPlainBody(artifactId)!)))
                    .toMatchObject({ status: 'executed', execution: { ok: true } });
            }
            await waitForHomeGovernance(() => expect(outcome).toBeDefined());
            await pending;
            if (decision === 'reject') {
                expect(effects).toEqual([]);
                expect(outcome).toMatchObject({ ok: false, errorCode: 'approval_rejected' });
            } else {
                expect(outcome).toMatchObject({ ok: true, result: { ok: true, sessionId: session.id, status: 'waiting' } });
                expect(effects).toEqual([{ method, payload: expect.objectContaining({ sessionId: session.id, ...args }) }]);
                const agentResult = await createDefaultActionExecutor().execute(actionId, { sessionId: session.id, ...args }, {
                    surface: 'agent', authority: 'account_automation', actionCaller: { kind: 'host' }, serverId, defaultSessionId: session.id,
                });
                if (actionId === 'session.usageLimit.consumeResetCredit') {
                    // A host-origin agent has no exact daemon to retain this Session approval.
                    // The incumbent floor refuses it instead of spending without a human.
                    expect(agentResult).toMatchObject({ ok: false, errorCode: 'approval_origin_unavailable' });
                    expect(effects).toHaveLength(1);
                    return;
                } else {
                    expect(agentResult).toMatchObject({ ok: true, result: { ok: true, status: 'waiting' } });
                }
                expect(effects).toEqual(Array.from({ length: 2 }, () => ({ method, payload: expect.objectContaining({ sessionId: session.id, ...args }) })));
            }
        } finally {
            await screen.unmount(); await pending;
            await serverScopedRpcSocketPool.stopAll(); resetScopedMachineTransportCacheForTests();
            installDisconnectedServerSocketBoundary(); await account.dispose(); await home.reset(); bridge.dispose();
        }
    },
);
