import { createSessionListSourceFixture } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createPlainSessionByIdResponseFixture, createPlainSessionCurrentProjectionRecordFixture, createSessionAccessFixture, createSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import { RoleActionInputSchemasV1, RoleActionOutputSchemasV1 } from '@happier-dev/protocol/prompts/roles/roleActionsV1';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { resolveSessionFollowActionRequest } from '@happier-dev/protocol/sessions/follow/actionTransport';
import { DiscussionParticipantsListResponseV1Schema } from '@happier-dev/protocol/discussions/participants';
import { ListSessionFollowSourcesResponseSchema } from '@happier-dev/protocol/sessions/follow/sessionFollowSourcesApi';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { getStorage } = await import('@/sync/domains/state/storage');
const { buildSessionListRenderableFromSession } = await import('@/sync/domains/session/listing/sessionListRenderable');
const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
const initial = getStorage().getState();
let restored: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
beforeEach(async () => { await homes.reset(); });
afterEach(async () => {
    await restored?.dispose(); restored = undefined;
    getStorage().setState(initial, true); standardCleanup();
});

it('resolves rule Session followers through the captured own-Account census and excludes private people', async () => {
    const serverUrl = 'https://follow-targets.test';
    const serverId = await homes.addHome({ name: 'Followers', serverUrl, accountId: 'alice', currentAccount: true });
    restored = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
        request: createSessionReadBatchFetchBoundary(homes.request) });
    await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
    const sessions = ['source', 'rule-receiver', 'direct-receiver'].map(id => createSessionFixture({ id, serverId,
        encryptionMode: 'plain', access: createSessionAccessFixture('view') }));
    getStorage().setState({ isDataReady: true,
        sessions: Object.fromEntries(sessions.map(session => [session.id, session])),
        sessionListRowsByServerId: { [serverId]: Object.fromEntries(sessions.map(session => [session.id, buildSessionListRenderableFromSession(session)])) },
        ordinarySessionListMembershipByServerId: { [serverId]: sessions.map(session => session.id) },
    });
    for (const session of sessions) homes.answer(serverId, `/v2/sessions/${session.id}`, { body: createPlainSessionByIdResponseFixture(session) });
    homes.answer(serverId, '/v2/sessions/source/follows/followers', { body: {
        follows: [], sources: [{ sourceSessionId: 'source', destinationSessionId: 'direct-receiver', relation: 'follower',
            policy: { preset: 'quiet' }, deliveryState: 'eligible', hasPendingUpdates: false }], rules: [], coverage: 'complete', peopleCount: 3,
    } });
    homes.answer(serverId, '/v2/sessions/query', { body: createSessionListSourceFixture({
        sessions: [{ ...createPlainSessionCurrentProjectionRecordFixture({ id: 'source' }), viewer: createSessionViewerFixture() }],
        hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null,
    }) });
    const definition = { v: 1, enabled: true, filter: normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: [serverId],
        scope: 'all_accessible', startedBy: ['you', 'agents', 'triggers'] }), policy: { preset: 'quiet' } };
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [
        { ruleId: 'personal', receiver: { kind: 'account' }, version: 0, content: { t: 'plain', v: definition } },
        { ruleId: 'self', receiver: { kind: 'session', sessionId: 'source' }, version: 0, content: { t: 'plain', v: definition } },
        { ruleId: 'coordinator', receiver: { kind: 'session', sessionId: 'rule-receiver' }, version: 0, content: { t: 'plain', v: definition } },
    ] } });
    const executor = createDefaultActionExecutor();
    const result = await executor.execute('session.status.get', {
        sessionId: { selector: 'followers', of: 'source' },
    }, { surface: 'ui', serverId, expectedAccountId: 'alice' });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { kind: 'fanout', results: [
        { target: { serverId, sessionId: 'direct-receiver' }, result: { ok: true } },
        { target: { serverId, sessionId: 'rule-receiver' }, result: { ok: true } },
    ] } });
    const context = { surface: 'ui' as const, serverId, defaultSessionId: 'source', expectedAccountId: 'alice' };
    expect(await executor.previewSessionTargets({ selector: 'followers' }, context)).toMatchObject({
        coverage: 'complete', addresses: [{ serverId, sessionId: 'direct-receiver' }, { serverId, sessionId: 'rule-receiver' }],
    });
    const followingRequest = resolveSessionFollowActionRequest('follow.list', {
        direction: 'following', receiver: { kind: 'session', sessionId: 'source' },
    });
    homes.answer(serverId, followingRequest.path, { body: ListSessionFollowSourcesResponseSchema.parse({ sources: [{
        sourceSessionId: 'upstream', destinationSessionId: 'source', relation: 'follower',
        policy: { preset: 'quiet' }, deliveryState: 'eligible', hasPendingUpdates: false,
    }] }) });
    expect(await executor.previewSessionTargets({ selector: 'following' }, context)).toMatchObject({
        coverage: 'complete', addresses: [{ serverId, sessionId: 'upstream' }],
    });
    homes.answer(serverId, '/v1/discussions/review/participants', { body: DiscussionParticipantsListResponseV1Schema.parse({
        discussionId: 'review', ownerAccountId: 'alice', access: 'owner', grants: [], participants: [{
            participant: { kind: 'session', sessionId: 'reviewer' }, answerPolicy: 'when_addressed', createdAt: 1,
        }],
    }) });
    expect(await executor.previewSessionTargets({ selector: 'discussion', discussionId: 'review' }, context)).toMatchObject({
        coverage: 'complete', addresses: [{ serverId, sessionId: 'reviewer' }],
    });
    homes.answer(serverId, '/v2/sessions/rule-receiver', { status: 404, body: { error: 'session_not_found' } });
    const receiverReadsBeforeDenial = homes.requests.filter(request => request.path.split('?')[0] === '/v2/sessions/rule-receiver').length;
    const directEffectsBeforeDenial = homes.requests.filter(request => request.path.split('?')[0] === '/v2/sessions/direct-receiver').length;
    expect(await executor.execute('session.status.get', { sessionId: { selector: 'followers', of: 'source' } },
        { surface: 'ui', serverId, expectedAccountId: 'alice' })).toMatchObject({ ok: false,
        errorCode: 'session_target_unavailable', details: { cause: 'follow_receiver_unavailable' } });
    // Only the preparation access read runs; the status effect never starts.
    expect(homes.requests.filter(request => request.path.split('?')[0] === '/v2/sessions/rule-receiver'))
        .toHaveLength(receiverReadsBeforeDenial + 1);
    expect(homes.requests.filter(request => request.path.split('?')[0] === '/v2/sessions/direct-receiver'))
        .toHaveLength(directEffectsBeforeDenial);
    homes.answer(serverId, '/v2/sessions/rule-receiver', { body: createPlainSessionByIdResponseFixture(sessions[1]!) });
    homes.answer(serverId, '/v2/account/session-follow-rules', { status: 403, body: { error: 'credential_scope_denied' } });
    expect(await executor.execute('session.status.get', { sessionId: { selector: 'followers', of: 'source' } },
        { surface: 'ui', serverId, expectedAccountId: 'alice' })).toMatchObject({ ok: false, errorCode: 'session_target_unavailable' });
});

