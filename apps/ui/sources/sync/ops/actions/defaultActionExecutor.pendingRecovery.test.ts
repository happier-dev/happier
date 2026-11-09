import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferred, createSessionFixture, standardCleanup } from '@/dev/testkit';
import { ActionIdSchema } from '@happier-dev/protocol/actions/actionIds';
import { createPlainSessionByIdResponseFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { PENDING_INPUT_PROTOCOL_VERSION_V4 } from '@happier-dev/protocol/clientCompatibility/primitives';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

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

async function targetFixture(actionId: RecoveryActionId, approval: boolean | 'ask' = false) {
    const serverId = await homes.addHome({ name: 'Pending Home', serverUrl: 'https://pending-recovery.test', accountId: 'pending-owner', active: false });
    await homes.addHome({ name: 'Focused Home', serverUrl: 'https://pending-focused.test', accountId: 'focused-owner' });
    homes.answer(serverId, '/v1/account/encryption/currentness', { body: createPlainAccountEncryptionCurrentnessFixture() });
    const baseline = createRootLayoutFeaturesResponse();
    const features = createRootLayoutFeaturesResponse({ capabilities: { session: { ...baseline.capabilities.session,
        pendingInput: { protocolVersion: PENDING_INPUT_PROTOCOL_VERSION_V4 } } } });
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    if (approval) homes.answer(serverId, '/v2/account/settings', { body: AccountSettingsV2GetResponseSchema.parse({
        content: { t: 'plain', v: { actionsSettingsV1: normalizeActionsSettingsV1({
            v: 1, actions: approval === 'ask' ? { [actionId]: { approvalRequiredSurfaces: ['ui'] } } : {},
            ...(approval === true ? { approvalWaivedSurfaces: { [actionId]: ['ui'] } } : {}),
        }) } }, version: 1,
    }) });
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
        const { serverId, context } = await targetFixture('session.pending.action.set');
        const { storage } = await import('@/sync/domains/state/storage');
        const session = createSessionFixture({ id: 'session', serverId, encryptionMode: 'plain', active: true,
            metadata: { path: '/repo', host: 'machine', machineId: 'pending-machine', flavor: 'claude', version: '999.0.0' } });
        storage.setState({ sessions: { session } });
        homes.answer(serverId, 'GET /v2/sessions/session', { body: createPlainSessionByIdResponseFixture(session) });
        storage.getState().upsertPendingMessage('session', { id: 'input', localId: 'input', text: 'Retain this input',
            source: 'server_pending', deliveryStatus: 'accepted', pendingOutboxScope: { serverId, accountId: 'pending-owner' },
            createdAt: 1, updatedAt: 1, rawRecord: { role: 'user', content: { type: 'text', text: 'Retain this input' }, meta: {} } });
        const path = '/v2/sessions/session/pending/input/action';
        const requestedAction = { v: 1, kind: deliveryIntent === 'steer_now' ? 'steer_now' : 'send_now' };
        homes.answer(serverId, `PATCH ${path}`, { body: { ok: true, didUpdate: true, requestedAction } });
        const result = await createDefaultActionExecutor().execute(ActionIdSchema.parse('session.pending.sendNow'),
            { sessionId: 'session', localId: 'input', serverId, deliveryIntent }, context);
        expect(result).toEqual({ ok: true, result: { type: 'retry_scheduled' } });
        expect(homes.requestsFor(path)).toMatchObject([{ serverId }]);
        expect(homes.requests.filter(request => request.method === 'DELETE')).toEqual([]);
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
        expect(await createDefaultActionExecutor().execute('session.pending.action.set', input, context))
            .toMatchObject({ ok: true, result: { kind: 'approval_request_created' } });
        expect(homes.artifacts(serverId).list()).toHaveLength(1);
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
