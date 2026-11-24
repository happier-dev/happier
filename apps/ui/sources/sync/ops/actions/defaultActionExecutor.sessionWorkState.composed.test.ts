import { afterAll, beforeEach, expect, it } from 'vitest';
import { SESSION_RPC_METHODS, RPC_ERROR_CODES } from '@happier-dev/protocol/rpc';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installSessionOpsNetworkBoundary } from '@/dev/testkit/harness/sessionOpsNetworkBoundary';
import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';

const homes = createHomeGovernanceHarness();
const network = await installSessionOpsNetworkBoundary();
installHomeGovernanceBoundaries(homes);
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');

beforeEach(async () => {
    network.resetRequests();
    await homes.reset();
    installHomeGovernanceBoundaries(homes);
});
afterAll(async () => {
    await homes.reset();
    network.dispose();
});

it('returns the Session owner’s work state and preserves Home’s typed refusal', async () => {
    const accountId = 'work-state-reader';
    const serverId = await homes.addHome({ name: 'Work state Home', serverUrl: 'https://work-state.test',
        accountId, currentAccount: true, accountEncryptionMode: 'plain' });
    const visible = 'visible-session';
    const hidden = 'hidden-session';
    const workState = { v: 1, backendId: 'codex', updatedAt: 1, items: [
        { id: 'task', kind: 'task', origin: 'happier', title: 'Review changes', status: 'active', updatedAt: 1 },
    ] };
    homes.answer(serverId, `GET /v2/sessions/${visible}`, {
        body: createPlainSessionByIdResponseFixture(createSessionFixture({ id: visible, encryptionMode: 'plain' })),
    });
    homes.answer(serverId, `GET /v2/sessions/${hidden}`, {
        body: createPlainSessionByIdResponseFixture(createSessionFixture({ id: hidden, encryptionMode: 'plain',
            access: createSessionAccessFixture('view', { readTranscript: false }) })),
    });
    network.setRpcAckResponder(async ({ targetId, method }) => {
        expect(method).toBe(SESSION_RPC_METHODS.SESSION_WORK_STATE_GET);
        return targetId === visible ? { ok: true, result: { workState } }
            : { ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN, error: 'Access denied' };
    });
    const execute = (sessionId: string) => createDefaultActionExecutor().execute('session.work_state.get', { sessionId },
        { surface: 'ui', serverId, expectedAccountId: accountId });

    expect(await execute(visible)).toEqual({ ok: true, result: { workState } });
    expect(await execute(hidden)).toMatchObject({ ok: false, errorCode: RPC_ERROR_CODES.FORBIDDEN });
});
