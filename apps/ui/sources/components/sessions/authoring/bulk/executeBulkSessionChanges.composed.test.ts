import { afterEach, expect, it } from 'vitest';
import { SESSION_MESSAGE_SEND_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { bindExternalActionExecutionAuthorizationHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { planExistingSessionChanges } from '@happier-dev/protocol/sessions/authoring/existingSessionPlanner';
import { createPlainSessionByIdResponseFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createExternalActionAccountHttpBoundary } from '@/dev/testkit/harness/externalActionAccountHttpBoundary';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createFrontDoorActionExecute } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { executeBulkSessionChanges, type BulkSessionChangeRow } from './executeBulkSessionChanges';

const homes = createHomeGovernanceHarness();
const request = createSessionReadBatchFetchBoundary(homes.request);
installHomeGovernanceBoundaries({ ...homes, request });
await loadSyncSingletonForTests();
await import('@/sync/ops/actions/defaultActionExecutor');
afterEach(async () => { await homes.reset(); });

it('admits one mixed-Home draft through each recipient Home and publishes each result once', async () => {
    const actionId = SESSION_MESSAGE_SEND_ACTION_ID_V1;
    const path = `/v1/actions/${actionId}`;
    const draft = 'Hello from bulk Compose';
    const targets = [];
    const expectedRequests = [];
    const delivered: unknown[] = [];
    const sendRequests: { target: BulkSessionChangeRow['target']; accountId: string; requestId: string | undefined }[] = [];
    for (const [accountId, sessionIds] of [['alice', ['shared-id', 'alice-peer']], ['bob', ['shared-id']]] as const) {
        const serverUrl = `https://bulk-${accountId}.test`;
        const serverIdentityId = `srv_bulk_${accountId}`;
        const serverId = await homes.addHome({ name: accountId, serverUrl, accountId,
            serverIdentityId, currentAccount: true, active: accountId === 'alice' });
        const machineId = `${accountId}-machine`;
        const token = createAccountTokenForTests(accountId, { currentAccount: true });
        const receiver = await createExternalActionAccountHttpBoundary({
            serverUrl, serverIdentityId, accountId, machineId, actionId, tokenEpoch: 0,
            execute: (input, { target, requestHeaders, requestId }) => {
                delivered.push({ serverUrl, target, input, usedHomeCredential: requestHeaders.get('authorization') === `Bearer ${token}` });
                if (typeof input === 'object' && input && 'sessionId' in input && typeof input.sessionId === 'string') {
                    sendRequests.push({ target: { serverId, sessionId: input.sessionId }, accountId, requestId });
                }
                return { status: 'accepted', localId: 'accepted-draft' };
            },
        });
        homes.answer(serverId, `/v1/machines/${machineId}`, { body: { machine: receiver.machine } });
        for (const sessionId of sessionIds) {
            const session = createSessionFixture({ id: sessionId, active: true,
                metadata: { ...createSessionFixture().metadata, path: '/repo', host: 'test', machineId, flavor: 'codex' } });
            homes.answer(serverId, `/v2/sessions/${sessionId}`, { body: createPlainSessionByIdResponseFixture(session) });
            targets.push({ address: { serverId, sessionId }, machineId, agentId: 'codex' });
            expectedRequests.push({ serverUrl, usedHomeCredential: true, target: { kind: 'machine', machineId },
                input: { sessionId, message: draft } });
        }
        for (const route of [path, bindExternalActionExecutionAuthorizationHttpPathV1(actionId)]) {
            homes.answer(serverId, `POST ${route}`, { select: async (_body, { url, init }) => {
                const response = await receiver.handle(new URL(url), init);
                if (!response) throw new Error(`No fixture response for ${route}`);
                return { status: response.status, body: await response.json() };
            } });
        }
    }
    const executeConfirmed = createFrontDoorActionExecute().confirmed;
    const context = { serverId: targets[0]!.address.serverId, surface: 'ui' } as const;
    const submit = (recipients: typeof targets, callbacks?: Pick<Parameters<typeof executeBulkSessionChanges>[0], 'onResult' | 'onSendStarted'>) =>
        executeBulkSessionChanges({ plan: planExistingSessionChanges({}, recipients, draft), executeConfirmed, context, ...callbacks });
    const expectedRows = targets.map(({ address }) => expect.objectContaining({ target: address, state: 'sent' }));
    const control = await submit(targets.slice(0, 2));
    expect(control, JSON.stringify({ control, paths: homes.requests.map(entry => entry.path) })).toEqual(expectedRows.slice(0, 2));
    delivered.length = 0;
    sendRequests.length = 0;
    const updates: unknown[] = [];
    const pending: BulkSessionChangeRow[] = [];
    const results = await submit(targets, { onResult: row => updates.push(row), onSendStarted: row => pending.push(row) });

    expect(results, JSON.stringify(results)).toHaveLength(expectedRows.length);
    expect(results).toEqual(expect.arrayContaining(expectedRows));
    expect(updates).toHaveLength(expectedRows.length);
    expect(updates).toEqual(expect.arrayContaining(expectedRows));
    expect(pending).toHaveLength(expectedRows.length);
    expect(pending).toEqual(expect.arrayContaining(sendRequests.map(({ target, requestId, accountId }) =>
        expect.objectContaining({ target, state: 'applying', sendRequest: { requestId, accountId } }))));
    expect(delivered).toHaveLength(expectedRequests.length);
    expect(delivered).toEqual(expect.arrayContaining(expectedRequests.map(expected => expect.objectContaining({
        ...expected, input: expect.objectContaining(expected.input),
    }))));
});
