import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES} from '@happier-dev/protocol/rpcErrors';
import { RPC_METHODS} from '@happier-dev/protocol/rpc/methods';
import { type SessionSpawnNewResultV1} from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { type ActionOperationSnapshotV1 } from '@happier-dev/protocol/actions/operations/v1';
import { t } from '@/text';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { SessionSpawnNewResultV1Schema, projectSessionSpawnNewActionResultV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { SessionCreationKeyV1Schema } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcTypes';
import { clearBugReportUserActionTrail, getBugReportUserActionTrail } from '@/utils/system/bugReportActionTrail';
import { actionStartTargetUnavailableV1 } from '@happier-dev/protocol/actions/executor/actionStartDiagnostics';
import { createProviderErrorV1 } from '@happier-dev/protocol/providers/errors';

const boundary = await installSessionOpsNetworkBoundary();
const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
await loadSyncSingletonForTests();
const sessionSpawnNewAction = await import('./sessionSpawnNewAction');
const { captureLazyActionAccountContext } = await import('./actionAccountContext');
const { serverScopedRpcSocketPool } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcSocketPool');
const { resetScopedMachineTransportCacheForTests } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedRpcPool');
const { resetServerReachabilitySupervisors } = await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool');
const { actionOperationStore } = await import('@/sync/domains/actionOperations/actionOperationStore');

beforeEach(() => boundary.resetRequests());
afterEach(async () => {
    vi.useRealTimers();
    await serverScopedRpcSocketPool.stopAll();
    await resetServerReachabilitySupervisors();
    resetScopedMachineTransportCacheForTests();
});

describe('Session creation pending settlement', () => {
    it.each([false, true])('negotiates committed observation through the real Action and Machine transport (supported: %s)', async supported => {
        const home = await boundary.addHome(`https://spawn-commit-capability-${supported}.test`, 'spawn-account');
        const input = { creationKey: SessionCreationKeyV1Schema.parse('commit-capability'),
            executionTarget: { serverId: home.id, machineId: 'machine-1' }, directory: { kind: 'managed' as const },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
        const success: SessionSpawnNewResultV1 = { type: 'success', disposition: 'created', sessionId: 'committed-session',
            executionTarget: input.executionTarget, organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
        boundary.setRpcResponder(async request => {
            expect(request.method).toBe(RPC_METHODS.SESSION_SPAWN_NEW);
            return success;
        });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            sessionSpawnNew: async ({ admittedInput, signal }) => {
                if (!admittedInput) throw new Error('Expected canonical admitted Session input');
                return await sessionSpawnNewAction.dispatchSessionSpawnNewToMachine({ payload: admittedInput, signal });
            },
        }));
        const onAccepted = vi.fn(() => { throw new Error('The composer could not present the next draft'); });
        await expect(sessionSpawnNewAction.executeSessionSpawnNewAction(input,
            { surface: 'ui', authority: 'present_user', serverId: home.id, expectedAccountId: 'spawn-account' }, executor, {
                operationProtocolCapabilities: { sessionSpawn: { protocolVersions: supported ? [1, 2, 3] : [1, 2] } },
                onCommitted: () => {},
                onAccepted,
            })).resolves.toEqual({ ok: true, result: success });
        expect(onAccepted).toHaveBeenCalledTimes(1);
        expect(boundary.requests.map(request => request.payload)).toEqual([
            { ...input, ...(supported ? { observeSessionCommit: true } : {}) },
        ]);
    });

    it.each([
        { state: 'succeeded', daemonReceipt: true, outcome: 'accepted', providerRefusal: false },
        { state: 'failed', daemonReceipt: true, outcome: 'accepted', providerRefusal: false },
        { state: 'cancelled', daemonReceipt: true, outcome: 'accepted', providerRefusal: false },
        { state: 'succeeded', daemonReceipt: false, outcome: 'accepted', providerRefusal: false },
        { state: 'succeeded', daemonReceipt: true, outcome: 'unknown', providerRefusal: false },
        { state: 'failed', daemonReceipt: true, outcome: 'accepted', providerRefusal: true },
    ] as const)('joins the returned operation in requester scope ($state, daemon receipt: $daemonReceipt, outcome: $outcome, provider refusal: $providerRefusal)', async ({ state, daemonReceipt, outcome, providerRefusal }) => {
        const home = await boundary.addHome('https://spawn-pending.test', 'spawn-account');
        const daemonServerId = 'stack_agent-qa-voice-dev__id_default';
        const input = { creationKey: SessionCreationKeyV1Schema.parse('pending-creation'),
            executionTarget: { serverId: home.id, machineId: 'machine-1' }, directory: { kind: 'managed' as const },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
        const running: ActionOperationSnapshotV1 = { version: 1, operationId: 'pending-operation', revision: 2,
            actionId: 'session.spawn_new', state: 'running', scope: { accountId: 'spawn-account', machineId: 'machine-1' },
            requestId: 'transport-request', title: 'Create session', createdAt: 1, startedAt: 2, cancellation: 'supported' };
        const success: SessionSpawnNewResultV1 = { type: 'success', disposition: 'created', sessionId: 'settled-session',
            executionTarget: { ...input.executionTarget, serverId: daemonServerId }, organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
        const refusal = SessionSpawnNewResultV1Schema.parse({ type: 'error', code: 'spawn_failed', retryable: false,
            providerError: createProviderErrorV1('provider_materialization_failed', { connectionId: 'pc_work', machineId: 'machine-1' }) });
        const settled: ActionOperationSnapshotV1 = { ...running, revision: 3, state, settledAt: 3,
            ...(providerRefusal ? { result: projectSessionSpawnNewActionResultV1(refusal),
                error: { errorCode: 'spawn_failed', error: 'spawn_failed' } }
                : state === 'succeeded' ? { result: projectSessionSpawnNewActionResultV1(success) }
                : state === 'failed' ? { error: { errorCode: 'target_unavailable', error: 'operation_refused' } } : {}) };
        const reading = createDeferred<void>();
        const terminal = createDeferred<void>();
        const requests: string[] = [];
        boundary.setRpcResponder(async request => {
            requests.push(request.method);
            if (request.method === RPC_METHODS.SESSION_SPAWN_NEW) return { type: 'pending', outcome, retryWithSameCreationKey: true,
                operation: { ...input.executionTarget, serverId: daemonReceipt ? daemonServerId : home.id, operationId: running.operationId } };
            if (request.method === 'actionOperation.get.v2') {
                expect(request.payload).toEqual({ operationId: running.operationId, waitForTerminal: true });
                reading.resolve();
                await terminal.promise;
                return { kind: 'found', operation: settled };
            }
            throw new Error(`Unexpected RPC: ${request.method}`);
        });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            sessionSpawnNew: async () => await sessionSpawnNewAction.dispatchSessionSpawnNewToMachine({ payload: input }),
            actionOperationAction: async ({ actionId, input, signal }) => {
                expect(input.serverId).toBe(home.id);
                const { executeActionOperationActionV1 } = await import('@happier-dev/protocol/actions/executor/actionOperationActions');
                const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
                return await executeActionOperationActionV1({ actionId, input, signal, transport: machineRpcWithServerScope });
            },
        }));
        actionOperationStore.mergeSnapshots({ serverId: home.id, snapshots: [running] });
        const onAccepted = vi.fn();
        const action = sessionSpawnNewAction.executeSessionSpawnNewAction(input,
            { surface: 'ui', authority: 'present_user', serverId: home.id, expectedAccountId: 'spawn-account' }, executor, { onAccepted });
        try {
            await Promise.race([reading.promise, action.then(() => { throw new Error('Pending creation returned before settlement'); })]);
            expect(onAccepted).toHaveBeenCalledTimes(outcome === 'accepted' ? 1 : 0);
            if (outcome === 'accepted') expect(onAccepted).toHaveBeenCalledWith({ operation: {
                serverId: home.id, machineId: input.executionTarget.machineId, operationId: running.operationId,
            } });
            terminal.resolve();
            await expect(action).resolves.toEqual(providerRefusal ? { ok: true, result: refusal }
                : state === 'succeeded' ? { ok: true, result: { ...success, executionTarget: input.executionTarget } }
                : state === 'failed' ? { ok: false, ...settled.error }
                    : { ok: false, errorCode: 'action_cancelled', error: 'action_cancelled' });
            expect(onAccepted).toHaveBeenCalledTimes(1);
            expect([...actionOperationStore.getSnapshot().operationsByKey.values()]).toContainEqual({ serverId: home.id,
                snapshot: settled });
            expect([...actionOperationStore.getSnapshot().operationsByKey.values()].some(operation => operation.serverId === daemonServerId)).toBe(false);
            expect(requests.filter(method => method === RPC_METHODS.SESSION_SPAWN_NEW)).toHaveLength(1);
        } finally {
            terminal.resolve();
            await action.catch(() => undefined);
            actionOperationStore.reset();
        }
    });

    it('joins an admitted spawn operation without a second approval or confirmation (New Session Send context)', async () => {
        const home = await boundary.addHome('https://spawn-join-admission.test', 'spawn-account');
        const input = { creationKey: SessionCreationKeyV1Schema.parse('join-admission'),
            executionTarget: { serverId: home.id, machineId: 'machine-1' }, directory: { kind: 'managed' as const },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
        const running: ActionOperationSnapshotV1 = { version: 1, operationId: 'join-operation', revision: 2,
            actionId: 'session.spawn_new', state: 'running', scope: { accountId: 'spawn-account', machineId: 'machine-1' },
            requestId: 'attempt-1', title: 'Create session', createdAt: 1, startedAt: 2, cancellation: 'supported' };
        const success: SessionSpawnNewResultV1 = { type: 'success', disposition: 'created', sessionId: 'joined-session',
            executionTarget: input.executionTarget, organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
        boundary.setRpcResponder(async request => {
            if (request.method === RPC_METHODS.SESSION_SPAWN_NEW) return { type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true,
                operation: { ...input.executionTarget, operationId: running.operationId } };
            if (request.method === 'actionOperation.get.v2') return { kind: 'found', operation: { ...running, revision: 3, state: 'succeeded',
                settledAt: 3, result: projectSessionSpawnNewActionResultV1(success) } };
            throw new Error(`Unexpected RPC: ${request.method}`);
        });
        const asked: string[] = [];
        const required: string[] = [];
        const { isActionApprovalRequiredByAccountSettings } = await import('@/sync/domains/settings/actionsSettings');
        // Protocol admission and the UI's Account-settings policy stay real; only the person's answer is observed.
        const executor = createActionExecutor({ ...createActionExecutorBoundaryFixture({
            sessionSpawnNew: async () => await sessionSpawnNewAction.dispatchSessionSpawnNewToMachine({ payload: input }),
            actionOperationAction: async ({ actionId, input, signal }) => {
                const { executeActionOperationActionV1 } = await import('@happier-dev/protocol/actions/executor/actionOperationActions');
                const { machineRpcWithServerScope } = await import('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc');
                return await executeActionOperationActionV1({ actionId, input, signal, transport: machineRpcWithServerScope });
            },
        }), isActionApprovalRequired: (actionId, ctx, input, defaultUiConfirmation, approvedOperation, approvalScope, defaultSafety) => {
            const value = isActionApprovalRequiredByAccountSettings(actionId, null, ctx as never,
                { defaultSafety, defaultUiConfirmation, input, approvedOperation, approvalScope });
            if (value) required.push(actionId);
            return value;
        }, presentUserActionConfirmation: async ({ actionId }) => { asked.push(actionId); return true; } });
        try {
            await expect(sessionSpawnNewAction.executeSessionSpawnNewAction(input, { surface: 'ui', authority: 'present_user',
                actionRequestId: 'attempt-1', serverId: home.id, expectedAccountId: 'spawn-account', runtimeAccountId: 'spawn-account' }, executor))
                .resolves.toMatchObject({ ok: true });
            expect({ required, asked }).toEqual({ required: [], asked: [] });
        } finally { actionOperationStore.reset(); }
    });

    it.each(['refused', 'wrong Machine', 'missing operation'] as const)(
        'does not announce acceptance for a %s spawn receipt through the real Action transport', async kind => {
        const home = await boundary.addHome(`https://spawn-acceptance-${kind.replaceAll(' ', '-')}.test`, 'spawn-account');
        const input = { creationKey: SessionCreationKeyV1Schema.parse('acceptance-refusal'),
            executionTarget: { serverId: home.id, machineId: 'machine-1' }, directory: { kind: 'managed' as const },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
        boundary.setRpcResponder(async request => {
            expect(request.method).toBe(RPC_METHODS.SESSION_SPAWN_NEW);
            return kind === 'refused' ? { type: 'error', code: 'permission_denied', retryable: false }
                : { type: 'pending', outcome: 'accepted', retryWithSameCreationKey: true,
                    ...(kind === 'wrong Machine' ? { operation: { ...input.executionTarget,
                        machineId: 'machine-2', operationId: 'other-machine-operation' } } : {}) };
        });
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            sessionSpawnNew: async () => sessionSpawnNewAction.dispatchSessionSpawnNewToMachine({ payload: input }),
        }));
        const onAccepted = vi.fn();
        await sessionSpawnNewAction.executeSessionSpawnNewAction(input,
            { surface: 'ui', authority: 'present_user', serverId: home.id, expectedAccountId: 'spawn-account' }, executor, { onAccepted });
        expect(onAccepted).not.toHaveBeenCalled();
        expect(boundary.requests).toHaveLength(1);
    });
});

