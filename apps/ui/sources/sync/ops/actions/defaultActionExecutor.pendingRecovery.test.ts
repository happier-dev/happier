import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createSessionFixture, standardCleanup } from '@/dev/testkit';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { buildUiActionDispatchRequestV1 } from '@happier-dev/protocol/actions/clientDispatchV1';
import { createUiClientActionReverseHandler } from './clientActionReverseDispatch';
import { createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { PENDING_INPUT_PROTOCOL_VERSION_V4 } from '@happier-dev/protocol/clientCompatibility/primitives';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { answerExternalActionAccountForHome } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { ActionAutomationIndexV1Schema, AUTOMATION_ACTION_INDEX_HTTP_PATH_V1 } from '@happier-dev/protocol/automations/automationActionTriggerV1';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';

// HTTP, device credentials and native confirmation are the only substituted boundaries.
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const { Modal } = await import('@/modal');

beforeEach(async () => {
    await homes.reset();
    await loadSyncSingletonForTests();
    // A prior directly admitted action may leave a one-shot native decision unused.
    vi.mocked(Modal.confirm).mockReset();
    vi.mocked(Modal.confirm).mockResolvedValue(true);
});
afterEach(async () => { await standardCleanup(); await homes.reset(); });

const actionIds = ['session.pending.markHandled', 'session.pending.dismiss', 'session.pending.sendAsNew', 'session.pending.action.set'] as const;
type RecoveryActionId = typeof actionIds[number];

async function targetFixture(actionId: RecoveryActionId, approval: boolean | 'ask' = false, indexCase?: {
    workflowsEnabled: boolean; indexReply: 'missing' | 'empty' | 'unreachable' | 'refused';
}) {
    const host = indexCase ? `pending-index-${indexCase.workflowsEnabled}-${indexCase.indexReply}` : 'pending-recovery';
    const serverId = await homes.addHome({ name: 'Pending Home', serverUrl: `https://${host}.test`, accountId: 'pending-owner', active: false });
    await homes.addHome({ name: 'Focused Home', serverUrl: 'https://pending-focused.test', accountId: 'focused-owner' });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    const baseline = createRootLayoutFeaturesResponse();
    const features = createRootLayoutFeaturesResponse({ capabilities: { session: { ...baseline.capabilities.session,
        pendingInput: { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V4 } } } });
    if (indexCase) {
        expect(tryWriteServerEnabledBitInPlace(features, 'workflows', indexCase.workflowsEnabled)).toBe(true);
        const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
        primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    }
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    if (approval === 'ask') await homes.requireUiApproval(serverId, actionId);
    if (approval === true) await homes.setActionPolicy(serverId, actionId, 'ui', 'allowed');
    const targetExecutionRunId = actionId === 'session.pending.markHandled' || actionId === 'session.pending.action.set' ? undefined : 'run/one';
    const owner = `/v2/sessions/session/pending`;
    const target = targetExecutionRunId ? '/v2/sessions/session/execution-runs/run%2Fone/pending' : owner;
    const operation = actionId === 'session.pending.markHandled' ? 'handled' : actionId === 'session.pending.dismiss' ? 'dismiss' : 'send-as-new';
    const path = actionId === 'session.pending.action.set' ? `${target}/input/action` : `${target}/input/delivery/${operation}`;
    const requestedAction = { v: 1, kind: 'enqueue' } as const;
    homes.answer(serverId, `${actionId === 'session.pending.action.set' ? 'PATCH' : 'POST'} ${path}`,
        { body: actionId === 'session.pending.action.set' ? { ok: true, didUpdate: true, requestedAction }
            : actionId === 'session.pending.sendAsNew' ? { ok: true, newLocalId: 'replacement' } : { ok: true } });
    homes.answer(serverId, `GET ${target}?includeDiscarded=1`, { body: { pending: [] } });
    const input = { sessionId: 'session', localId: 'input', serverId, ...(targetExecutionRunId ? { targetExecutionRunId } : {}),
        ...(actionId === 'session.pending.action.set' ? { requestedAction, resumeWhenAvailable: true } : {}) };
    const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId, expectedAccountId: 'pending-owner' };
    return { serverId, path, input, context };
}

