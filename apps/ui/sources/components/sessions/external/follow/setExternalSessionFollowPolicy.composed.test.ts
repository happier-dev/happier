import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AccountSettingsSchema} from '@happier-dev/protocol/account/settings/accountSettings';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { RpcError, RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';
import { ExternalSessionFollowPolicySetRequestSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import { createDeferred, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionActionFixture, installSessionActionRpcBoundary } from '@/dev/testkit/harness/sessionActionRpcBoundary';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import type { ActionApprovalContinuation } from '@/components/approvals/actionApprovalContinuation';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
let answerRpc: Parameters<typeof installSessionActionRpcBoundary>[0] = () => { throw new Error('Unexpected daemon RPC'); };
const requests = installSessionActionRpcBoundary(request => answerRpc(request));
await loadSyncSingletonForTests();
const { storage } = await import('@/sync/domains/state/storage');
const { createDefaultActionExecutor } = await import('@/sync/ops/actions/defaultActionExecutor');
const { setExternalSessionFollowPolicy } = await import('./setExternalSessionFollowPolicy');
const { readExternalSessionFollowPolicy } = await import('@/sync/domains/session/external/externalSessionFollowMetadata');
const { readExternalSessionLink } = await import('@/sync/domains/session/external/readExternalSessionLink');
const { readSessionOwnerMetadataView } = await import('@/sync/domains/session/readSessionOwnerMetadataView');
const { getActiveServerAccountScope, retireActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
let serverId: string;
const actionId = 'sessions.external.backgroundFollow.set';
const machineId = 'follow-machine';
const sessionId = 'follow-session';
const accountId = 'follow-account';
const remoteSessionId = '  native\nremote/AB+cd==  ';
let registerApproval: (registration: ActionApprovalContinuation) => void = () => {};
const link = { v: 1 as const, agentId: 'claude', machineId, remoteSessionId,
    source: { kind: 'claudeConfig', configDir: '/tmp/follow-config' }, linkedAtMs: 1 };

function settings(enabled = true) {
    return AccountSettingsSchema.parse({ actionsSettingsV1: { v: 1,
        actions: { [actionId]: { enabled } },
        approvalWaivedSurfaces: { [actionId]: ['ui', 'agent', 'mcp', 'cli'] },
    } });
}
function installLink(nextLink = link) {
    return installSessionActionFixture({ homes, storage, serverId,
        session: { id: sessionId, active: false, metadata: { machineId, externalSessionV1: nextLink } } });
}
function currentPolicy() {
    return readExternalSessionFollowPolicy(readSessionOwnerMetadataView(storage.getState().sessions[sessionId]!));
}
function toggle(enabled = true) {
    return setExternalSessionFollowPolicy({ sessionId, serverId, link,
        policy: enabled ? 'background_follow' : 'attached_only', registerApproval });
}

beforeEach(async () => {
    await homes.reset();
    requests.length = 0;
    registerApproval = () => {};
    serverId = await homes.addHome({ name: 'Follow Action Home', serverUrl: 'https://follow-actions.test', accountId });
    const machine = createPlainMachineRowFixture({ id: machineId, accountId });
    homes.answer(serverId, `/v1/machines/${machineId}`, { body: { machine } });
    homes.answer(serverId, '/v1/machines', { body: [machine] });
    connection = await restoreServerAccountForTest({ serverUrl: 'https://follow-actions.test', accountId, request: homes.request });
    installHomeGovernanceBoundaries(homes);
    storage.getState().activateProfileScope({ serverId, accountId });
    expect(getActiveServerAccountScope()).toEqual({ serverId, accountId });
    homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings() }, version: 1 } });
    storage.setState({ settings: settings() });
    installLink();
    answerRpc = request => {
        expect(request.method).toBe(`${machineId}:${RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET}`);
        const input = ExternalSessionFollowPolicySetRequestSchema.parse(request.params);
        expect(input.remoteSessionId).toBe(remoteSessionId);
        return { ok: true, enabled: input.enabled, leaseActive: input.enabled, updatedAtMs: input.enabled ? 42 : 84,
            privateNativeObservation: { path: '/private/native' } };
    };
});
afterEach(async () => {
    standardCleanup();
    await connection?.dispose();
    connection = undefined;
});

