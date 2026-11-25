import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';

import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

const homes = createHomeGovernanceHarness();
const network = await installSessionOpsNetworkBoundary();
installHomeGovernanceBoundaries(homes);
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

const sessionId = 'readable-session';
const checkpoint = { v: 1, sessionId, scopes: ['workspace'], candidate: { source: 'happier_scm' }, timing: 'idle' };
const restore = {
    v: 1, sessionId, scopes: ['workspace'],
    candidate: { source: 'happier_scm', checkpointRef: 'refs/happier/checkpoints/scope/turn-final/turn-1' },
    confirmation: { sourceChoiceConfirmed: true },
};

beforeEach(async () => {
    network.resetRequests();
    await homes.reset();
    installHomeGovernanceBoundaries(homes);
});
afterAll(async () => {
    await homes.reset();
    network.dispose();
});

async function addHome() {
    const serverId = await homes.addHome({ name: 'Lifecycle Home', serverUrl: 'https://session-lifecycle.test',
        accountId: 'owner', currentAccount: true, accountEncryptionMode: 'plain' });
    homes.answer(serverId, `GET /v2/sessions/${sessionId}`, {
        body: createPlainSessionByIdResponseFixture(createSessionFixture({
            id: sessionId, active: true, encryptionMode: 'plain', access: createSessionAccessFixture('owner'),
        })),
    });
    homes.answer(serverId, 'GET /v2/sessions/foreign-session', { status: 404, body: { error: 'Session not found' } });
    return { serverId, expectedAccountId: 'owner' };
}

it('returns the checkpoint owner result without confirmation', async () => {
    const home = await addHome();
    const presentUserActionConfirmation = vi.fn(async () => false);
    const executor = createDefaultActionExecutor({ presentUserActionConfirmation });
    const result = { ok: true, status: 'succeeded', source: 'happier_scm', receipts: [] };
    network.respond(SESSION_RPC_METHODS.SESSION_CHECKPOINT, result);

    await expect(executor.execute('session.checkpoint', checkpoint, { ...home, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } }))
        .resolves.toMatchObject({ ok: true, result });
    expect(presentUserActionConfirmation).not.toHaveBeenCalled();
});

it('runs restore only after its single confirmation and returns the owner result', async () => {
    const home = await addHome();
    const presentUserActionConfirmation = vi.fn(async () => {
        expect(network.requests.filter(request => request.method === SESSION_RPC_METHODS.SESSION_RESTORE)).toEqual([]);
        return true;
    });
    const executor = createDefaultActionExecutor({ presentUserActionConfirmation });
    const result = { ok: true, status: 'succeeded', source: 'happier_scm', restoredScopes: ['workspace'], receipts: [] };
    network.respond(SESSION_RPC_METHODS.SESSION_RESTORE, result);

    await expect(executor.execute('session.restore', restore, { ...home, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } }))
        .resolves.toMatchObject({ ok: true, result });
    expect(presentUserActionConfirmation).toHaveBeenCalledTimes(1);
});

it('conceals a missing Session and preserves Home’s refusal for a readable Session', async () => {
    const home = await addHome();
    const executor = createDefaultActionExecutor();
    const context = { ...home, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } } as const;
    await expect(executor.execute('session.checkpoint', { ...checkpoint, sessionId: 'foreign-session' }, context))
        .resolves.toMatchObject({ ok: false, errorCode: 'session_not_found' });
    expect(network.requests.filter(request => request.method === SESSION_RPC_METHODS.SESSION_CHECKPOINT)).toEqual([]);

    network.setRpcAckResponder(async () => ({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN, error: 'Forbidden' }));
    await expect(executor.execute('session.checkpoint', checkpoint, context))
        .resolves.toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN, error: 'Forbidden' });
});

it('keeps an Agent checkpoint behind the approval policy', async () => {
    const home = await addHome();
    const presentUserActionConfirmation = vi.fn(async () => false);
    const executor = createDefaultActionExecutor({ presentUserActionConfirmation });

    const result = await executor.execute('session.checkpoint', checkpoint, {
        ...home, surface: 'agent', actionRequestId: 'checkpoint-request',
        defaultSessionId: sessionId, sessionListAccess: 'current_session',
        actionCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
    });
    expect(result, result.ok ? undefined : result.errorCode).toMatchObject({
        ok: true,
        result: { kind: 'approval_request_created', actionId: 'session.checkpoint', artifactId: expect.any(String) },
    });
    expect(presentUserActionConfirmation).not.toHaveBeenCalled();
    expect(network.requests.filter(request => request.method === SESSION_RPC_METHODS.SESSION_CHECKPOINT)).toEqual([]);
});

it('leaves the Session untouched when the person declines restore', async () => {
    const home = await addHome();
    const presentUserActionConfirmation = vi.fn(async () => false);
    const executor = createDefaultActionExecutor({ presentUserActionConfirmation });

    await expect(executor.execute('session.restore', restore, {
        ...home, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'approval_canceled' });
    expect(presentUserActionConfirmation).toHaveBeenCalledTimes(1);
    expect(network.requests.filter(request => request.method === SESSION_RPC_METHODS.SESSION_RESTORE)).toEqual([]);
});

it('returns the captured Home’s unreadable Session refusal after restore confirmation', async () => {
    const home = await addHome();
    const executor = createDefaultActionExecutor({ presentUserActionConfirmation: async () => true });

    await expect(executor.execute('session.restore', { ...restore, sessionId: 'foreign-session' }, {
        ...home, surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' },
    })).resolves.toMatchObject({ ok: false, errorCode: 'session_not_found' });
    expect(network.requests.filter(request => request.method === SESSION_RPC_METHODS.SESSION_RESTORE)).toEqual([]);
});

it.each(['agent', 'mcp'] as const)('keeps restore disabled on %s', async surface => {
    const home = await addHome();
    const presentUserActionConfirmation = vi.fn(async () => true);
    const executor = createDefaultActionExecutor({ presentUserActionConfirmation });

    await expect(executor.execute('session.restore', restore, {
        ...home, surface, defaultSessionId: sessionId, sessionListAccess: 'current_session',
        actionCaller: { kind: 'session', sessionId, starterDepth: 0, turnDepth: 0 },
    })).resolves.toMatchObject({ ok: false, errorCode: 'action_disabled' });
    expect(presentUserActionConfirmation).not.toHaveBeenCalled();
    expect(network.requests.filter(request => request.method === SESSION_RPC_METHODS.SESSION_RESTORE)).toEqual([]);
});