afterAll(() => boundary.dispose());

describe('Session directory preflight through the Action and Machine transport owners', () => {
    it.each(['running', 'unreported'] as const)('continues a not-required directory preflight through manual custody to spawn and terminal settlement (native power: %s)', async power => {
        const home = await boundary.addHome(`https://spawn-preflight-continues-${power}.test`, 'spawn-account', { serverIdentityId: `srv_spawn-${power}` });
        const account = await captureLazyActionAccountContext(home.id);
        const userAttemptId = `preflight-continues-${power}`;
        const input = { creationKey: sessionSpawnNewAction.buildManualSessionCreationKey(userAttemptId),
            executionTarget: { serverId: home.id, machineId: 'machine-1' },
            directory: { kind: 'path' as const, path: '/workspace/project' },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
        const success: SessionSpawnNewResultV1 = { type: 'success', disposition: 'created', sessionId: 'preflight-session',
            executionTarget: input.executionTarget, organizationPlacement: { folderId: null, tagIds: [] }, initialInput: { status: 'notRequested' } };
        const { ManagedMachineV1Schema } = await import('@happier-dev/protocol/machines/managed/managedMachineV1');
        const managed = ManagedMachineV1Schema.parse({ id: 'managed', homeId: account.serverIdentityId, custodianAccountId: 'spawn-account',
            enrolledMachineId: 'machine-1', creationState: 'active', allocation: 'bound', desired: 'start', desiredWhen: 'now', intentRevision: 0,
            retention: { kind: 'until-delete' }, wakeOnAcceptedMessage: false,
            launch: { provider: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, name: 'Guest', choices: {} },
            resource: { contributionRef: { pluginId: 'custom.compute', localId: 'vm' }, schemaVersion: 1, value: { id: 'native' } },
            observation: { availability: 'present', observedAt: 1, ...(power === 'running' ? { power } : {}) } });
        boundary.setHttpResponder(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/machines/managed/actions/list') return Response.json({ machines: [managed] });
            if (path === '/v1/machines/managed/actions/get') return Response.json(managed);
            return null;
        });
        const { storage } = await import('@/sync/domains/state/storage');
        const { createMachineFixture } = await import('@/dev/testkit/fixtures/machineFixtures');
        const { observeMachinePresenceForTest } = await import('@/dev/testkit/harness/machinePresence');
        storage.getState().applyMachines([createMachineFixture({ id: 'machine-1', active: true })], false,
            { sourceServerId: account.serverId, sourceAccountId: account.accountId });
        observeMachinePresenceForTest(account.accountLifetime.scope, ['machine-1']);
        boundary.setRpcResponder(async request => {
            if (request.method === RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT) return {
                ok: true, directory: input.directory.path, directoryKind: 'path', directoryCreationRequired: false, checkout: null,
            };
            if (request.method === RPC_METHODS.SESSION_SPAWN_NEW) return success;
            throw new Error(`Unexpected RPC: ${request.method}`);
        });
        const { prepareUiManagedMachineWake } = await import('./managedMachineWakePreparation');
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            prepareHostReviewedChildren: request => prepareUiManagedMachineWake(request, account),
            sessionSpawnNewDirectoryApprovalPreflight: sessionSpawnNewAction.createUiSessionSpawnNewDirectoryApprovalPreflight(account),
            sessionSpawnNew: async ({ admittedInput, signal }) => {
                if (!admittedInput) throw new Error('Missing admitted input');
                return sessionSpawnNewAction.dispatchSessionSpawnNewToMachine({ payload: admittedInput, signal });
            },
        }));
        const cancellation = new AbortController();
        let settled: Awaited<ReturnType<typeof sessionSpawnNewAction.executeManualSessionSpawnNewAction>> | undefined;
        const execution = sessionSpawnNewAction.executeManualSessionSpawnNewAction(input,
                { surface: 'ui', authority: 'present_user', actionRequestId: userAttemptId, signal: cancellation.signal }, {
                    scope: { serverId: home.id, accountId: 'spawn-account' }, machineHomeDir: '/workspace', userAttemptId,
                    executeAction: (payload, context) => sessionSpawnNewAction.executeSessionSpawnNewAction(payload, context, executor),
                }).then(result => { settled = result; });
        try {
            await vi.waitFor(() => expect(settled).toMatchObject({ status: 'executed', action: { ok: true, result: success },
                custody: { createdSessionId: success.sessionId } }));
            expect(boundary.requests.map(request => request.method)).toEqual([
                RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT, RPC_METHODS.SESSION_SPAWN_NEW,
            ]);
        } finally { cancellation.abort(); await execution.catch(() => undefined); account.dispose(); }
    });

    it.each(['agent_isolation_unavailable', 'filesystem_identity_custody_unavailable'] as const)(
        'preserves raw %s through directory preflight, the strict result and UI presentation', async code => {
        const home = await boundary.addHome('https://spawn-preflight-isolation.test', 'spawn-account');
        const account = await captureLazyActionAccountContext(home.id);
        boundary.setRpcResponder(async () => ({ error: 'private requester directory detail', errorCode: code,
            details: { directory: '/private/requester/home', reason: 'private custody detail' } }));
        const input = { creationKey: SessionCreationKeyV1Schema.parse('preflight-isolation'),
            executionTarget: { serverId: home.id, machineId: 'machine-1' },
            directory: { kind: 'path' as const, path: '/workspace/project' },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            sessionSpawnNewDirectoryApprovalPreflight: sessionSpawnNewAction.createUiSessionSpawnNewDirectoryApprovalPreflight(account),
            sessionSpawnNew: async () => await sessionSpawnNewAction.dispatchSessionSpawnNewToMachine({ payload: input }),
        }));
        try {
            const action = await sessionSpawnNewAction.executeSessionSpawnNewAction(input,
                { surface: 'ui', authority: 'present_user' }, executor);
            const failure = SessionSpawnNewResultV1Schema.parse({ type: 'error', code: 'spawn_failed', retryable: false,
                launchError: { kind: 'launch_error', code, message: code } });
            expect(action).toEqual({ ok: true, result: failure });
            if (failure.type !== 'error') throw new Error('Expected the strict isolation refusal');
            expect(sessionSpawnNewAction.resolveSessionSpawnNewResultFailureMessage(failure)).toBe(
                t('errors.errorWithCode', { message: t('errors.agentIsolationUnavailable'), code }));
            expect(JSON.stringify(action)).not.toContain('private requester directory detail');
            expect(JSON.stringify(action)).not.toContain('/private/requester/home');
            expect(JSON.stringify(action)).not.toContain('private custody detail');
            expect(boundary.requests.map(request => request.method)).toEqual([RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT]);
        } finally { account.dispose(); }
    });

    it.each([
        { code: 'checkout_unavailable', failure: { type: 'error', code: 'incompatible_target', retryable: false,
            incompatibleTarget: { reason: 'checkout_unavailable' } } },
        { code: 'checkout_failed', failure: { type: 'error', code: 'spawn_failed', retryable: true,
            launchError: { kind: 'launch_error', code: 'checkout_failed', message: 'checkout_failed' } } },
    ] as const)('preserves $code from target preparation at the UI creation result', async ({ code, failure }) => {
        const home = await boundary.addHome(`https://spawn-preflight-${code}.test`, 'spawn-account');
        const account = await captureLazyActionAccountContext(home.id);
        boundary.setRpcResponder(async () => ({ ok: false, code }));
        const input = { creationKey: SessionCreationKeyV1Schema.parse(`preflight-${code}`),
            executionTarget: { serverId: home.id, machineId: 'machine-1' },
            directory: { kind: 'path' as const, path: '/workspace/project' },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            sessionSpawnNewDirectoryApprovalPreflight: sessionSpawnNewAction.createUiSessionSpawnNewDirectoryApprovalPreflight(account),
            sessionSpawnNew: async () => await sessionSpawnNewAction.dispatchSessionSpawnNewToMachine({ payload: input }),
        }));
        try {
            const result = await sessionSpawnNewAction.executeSessionSpawnNewAction(input,
                { surface: 'ui', authority: 'present_user' }, executor);
            expect(result).toEqual({ ok: true, result: SessionSpawnNewResultV1Schema.parse(failure) });
            expect(boundary.requests.map(request => request.method))
                .toEqual([RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT]);
        } finally { account.dispose(); }
    });

    it('keeps an unconfirmed directory read a pre-effect transport refusal without creating a spawn operation', async () => {
        clearBugReportUserActionTrail();
        const home = await boundary.addHome('https://spawn-preflight-read-loss.test', 'spawn-account');
        const account = await captureLazyActionAccountContext(home.id);
        boundary.setRpcAckResponder(async () => {
            throw Object.assign(new Error('socket has been disconnected'), { cause: new Error('private directory read detail') });
        });
        const input = { creationKey: SessionCreationKeyV1Schema.parse('preflight-read-loss'),
            executionTarget: { serverId: home.id, machineId: 'machine-1' },
            directory: { kind: 'path' as const, path: '/workspace/project' },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            sessionSpawnNewDirectoryApprovalPreflight: sessionSpawnNewAction.createUiSessionSpawnNewDirectoryApprovalPreflight(account),
            sessionSpawnNew: async () => await sessionSpawnNewAction.dispatchSessionSpawnNewToMachine({ payload: input }),
        }));
        const operations = actionOperationStore.getSnapshot();
        try {
            const result = await sessionSpawnNewAction.executeSessionSpawnNewAction(input,
                { surface: 'ui', authority: 'present_user' }, executor);
            expect(result).toMatchObject({ ok: true, result: { type: 'error', code: 'spawn_failed', retryable: true,
                launchError: { kind: 'launch_error', code: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE,
                    rpcErrorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE } } });
            expect(boundary.requests.map(request => request.method)).toEqual([RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT]);
            expect(actionOperationStore.getSnapshot()).toBe(operations);
            expect(getBugReportUserActionTrail()).toContainEqual(expect.objectContaining({
                action: 'session.spawn_new.directory_preflight_failure',
                metadata: { phase: 'setup', spawnIssued: false, errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE,
                    rpcErrorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE, requestDisposition: 'outcomeUnknown' },
            }));
            if (!result.ok) throw new Error('Expected a typed pre-effect refusal');
            expect(SessionSpawnNewResultV1Schema.parse(result.result)).toEqual(result.result);
            expect(JSON.stringify(result)).not.toContain('private directory read detail');
            expect(JSON.stringify(getBugReportUserActionTrail())).not.toContain('private directory read detail');
            expect(JSON.stringify(getBugReportUserActionTrail())).not.toContain(input.creationKey);
            expect(JSON.stringify(getBugReportUserActionTrail()).includes(home.token)).toBe(false);
        } finally {
            account.dispose();
        }
    });

    it('keeps an issued spawn acknowledgement loss pending with its original creation key', async () => {
        const home = await boundary.addHome('https://spawn-issued-response-loss.test', 'spawn-account');
        boundary.setRpcAckResponder(async () => {
            throw Object.assign(new Error('socket has been disconnected'), { cause: new Error('private spawn acknowledgement detail') });
        });
        const input = { creationKey: SessionCreationKeyV1Schema.parse('issued-response-loss'),
            executionTarget: { serverId: home.id, machineId: 'machine-1' }, directory: { kind: 'managed' as const },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            sessionSpawnNew: async () => await sessionSpawnNewAction.dispatchSessionSpawnNewToMachine({ payload: input }),
        }));
        const result = await sessionSpawnNewAction.executeSessionSpawnNewAction(input,
            { surface: 'ui', authority: 'present_user' }, executor);
        expect(result).toEqual({ ok: true, result: { type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown' } });
        expect(boundary.requests.map(request => request.method)).toEqual([RPC_METHODS.SESSION_SPAWN_NEW]);
        expect(boundary.requests[0]?.payload).toMatchObject({ creationKey: input.creationKey });
        if (!result.ok) throw new Error('Expected a typed pending spawn');
        expect(SessionSpawnNewResultV1Schema.parse(result.result)).toEqual(result.result);
        expect(JSON.stringify(result)).not.toContain('private spawn acknowledgement detail');
    });

    it('keeps an acknowledged pre-effect spawn transport refusal retryable without claiming an unknown creation', async () => {
        const home = await boundary.addHome('https://spawn-transport-refusal.test', 'spawn-account');
        boundary.setRpcAckResponder(async () => ({ ok: false, errorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE,
            error: 'private transport refusal detail' }));
        const input = { creationKey: SessionCreationKeyV1Schema.parse('transport-refusal'),
            executionTarget: { serverId: home.id, machineId: 'machine-1' }, directory: { kind: 'managed' as const },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            sessionSpawnNew: async () => await sessionSpawnNewAction.dispatchSessionSpawnNewToMachine({ payload: input }),
        }));
        const result = await sessionSpawnNewAction.executeSessionSpawnNewAction(input,
            { surface: 'ui', authority: 'present_user' }, executor);
        expect(result).toMatchObject({ ok: true, result: { type: 'error', code: 'spawn_failed', retryable: true,
            launchError: { kind: 'launch_error', code: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE,
                rpcErrorCode: RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE } } });
        expect(boundary.requests.map(request => request.method)).toEqual([RPC_METHODS.SESSION_SPAWN_NEW]);
        if (!result.ok) throw new Error('Expected a typed pre-effect refusal');
        expect(SessionSpawnNewResultV1Schema.parse(result.result)).toEqual(result.result);
        expect(JSON.stringify(result)).not.toContain('private transport refusal detail');
    });

    it('preserves the generic Machine setup deadline through the strict spawn Action consumer before any spawn is issued', async () => {
        boundary.resetRequests();
        const home = await boundary.addHome('https://spawn-preflight.test', 'spawn-account');
        const account = await captureLazyActionAccountContext(home.id);
        let reading = false;
        boundary.setHttpResponder(async (input, init) => {
            if (!['/v1/machines/machine-1', '/v1/machines/read-batch'].includes(new URL(String(input)).pathname)) return null;
            reading = true;
            return await new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener('abort', () => reject(new DOMException('private request detail', 'AbortError')), { once: true });
            });
        });
        const input = { creationKey: SessionCreationKeyV1Schema.parse('preflight-deadline'), executionTarget: { serverId: home.id, machineId: 'machine-1' },
            directory: { kind: 'path' as const, path: '/workspace/project' },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            sessionSpawnNewDirectoryApprovalPreflight: sessionSpawnNewAction.createUiSessionSpawnNewDirectoryApprovalPreflight(account),
        }));
        vi.useFakeTimers();
        try {
            const action = sessionSpawnNewAction.executeSessionSpawnNewAction(input,
                { surface: 'ui', authority: 'present_user' }, executor);
            // Batch reads dispatch on the next task; let the fake clock run
            // setup before advancing the Machine RPC deadline under test.
            await vi.waitFor(() => expect(reading).toBe(true));
            await vi.advanceTimersByTimeAsync(DEFAULT_SERVER_SCOPED_RPC_TIMEOUT_MS);
            const result = await action;
            expect(result).toMatchObject({ ok: true, result: {
                type: 'error', code: 'spawn_failed', retryable: true,
                launchError: { kind: 'launch_error', code: 'MACHINE_RPC_TIMEOUT' },
            } });
            if (!result.ok) throw new Error('Expected a typed Session creation result');
            expect(SessionSpawnNewResultV1Schema.parse(result.result)).toEqual(result.result);
            expect(JSON.stringify(result)).not.toContain('private request detail');
            expect(boundary.requests).toEqual([]);
        } finally {
            account.dispose();
        }
    });

    it.each([
        { errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, code: 'incompatible_target' },
        { errorCode: RPC_ERROR_CODES.FORBIDDEN, code: 'permission_denied' },
    ] as const)('retains the permanent directory refusal $errorCode through the real RPC binding', async ({ errorCode, code }) => {
        boundary.resetRequests();
        const failureCause = { phase: 'rpc.admission.machine', errorClass: 'Error',
            errorCode: 'machine_unavailable', httpStatus: 403 };
        const home = await boundary.addHome('https://spawn-preflight-refusal.test', 'spawn-account');
        const account = await captureLazyActionAccountContext(home.id);
        boundary.setRpcAckResponder(async request => {
            expect(request.method).toBe(RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT);
            // A typed permanent refusal takes precedence over the bare Socket.IO timeout message.
            return { ok: false, errorCode, error: 'operation has timed out',
                ...(errorCode === RPC_ERROR_CODES.FORBIDDEN ? { failureCause } : {}) };
        });
        const input = { creationKey: SessionCreationKeyV1Schema.parse('preflight-refusal'), executionTarget: { serverId: home.id, machineId: 'machine-1' },
            directory: { kind: 'path' as const, path: '/workspace/project' },
            agentTarget: { kind: 'agent' as const, identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } };
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            sessionSpawnNewDirectoryApprovalPreflight: sessionSpawnNewAction.createUiSessionSpawnNewDirectoryApprovalPreflight(account),
        }));
        try {
            const result = await sessionSpawnNewAction.executeSessionSpawnNewAction(input,
                { surface: 'ui', authority: 'present_user' }, executor);
            expect(result).toMatchObject({ ok: true, result: { type: 'error', code, retryable: false } });
            if (errorCode === RPC_ERROR_CODES.FORBIDDEN) expect(result).toMatchObject({ result: { failureCause } });
            expect(new Set(boundary.requests.map(request => request.method))).toEqual(new Set([RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT]));
            expect(JSON.stringify(result)).not.toContain('operation has timed out');
            if (!result.ok) throw new Error('Expected a typed Session creation refusal');
            expect(SessionSpawnNewResultV1Schema.parse(result.result)).toEqual(result.result);
        } finally {
            account.dispose();
        }
    });
});