describe('external follow intent through ordinary Action admission', () => {
    it.each(['allowed', 'ask'] as const)('uses the target Home Account instead of borrowing the active Account id (%s)', async policy => {
        const otherAccountId = 'other-follow-account';
        const otherServerId = await homes.addHome({ name: 'Other Follow Home', serverUrl: 'https://other-follow-actions.test', accountId: otherAccountId });
        const machine = createPlainMachineRowFixture({ id: machineId, accountId: otherAccountId });
        homes.answer(otherServerId, `/v1/machines/${machineId}`, { body: { machine } });
        homes.answer(otherServerId, '/v1/machines', { body: [machine] });
        await homes.setActionPolicy(otherServerId, actionId, 'ui', policy);
        installSessionActionFixture({ homes, storage, serverId: otherServerId,
            session: { id: sessionId, active: false, metadata: { machineId, externalSessionV1: link } } });
        const registered = createDeferred<ActionApprovalContinuation>();
        registerApproval = registration => registered.resolve(registration);
        const pending = setExternalSessionFollowPolicy({ sessionId, serverId: otherServerId, link,
            policy: 'background_follow', registerApproval });
        try {
            if (policy === 'ask') {
                const registration = await registered.promise;
                expect(registration.scope).toEqual({ serverId: otherServerId, accountId: otherAccountId });
                expect(requests).toHaveLength(0);
                expect(await createDefaultActionExecutor().execute('approval.request.decide', {
                    artifactId: registration.artifactId, decision: 'approve',
                }, { surface: 'ui', authority: 'present_user', serverId: otherServerId,
                    expectedAccountId: otherAccountId })).toMatchObject({ ok: true });
            }
            expect(await pending).toEqual({ kind: 'applied' });
        } finally { retireActiveServerAccountScopeLifetime(); await pending; }
        expect(requests).toHaveLength(1);
        expect(currentPolicy()).toBe('background_follow');
    });
    it.each([false, true])('retains Ask completion and the exact linked intent across approval (relinked=%s)', async relinked => {
        await homes.setActionPolicy(serverId, actionId, 'ui', 'ask');
        const registered = createDeferred<ActionApprovalContinuation>();
        registerApproval = registration => registered.resolve(registration);
        const pending = toggle();
        const registration = await registered.promise;
        try {
            expect(homes.artifacts(serverId).list()).toHaveLength(1);
            expect(homes.artifacts(serverId).readPlainBody(registration.artifactId)).toContain(actionId);
            expect(requests).toHaveLength(0);
            if (relinked) installLink({ ...link, remoteSessionId: 'new-remote', linkedAtMs: 2 });
            const decision = await createDefaultActionExecutor().execute('approval.request.decide', {
                artifactId: registration.artifactId, decision: 'approve',
            }, { surface: 'ui', authority: 'present_user', serverId, expectedAccountId: accountId });
            expect(decision.ok).toBe(true);
            expect(await pending).toEqual({ kind: relinked ? 'stale' : 'applied' });
            expect(requests).toHaveLength(relinked ? 0 : 1);
            expect(currentPolicy()).toBe(relinked ? 'attached_only' : 'background_follow');
        } finally { retireActiveServerAccountScopeLifetime(); await pending; }
    });
    it('honors Off before any daemon mutation and preserves the visible policy', async () => {
        homes.answer(serverId, '/v2/account/settings', { body: { content: { t: 'plain', v: settings(false) }, version: 2 } });
        storage.setState({ settings: settings(false) });
        expect(await toggle()).toEqual({ kind: 'refused', reason: 'error' });
        expect(requests).toHaveLength(0);
        expect(currentPolicy()).toBe('attached_only');
    });
    it.each(['ui', 'agent', 'mcp', 'cli'] as const)('resolves the exact linked identity on %s without a live Session process', async surface => {
        const result = await createDefaultActionExecutor().execute(actionId, { sessionId, enabled: true },
            { surface, authority: 'account_automation', serverId, expectedAccountId: accountId, defaultSessionId: sessionId });
        expect(result).toEqual({ ok: true, result: { ok: true, enabled: true, leaseActive: true, updatedAtMs: 42 } });
        expect(requests).toHaveLength(1);
    });
    it('serializes rapid UI toggles and publishes the final admitted policy', async () => {
        const first = createDeferred<unknown>();
        const started = createDeferred<void>();
        const respond = answerRpc;
        answerRpc = request => {
            const input = ExternalSessionFollowPolicySetRequestSchema.parse(request.params);
            if (input.enabled) { started.resolve(); return first.promise; }
            return respond(request, { signal: new AbortController().signal });
        };
        const enable = toggle();
        const disable = toggle(false);
        await started.promise;
        expect(requests).toHaveLength(1);
        first.resolve({ ok: true, enabled: true, leaseActive: true, updatedAtMs: 42 });
        expect(await enable).toEqual({ kind: 'applied' });
        expect(await disable).toEqual({ kind: 'applied' });
        expect(requests).toHaveLength(2);
        expect(currentPolicy()).toBe('attached_only');
    });
    it('retires a late settlement after relinking rather than publishing into the successor link', async () => {
        const started = createDeferred<void>();
        const result = createDeferred<unknown>();
        answerRpc = () => { started.resolve(); return result.promise; };
        const pending = toggle();
        await started.promise;
        installLink({ ...link, remoteSessionId: 'new-remote', linkedAtMs: 2 });
        result.resolve({ ok: true, enabled: true, leaseActive: true, updatedAtMs: 42 });
        expect(await pending).toEqual({ kind: 'stale' });
        expect(currentPolicy()).toBe('attached_only');
    });
    it('retires a late settlement with the captured Account lifetime', async () => {
        const started = createDeferred<void>();
        const result = createDeferred<unknown>();
        answerRpc = () => { started.resolve(); return result.promise; };
        const pending = toggle();
        await started.promise;
        retireActiveServerAccountScopeLifetime();
        result.resolve({ ok: true, enabled: true, leaseActive: true, updatedAtMs: 42 });
        expect(await pending).toEqual({ kind: 'stale' });
        expect(currentPolicy()).toBe('attached_only');
    });
    it('rejects an empty native identity before admission or transport', async () => {
        expect(await setExternalSessionFollowPolicy({ sessionId, serverId,
            link: { ...link, remoteSessionId: ' \n\t ' }, policy: 'background_follow', registerApproval })).toEqual({ kind: 'failed' });
        expect(requests).toHaveLength(0);
    });
    it('does not dispatch a stale captured intent to a successor link', async () => {
        installLink({ ...link, remoteSessionId: 'new-remote', linkedAtMs: 2 });
        expect(await toggle()).toEqual({ kind: 'stale' });
        expect(requests).toHaveLength(0);
    });
    it('preserves the predecessor enable refusal without a legacy write or replay', async () => {
        answerRpc = () => { throw new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND); };
        expect(await toggle()).toEqual({ kind: 'refused', reason: 'unsupported' });
        expect(requests).toHaveLength(1);
        expect(currentPolicy()).toBe('attached_only');
    });
    it('keeps the predecessor disable route safe and provider-named', async () => {
        answerRpc = request => {
            if (request.method.endsWith(RPC_METHODS.DAEMON_EXTERNAL_SESSION_BACKGROUND_FOLLOW_SET)) {
                throw new RpcError('Method not found', RPC_ERROR_CODES.METHOD_NOT_FOUND);
            }
            expect(request.method).toBe(`${machineId}:${RPC_METHODS.DAEMON_DIRECT_SESSION_FOLLOW_POLICY_SET_LEGACY}`);
            expect(request.params).toMatchObject({ providerId: 'claude', remoteSessionId, enabled: false });
            expect(request.params).not.toHaveProperty('agentId');
            return { ok: true, enabled: false, leaseActive: false, updatedAtMs: 84 };
        };
        expect(await toggle(false)).toEqual({ kind: 'applied' });
        expect(requests).toHaveLength(2);
    });
    it('checks a UI intent again after asynchronous admission before transport', async () => {
        let current = true;
        const executor = createDefaultActionExecutor({ isExternalSessionFollowIntentCurrent: () => current });
        const prepared = await executor.prepare(actionId, { sessionId, enabled: true }, {
            surface: 'ui', serverId, expectedAccountId: accountId,
        });
        expect(prepared.kind).toBe('ready');
        if (prepared.kind !== 'ready') return;
        current = false;
        installLink({ ...link, remoteSessionId: 'new-remote', linkedAtMs: 2 });
        expect(await prepared.invocation.run()).toMatchObject({ ok: false, errorCode: 'external_session_follow_intent_stale' });
        expect(requests).toHaveLength(0);
        expect(readExternalSessionLink(readSessionOwnerMetadataView(storage.getState().sessions[sessionId]!))?.remoteSessionId).toBe('new-remote');
    });
});