describe('registered UI Pending recovery Action delivery', () => {
    it.each([
        { workflowsEnabled: false, indexReply: 'missing', reads: [0, 0, 0] },
        { workflowsEnabled: true, indexReply: 'missing', reads: [1, 0, 0] },
        { workflowsEnabled: true, indexReply: 'empty', reads: [1, 0, 0] },
        { workflowsEnabled: true, indexReply: 'unreachable', reads: [1, 0, 0] },
        { workflowsEnabled: true, indexReply: 'refused', reads: [1, 1, 1] },
    ] as const)('uses index demand for Workflows enabled=$workflowsEnabled and a $indexReply index', async ({ workflowsEnabled, indexReply, reads }) => {
        const { path, serverId, input, context } = await targetFixture('session.pending.action.set', false, { workflowsEnabled, indexReply });
        const indexPath = AUTOMATION_ACTION_INDEX_HTTP_PATH_V1;
        const indexReplies = {
            missing: { status: 404, body: { error: 'not_found' } },
            empty: { body: ActionAutomationIndexV1Schema.parse({ v: 1, rows: [] }) },
            unreachable: { dispatchThenFail: true },
            refused: { status: 503, body: { error: 'database_connection_unavailable' } },
        };
        homes.answer(serverId, `GET ${indexPath}`, indexReplies[indexReply]);
        const result = { ok: true, result: { didUpdate: true, requestedAction: { v: 1, kind: 'enqueue' } } };
        const reason = workflowsEnabled ? {
            missing: 'not_found', empty: null, unreachable: 'server_unreachable', refused: 'database_connection_unavailable',
        }[indexReply] : null;
        const notices = reason ? { automationNotices: [{ code: 'action_automations_not_checked', reason }] } : {};
        const counts: number[] = [];
        for (let i = 0; i < reads.length; i++) {
            const before = homes.requestsFor(indexPath).length;
            const execution = await createDefaultActionExecutor().execute('session.pending.action.set', input, context);
            counts.push(homes.requestsFor(indexPath).length - before);
            expect(execution).toEqual({ ...result, ...notices });
        }
        expect(counts).toEqual(reads);
        expect(homes.requestsFor(path)).toHaveLength(3);
    });

    it.each([undefined, 'run/one'])('requeues the exact discarded identity for %s through the existing restore owner', async targetExecutionRunId => {
        const { serverId, context } = await targetFixture('session.pending.action.set');
        const base = targetExecutionRunId ? '/v2/sessions/session/execution-runs/run%2Fone/pending' : '/v2/sessions/session/pending';
        const path = `${base}/input/restore`;
        homes.answer(serverId, `POST ${path}`, { body: { ok: true } });
        homes.answer(serverId, `GET ${base}?includeDiscarded=1`, { body: { pending: [] } });
        expect(await createDefaultActionExecutor().execute(ActionIdSchema.parse('session.pending.requeue'),
            { sessionId: 'session', localId: 'input', serverId, ...(targetExecutionRunId ? { targetExecutionRunId } : {}) }, context))
            .toEqual({ ok: true, result: { ok: true } });
        expect(homes.requestsFor(path)).toMatchObject([{ serverId }]);
        expect(homes.requests.filter(request => request.method === 'DELETE')).toEqual([]);
    });

    it('preserves a custody refusal when Remove executes withdrawal instead of legacy deletion', async () => {
        const { serverId, context } = await targetFixture('session.pending.action.set');
        const path = '/v2/sessions/session/pending/input/withdraw';
        homes.answer(serverId, `POST ${path}`, { body: { ok: true, outcome: 'already_delivered' } });
        expect(await createDefaultActionExecutor().execute('session.pending.withdraw',
            { sessionId: 'session', localId: 'input', serverId }, context))
            .toEqual({ ok: true, result: { outcome: 'already_delivered' } });
        expect(homes.requestsFor(path)).toMatchObject([{ serverId }]);
        expect(homes.requests.filter(request => request.method === 'DELETE')).toEqual([]);
    });

    it.each(['steer_now', 'interrupt_and_send'] as const)('sends the retained identity with %s through the Pending owner', async deliveryIntent => {
        const serverIdentityId = 'srv_pending_recovery';
        const serverId = await homes.addHome({ name: 'Pending Home', serverUrl: 'https://pending-recovery.test',
            serverIdentityId, accountId: 'pending-owner', currentAccount: true, active: false });
        await homes.addHome({ name: 'Focused Home', serverUrl: 'https://pending-focused.test', accountId: 'focused-owner' });
        const baseline = createRootLayoutFeaturesResponse();
        const features = createRootLayoutFeaturesResponse({ capabilities: {
            serverIdentity: { serverIdentityId },
            session: { ...baseline.capabilities.session, pendingInput: { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V4 } },
        } });
        homes.answer(serverId, '/v1/features', { body: features });
        homes.answer(serverId, '/v1/features/authenticated', { body: features });
        await answerExternalActionAccountForHome(homes, serverId, {
            actionId: 'session.open', machineId: 'pending-machine', tokenEpoch: 0,
            custodian: { accountId: 'machine-owner', displayName: 'Machine owner' },
            requesterInvocation: 'credentials',
            execute(input, { requestId }) {
                expect(input).toMatchObject({ sessionId: 'session', intent: 'resume' });
                expect(requestId).toBe('input');
                return { status: 'opened', sessionId: 'session', serverId: serverIdentityId };
            },
        });
        const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId, expectedAccountId: 'pending-owner' };
        const { storage } = await import('@/sync/domains/state/storage');
        const session = createSessionFixture({ id: 'session', serverId, encryptionMode: 'plain', active: true,
            metadata: { path: '/repo', host: 'machine', machineId: 'pending-machine', flavor: 'claude', version: '999.0.0' } });
        storage.setState({ sessions: { session } });
        homes.answer(serverId, 'GET /v2/sessions/session', { body: createPlainSessionByIdResponseFixture(session) });
        storage.getState().upsertPendingMessage('session', { id: 'input', localId: 'input', text: 'Retain this input',
            source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: { serverId: serverIdentityId, accountId: 'pending-owner' },
            createdAt: 1, updatedAt: 1, rawRecord: { role: 'user', content: { type: 'text', text: 'Retain this input' }, meta: {} } });
        const path = '/v2/sessions/session/pending/input/action';
        const requestedAction = { v: 1, kind: deliveryIntent === 'steer_now' ? 'steer_now' : 'send_now' };
        homes.answer(serverId, `PATCH ${path}`, { body: { ok: true, didUpdate: true, requestedAction } });
        const result = await createDefaultActionExecutor().execute(ActionIdSchema.parse('session.pending.sendNow'),
            { sessionId: 'session', localId: 'input', serverId, deliveryIntent }, context);
        expect(result, result.ok ? undefined : result.errorCode).toMatchObject({ ok: true, result: { type: 'retry_scheduled' } });
        expect(homes.requestsFor(path)).toMatchObject([{ serverId }]);
        expect(homes.requestsFor('/v1/actions/session.open')).toMatchObject([{ serverId }]);
        expect(homes.requests.filter(request => request.method === 'DELETE')).toEqual([]);
    });
    it.each([
        { stopAt: 10, shared: false, expected: { ok: true, result: { type: 'retry_scheduled' } } },
        { stopAt: 30, shared: false, expected: { ok: false, errorCode: 'held_by_person' } },
        { stopAt: 10, shared: true, expected: { ok: false, errorCode: 'forbidden' } },
    ])('delivers the stale-Team held original for Stop $stopAt and shared Session $shared', async ({ stopAt, shared, expected }) => {
        const serverIdentityId = 'srv_held_delivery';
        const serverId = await homes.addHome({ name: 'Held Delivery', serverUrl: 'https://held-delivery.test',
            serverIdentityId, accountId: 'pending-owner', currentAccount: true, active: false });
        const baseline = createRootLayoutFeaturesResponse();
        const features = createRootLayoutFeaturesResponse({ capabilities: {
            serverIdentity: { serverIdentityId },
            session: { ...baseline.capabilities.session, pendingInput: { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V4 } },
        } });
        homes.answer(serverId, '/v1/features', { body: features });
        homes.answer(serverId, '/v1/features/authenticated', { body: features });
        homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
        const session = createSessionFixture({ id: 'session', serverId, encryptionMode: 'plain', active: false,
            ...(shared ? { accessLevel: 'edit' } : {}),
            lastRuntimeIssue: { v: 1, scope: 'primary_session', status: 'failed', source: 'dependency_failure',
                code: 'team_credential_binding_not_current', occurredAt: 22 },
            metadata: { path: '/repo', host: 'machine', machineId: 'pending-machine', flavor: 'claude', version: '999.0.0',
                claudeSessionId: 'held-thread',
                sessionExplicitStopV1: { v: 1, cause: 'explicit_stop', requestedAtMs: stopAt, requestId: 'stop' } } });
        const { storage } = await import('@/sync/domains/state/storage');
        storage.setState({ sessions: { session } });
        homes.answer(serverId, 'GET /v2/sessions/session', { body: createPlainSessionByIdResponseFixture(session) });
        storage.getState().upsertPendingMessage('session', { id: 'pending-row', localId: 'held-original', text: 'Retain this input',
            source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: { serverId: serverIdentityId, accountId: 'pending-owner' },
            createdAt: 20, updatedAt: 25, rawRecord: { role: 'user', content: { type: 'text', text: 'Retain this input' }, meta: {} } });
        await answerExternalActionAccountForHome(homes, serverId, {
            actionId: 'session.open', machineId: 'pending-machine', tokenEpoch: 0,
            custodian: { accountId: 'machine-owner', displayName: 'Machine owner' },
            requesterInvocation: 'credentials',
            failure: () => stopAt > 20 ? { errorCode: 'held_by_person', error: 'Session is held after explicit Stop' } : null,
            execute(input, { requestId }) {
                expect(input).toMatchObject({ sessionId: 'session', intent: 'resume', resumeRequest: {
                    executionAuthorization: { provenance: 'user_request', requestId: 'held-original', requestedAt: 20 },
                } });
                expect(requestId).toBe('held-original');
                return { status: 'opened', sessionId: 'session', serverId: serverIdentityId };
            },
        });
        const receive = createUiClientActionReverseHandler({ serverId, accountId: 'pending-owner', isCurrent: () => true });
        const agent = createActionExecutor({
            clientActionExecute: async request => (await receive(buildUiActionDispatchRequestV1(request),
                { signal: new AbortController().signal })).execution,
        });
        const result = await agent.execute('session.pending.sendNow',
            { serverId, sessionId: 'session', localId: 'held-original', deliveryIntent: 'deliver_and_resume' },
            { surface: 'agent', authority: 'account_automation', actionRequestId: 'agent-action',
                actionCaller: { kind: 'session', sessionId: 'agent-session', turnDepth: 0, starterDepth: 0 },
                serverId, runtimeAccountId: 'pending-owner',
                actionsSettings: normalizeActionsSettingsV1({ v: 1,
                    approvalWaivedSurfaces: { 'session.pending.sendNow': ['agent'] },
                }) });
        expect(result, result.ok ? undefined : result.errorCode).toMatchObject(expected);
        expect(homes.requestsFor('/v1/actions/session.open')).toHaveLength(shared ? 0 : 1);
        expect(homes.requests.filter(request => request.method !== 'GET' && request.path.includes('/pending'))).toHaveLength(0);
    });

    it.each(actionIds)('executes %s at the captured background Home with its declared UI confirmation policy', async actionId => {
        const { path, serverId, input, context } = await targetFixture(actionId);
        expect(await createDefaultActionExecutor().execute(actionId, input, context)).toEqual({ ok: true,
            result: actionId === 'session.pending.sendAsNew' ? { newLocalId: 'replacement' }
                : actionId === 'session.pending.action.set' ? { didUpdate: true, requestedAction: { v: 1, kind: 'enqueue' } } : { ok: true } });
        expect(Modal.confirm).toHaveBeenCalledTimes(actionId === 'session.pending.action.set' ? 0 : 1);
        expect(homes.requestsFor(path)).toMatchObject([{ serverId }]);
        expect(homes.requests.filter(request => request.path.includes('/delivery/') || request.path.endsWith('/input/action'))).toHaveLength(1);
    });

    it('honors an explicit Ask for reversible pending rearm', async () => {
        const { path, serverId, input, context } = await targetFixture('session.pending.action.set', 'ask');
        vi.mocked(Modal.confirm).mockResolvedValueOnce(false);
        expect(await createDefaultActionExecutor().execute('session.pending.action.set', input, context))
            .toMatchObject({ ok: false, errorCode: 'approval_canceled' });
        expect(Modal.confirm).toHaveBeenCalledTimes(1);
        expect(homes.artifacts(serverId).list()).toHaveLength(0);
        expect(homes.requestsFor(path)).toEqual([]);
    });

    it('honors an Always allow choice without opening a confirmation', async () => {
        const { path, input, context } = await targetFixture('session.pending.markHandled', true);
        expect(await createDefaultActionExecutor().execute('session.pending.markHandled', input, context)).toEqual({ ok: true, result: { ok: true } });
        expect(Modal.confirm).not.toHaveBeenCalled();
        expect(homes.requestsFor(path)).toHaveLength(1);
    });

    it('does not mutate a dismissal when confirmation is denied', async () => {
        const actionId = 'session.pending.dismiss';
        const { path, input, context } = await targetFixture(actionId);
        vi.mocked(Modal.confirm).mockResolvedValueOnce(false);
        expect(await createDefaultActionExecutor().execute(actionId, input, context)).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
        expect(homes.requestsFor(path)).toEqual([]);
    });

    it('does not borrow replacement Account authority for send-as-new after a confirmation is left open', async () => {
        const actionId = 'session.pending.sendAsNew';
        const { path, serverId, input, context } = await targetFixture(actionId);
        const confirming = createDeferred<void>();
        const decision = createDeferred<boolean>();
        vi.mocked(Modal.confirm).mockImplementationOnce(() => { confirming.resolve(undefined); return decision.promise; });
        const action = createDefaultActionExecutor().execute(actionId, input, context);
        await confirming.promise;
        await homes.switchAccount(serverId, 'replacement-owner');
        decision.resolve(true);
        expect(await action).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(homes.requestsFor(path)).toEqual([]);
    });

    it('does not borrow replacement Account authority for direct rearm while its captured policy is loading', async () => {
        const { path, serverId, input, context } = await targetFixture('session.pending.action.set');
        const reading = createDeferred<void>();
        const response = createDeferred<void>();
        homes.answer(serverId, 'GET /v2/account/settings', { select: async () => {
            reading.resolve(undefined);
            await response.promise;
            return { body: { content: { t: 'plain', v: {} }, version: 1 } };
        } });
        const action = createDefaultActionExecutor().execute('session.pending.action.set', input, context);
        await reading.promise;
        await homes.switchAccount(serverId, 'replacement-owner');
        response.resolve(undefined);
        expect(await action).toMatchObject({ ok: false, errorCode: 'action_account_scope_changed' });
        expect(homes.requestsFor(path)).toEqual([]);
    });
});