it('previews unloaded manager and worker targets without executing an Action, and refuses incomplete readers', async () => {
    const serverUrl = 'https://picker-targets.test';
    const serverId = await homes.addHome({ name: 'Picker', serverUrl, accountId: 'alice', currentAccount: true });
    restored = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
        request: createSessionReadBatchFetchBoundary(homes.request) });
    await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
    getStorage().setState({ sessions: {}, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {} });
    const source = createSessionFixture({ id: 'source', serverId, encryptionMode: 'plain',
        manager: { sessionId: 'unloaded-manager' }, access: createSessionAccessFixture('view') });
    homes.answer(serverId, '/v2/sessions/source', { body: createPlainSessionByIdResponseFixture(source) });
    const worker = { ...createPlainSessionCurrentProjectionRecordFixture({ id: 'unloaded-worker',
        manager: { sessionId: 'source' } }), viewer: createSessionViewerFixture() };
    homes.answer(serverId, '/v2/sessions/query', { body: createSessionListSourceFixture({
        sessions: [worker], hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null,
    }) });
    const executor = createDefaultActionExecutor();
    const context = { surface: 'ui' as const, serverId, defaultSessionId: 'source', expectedAccountId: 'alice' };
    const requestsBefore = homes.requests.length;
    expect(await executor.previewSessionTargets({ selector: 'manager' }, context)).toMatchObject({
        coverage: 'complete', addresses: [{ serverId, sessionId: 'unloaded-manager' }], error: null,
    });
    expect(await executor.previewSessionTargets({ selector: 'workers' }, context)).toMatchObject({
        coverage: 'complete', addresses: [{ serverId, sessionId: 'unloaded-worker' }], error: null,
    });
    // A missing continuation cannot be advertised as either all workers or no workers.
    homes.answer(serverId, '/v2/sessions/query', { body: createSessionListSourceFixture({
        sessions: [worker], hasNext: true, nextCursor: null, attentionHasNext: false, attentionNextCursor: null,
    }) });
    expect(await executor.previewSessionTargets({ selector: 'workers' }, context)).toMatchObject({
        coverage: 'unavailable', addresses: [], error: 'session_target_unavailable',
    });
    homes.answer(serverId, '/v2/sessions/source', { status: 503, body: { error: 'unavailable' } });
    expect(await executor.previewSessionTargets({ selector: 'manager' }, context)).toMatchObject({
        coverage: 'unavailable', addresses: [], error: 'session_target_unavailable',
    });
    expect(homes.requests.slice(requestsBefore).filter(request => request.input !== null
        && !['/v2/sessions/query', '/v2/sessions/read-batch', '/v1/account/project-rows/list']
            .includes(request.path.split('?')[0]!)).map(request => request.path)).toEqual([]);
});