type FailurePresentationResolver = (result: Readonly<{
    ok: false;
    errorCode: string;
    error: string;
}>) => 'update_required' | 'generic_failure';

type FailureMessageKeyResolver = (result: Readonly<{
    ok: false;
    errorCode: string;
    error: string;
}>) => 'newSession.actionMethodUnavailable' | 'newSession.failedToStart';

type ResultFailureMessageKeyResolver = typeof import('./sessionSpawnFailurePresentation').resolveSessionSpawnNewResultFailureMessageKey;

describe('session.spawn_new Action failure presentation', () => {
    it('presents only the closed Account currentness cause without copying launch prose', () => {
        const failure = {
            type: 'error', code: 'spawn_failed', retryable: false,
            launchError: { kind: 'launch_error', code: 'currentness_unavailable', message: 'PRIVATE_NATIVE_DIAGNOSTIC',
                currentnessFailure: { reason: 'invalid_response', retryable: false } },
        } as const;
        const message = sessionSpawnNewAction.resolveSessionSpawnNewResultFailureMessage(failure);
        expect(message).toContain('currentness_unavailable:invalid_response');
        expect(message).not.toContain('PRIVATE_NATIVE_DIAGNOSTIC');
        expect(sessionSpawnNewAction.resolveSessionSpawnNewResultFailureMessage({ ...failure,
            launchError: { ...failure.launchError, currentnessFailure: undefined } }))
            .not.toContain('invalid_response');
    });

    it('exposes the producer-owned closed start reason through the existing error-code presenter', () => {
        const failure = actionStartTargetUnavailableV1(undefined, 'agent_start_context', 'caller_depth_unavailable');
        expect(sessionSpawnNewAction.resolveSessionSpawnNewActionFailureMessage(failure))
            .toContain('target_unavailable:caller_depth_unavailable');
        expect(sessionSpawnNewAction.resolveSessionSpawnNewOperationFailureMessage(failure))
            .toContain('target_unavailable:caller_depth_unavailable');
        for (const details of [
            { code: 'target_unavailable', reason: 'private daemon detail' },
            { code: 'target_unavailable', reason: 'caller_depth_unavailable', token: 'private daemon detail' },
        ]) {
            const message = sessionSpawnNewAction.resolveSessionSpawnNewActionFailureMessage({ ...failure, details });
            expect(message).not.toContain('private daemon detail');
            expect(message).not.toContain('caller_depth_unavailable');
        }
    });

    it('exposes only typed content-free approval staleness in the existing error code', () => {
        const failure = { ok: false as const, errorCode: 'approval_stale', error: 'private daemon detail' };
        expect(sessionSpawnNewAction.resolveSessionSpawnNewActionFailureMessage({ ...failure, details: { reason: 'home_changed' } }))
            .toContain('approval_stale:home_changed');
        for (const details of [{ reason: 'private daemon detail' }, { reason: 'home_changed', token: 'private daemon detail' }]) {
            const message = sessionSpawnNewAction.resolveSessionSpawnNewActionFailureMessage({ ...failure, details });
            expect(message).toContain('approval_stale');
            expect(message).not.toContain('home_changed');
            expect(message).not.toContain('private daemon detail');
        }
    });
    it('preserves first-input rejection and uncertainty codes in the existing diagnostic copy', () => {
        const resolve = sessionSpawnNewAction.resolveSessionSpawnNewInitialInputFailureMessage;
        expect(resolve({ status: 'outcomeUnknown', localId: 'first-input', code: 'session_input_admission_outcome_unknown' }, t('newSession.initialInputNotConfirmed')))
            .toBe(t('errors.errorWithCode', { message: t('newSession.initialInputNotConfirmed'), code: 'session_input_admission_outcome_unknown' }));
        expect(resolve({ status: 'rejected', code: 'session_input_storage_unavailable' }, t('session.pendingMessages.admissionRejected.storageUnavailable')))
            .toContain('session_input_storage_unavailable');
    });

    it('retains strict rejection and Action error codes in generic user-facing messages', () => {
        const reconnect = sessionSpawnNewAction.resolveSessionSpawnNewResultFailureMessage({
            type: 'error', code: 'spawn_failed', retryable: false,
            launchError: { kind: 'launch_error', code: 'connected_service_credential_reconnect_required', message: 'Reconnect this account.' },
        });
        expect(reconnect).toContain('connected_service_credential_reconnect_required');
        expect(reconnect).not.toContain('Reconnect this account.');
        expect(sessionSpawnNewAction.resolveSessionSpawnNewResultFailureMessage({
            type: 'error', code: 'creation_conflict', retryable: false,
        })).toContain('creation_conflict');
        const message = sessionSpawnNewAction.resolveSessionSpawnNewActionFailureMessage({
            ok: false, errorCode: 'action_account_scope_changed', error: 'private daemon detail',
        });
        expect(message).toContain('action_account_scope_changed');
        expect(message).not.toContain('private daemon detail');
        expect(sessionSpawnNewAction.resolveSessionSpawnNewResultFailureMessage({
            type: 'pending', retryWithSameCreationKey: true, outcome: 'unknown',
        })).toBe(t('newSession.launchStillPendingBody'));
        expect(sessionSpawnNewAction.resolveSessionSpawnNewActionFailureMessage({
            ok: false, errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, error: 'RPC method not available',
        })).toBe(t('newSession.actionMethodUnavailable'));
    });

    it('renders the redacted child exit reason from a strict spawn result', () => {
        const result = {
            type: 'error', code: 'spawn_failed', retryable: false,
            launchError: { kind: 'launch_error', code: 'CHILD_EXITED_BEFORE_WEBHOOK',
                message: 'Child process exited (code=1, signal=null); module_not_found: nacl-fast.js',
                childExit: { code: 1, signal: null, stderrHead: 'Cannot find module [REDACTED]',
                    cause: { kind: 'module_not_found', specifierBasename: 'nacl-fast.js' } },
            },
        } as const;
        const parsed = SessionSpawnNewResultV1Schema.parse(result);
        if (parsed.type !== 'error') throw new Error('Expected spawn failure');
        const message = sessionSpawnNewAction.resolveSessionSpawnNewResultFailureMessage(parsed);
        expect(message).toContain('code=1');
        expect(message).toContain('module_not_found');
        expect(message).toContain('nacl-fast.js');
    });

    it('names the preserved launch cause while keeping the generic fallback for unknown causes', () => {
        const failed = (code: string) => ({
            type: 'error', code: 'spawn_failed', retryable: true,
            launchError: { kind: 'launch_error', code, message: 'Runner exited before startup completed' },
        }) as const;
        const authority = sessionSpawnNewAction.resolveSessionSpawnNewResultFailureMessage(
            failed('native_agent_privileged_effect_authority_unavailable'),
        );
        expect(authority).toContain(t('session.startFailure.cause.native_agent_privileged_effect_authority_unavailable'));
        expect(authority).toContain('native_agent_privileged_effect_authority_unavailable');
        expect(authority).not.toContain('spawn_failed');
        expect(sessionSpawnNewAction.resolveSessionSpawnNewResultFailureMessage(failed('broker_unavailable')))
            .toContain(t('teams.credentials.errors.brokerUnavailable'));
        const unknown = sessionSpawnNewAction.resolveSessionSpawnNewResultFailureMessage(failed('daemon_private_cause'));
        expect(unknown).toContain(t('newSession.failedToStart'));
        expect(unknown).toContain('spawn_failed');
        expect(unknown).not.toContain('daemon_private_cause');
    });

    it('reserves update guidance for an unavailable Action method', () => {
        const resolveFailurePresentation = (
            sessionSpawnNewAction as unknown as Readonly<{
                resolveSessionSpawnNewActionFailurePresentation?: FailurePresentationResolver;
            }>
        ).resolveSessionSpawnNewActionFailurePresentation;

        expect(resolveFailurePresentation?.({
            ok: false,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            error: 'RPC method not available',
        })).toBe('update_required');
        expect(resolveFailurePresentation?.({
            ok: false,
            errorCode: 'action_method_unavailable',
            error: 'offline',
        })).toBe('generic_failure');

        const resolveFailureMessageKey = (
            sessionSpawnNewAction as unknown as Readonly<{
                resolveSessionSpawnNewActionFailureMessageKey?: FailureMessageKeyResolver;
            }>
        ).resolveSessionSpawnNewActionFailureMessageKey;
        expect(resolveFailureMessageKey?.({
            ok: false,
            errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
            error: 'RPC method not available',
        })).toBe('newSession.actionMethodUnavailable');
        expect(resolveFailureMessageKey?.({
            ok: false,
            errorCode: 'daemon_unavailable',
            error: 'offline',
        })).toBe('newSession.failedToStart');
    });

    it('keeps pending and server-proven machine-offline outcomes distinct from other typed rejections', () => {
        const resolveResultFailureMessageKey = (
            sessionSpawnNewAction as unknown as Readonly<{
                resolveSessionSpawnNewResultFailureMessageKey?: ResultFailureMessageKeyResolver;
            }>
        ).resolveSessionSpawnNewResultFailureMessageKey;

        expect(resolveResultFailureMessageKey?.({ type: 'error', code: 'incompatible_target', retryable: false,
            incompatibleTarget: { reason: 'checkout_unavailable' } })).toBe('newSession.checkoutUnavailableBody');
        expect(resolveResultFailureMessageKey?.({ type: 'error', code: 'incompatible_target', retryable: false,
            incompatibleTarget: { reason: 'requester_credentials_unavailable' } })).toBe('newSession.requesterCredentialsUnavailableBody');

        expect(resolveResultFailureMessageKey?.({
            type: 'pending',
            retryWithSameCreationKey: true,
            outcome: 'unknown',
        })).toBe('newSession.launchStillPendingBody');
        expect(resolveResultFailureMessageKey?.({
            type: 'error',
            code: 'machine_offline',
            retryable: true,
        })).toBe('newSession.daemonRpcUnavailableBody');
        expect(resolveResultFailureMessageKey?.({
            type: 'error',
            code: 'target_unavailable',
            retryable: true,
        })).toBe('newSession.failedToStart');
        expect(resolveResultFailureMessageKey?.({
            type: 'error',
            code: 'organization_invalid',
            retryable: false,
        })).toBe('newSession.failedToStart');
        expect(resolveResultFailureMessageKey?.({
            type: 'error',
            code: 'recipient_key_unavailable',
            retryable: false,
        })).toBe('session.access.repairBody');
        expect(resolveResultFailureMessageKey?.({
            type: 'error',
            code: 'session_access_invalid_recipient_envelope',
            retryable: false,
        })).toBe('session.access.repairBody');
        expect(resolveResultFailureMessageKey?.({
            type: 'error',
            code: 'session_data_key_unavailable',
            retryable: false,
        })).toBe('session.access.preparationKeyUnavailable');
        expect(resolveResultFailureMessageKey?.({
            type: 'error',
            code: 'session_access_external_sharing_disabled',
            retryable: false,
        })).toBe('teams.policy.externalSharingDisabled');
        expect(resolveResultFailureMessageKey?.({
            type: 'error',
            code: 'session_access_external_sharing_requires_team_admin',
            retryable: false,
        })).toBe('teams.policy.externalSharingAdmins');
        // A Home whose Session sharing is off refuses access-bearing creation with
        // its own reason; the copy states that cause instead of a generic failure.
        expect(resolveResultFailureMessageKey?.({
            type: 'error',
            code: 'session_access_sharing_unavailable',
            retryable: false,
        })).toBe('session.collaboration.accessUnavailableReason');
    });
});