it('resolves role and Notes selectors through the captured Home and exact Session RPC adapter', async () => {
    const serverUrl = 'https://role-targets.test';
    const serverId = await homes.addHome({ name: 'Role targets', serverUrl, accountId: 'alice', currentAccount: true });
    const outgoing: Array<{ method: string; input: unknown; serverUrl: string | undefined }> = [];
    restored = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
        request: createSessionReadBatchFetchBoundary(homes.request),
        configureSocket: (socket, targetServerUrl) => {
            configureConnectedServerSocketBoundary(socket);
            socket.timeout = vi.fn<typeof socket.timeout>(() => socket);
            socket.emitWithAck = vi.fn<typeof socket.emitWithAck>(async (event, payload) => {
                if (event !== SOCKET_RPC_EVENTS.CALL) return { v: 1, ok: true, admittedSessionIds: [] };
                if (!payload || typeof payload !== 'object' || !('method' in payload)
                    || typeof payload.method !== 'string' || !('params' in payload)) throw new Error('Malformed Session RPC');
                const actionId = payload.method.endsWith(':session.role.set') ? 'session.role.set'
                    : payload.method.endsWith(':session.notes.set') ? 'session.notes.set' : null;
                if (!actionId) throw new Error('Unexpected Session RPC');
                const input = RoleActionInputSchemasV1[actionId].parse(payload.params);
                outgoing.push({ method: payload.method, input, serverUrl: targetServerUrl });
                return { ok: true, result: RoleActionOutputSchemasV1[actionId].parse({ updated: true }) };
            });
        } });
    await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
    getStorage().setState({ sessions: {}, sessionListRowsByServerId: {}, ordinarySessionListMembershipByServerId: {} });
    for (const session of [
        createSessionFixture({ id: 'source', serverId, encryptionMode: 'plain', manager: { sessionId: 'manager' } }),
        createSessionFixture({ id: 'manager', serverId, encryptionMode: 'plain', active: true }),
        createSessionFixture({ id: 'worker', serverId, encryptionMode: 'plain', active: true, manager: { sessionId: 'source' } }),
    ]) homes.answer(serverId, `/v2/sessions/${session.id}`, { body: createPlainSessionByIdResponseFixture(session) });
    let workers = ['worker'];
    const queries: Array<{ underSessionId?: string }> = [];
    homes.answer(serverId, '/v2/sessions/query', { select: raw => {
        const query = SessionListQueryV1Schema.parse(raw);
        queries.push(query);
        return { body: createSessionListSourceFixture({
            sessions: query.underSessionId === 'source' ? workers.map(id => ({
                ...createPlainSessionCurrentProjectionRecordFixture({ id, manager: { sessionId: 'source' } }),
                viewer: createSessionViewerFixture(),
            })) : [],
            hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null,
        }) };
    } });
    const executor = createDefaultActionExecutor();
    const context = { surface: 'ui' as const, serverId, defaultSessionId: 'source', expectedAccountId: 'alice' };
    expect(await executor.execute('session.role.set', { sessionId: { selector: 'manager' }, roleId: 'builder' }, context))
        .toEqual({ ok: true, result: { updated: true } });
    expect(await executor.execute('session.notes.set', { sessionId: { selector: 'workers' }, notes: 'Verify before reporting.' }, context))
        .toEqual({ ok: true, result: { updated: true } });
    expect(outgoing).toEqual([
        { method: 'manager:session.role.set', input: { sessionId: 'manager', roleId: 'builder' }, serverUrl },
        { method: 'worker:session.notes.set', input: { sessionId: 'worker', notes: 'Verify before reporting.' }, serverUrl },
    ]);
    expect(queries.some(query => query.underSessionId === 'source')).toBe(true);
    for (const selected of [[], ['worker', 'other-worker']]) {
        workers = selected;
        expect(await executor.execute('session.notes.set', { sessionId: { selector: 'workers' }, notes: 'Choose exactly one.' }, context))
            .toMatchObject({ ok: false, errorCode: 'session_target_cardinality_mismatch',
                details: { expected: 'one', actualCount: workers.length } });
    }
    expect(outgoing).toHaveLength(2);
});
