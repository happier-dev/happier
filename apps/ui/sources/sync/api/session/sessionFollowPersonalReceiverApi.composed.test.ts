import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { SessionMessageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { SESSION_FOLLOW_SOURCE_PROJECTION_MAX_PAGE_ROWS_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowSourceProjectionV1';
import { AuthTokenProvenanceSchema } from '@happier-dev/protocol/auth/authToken';
import { createPlainSessionByIdResponseFixture, createLockedEncryptedSessionByIdResponseFixture,
    createSessionAccessFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createHomeGovernanceHarness, createAccountTokenForTests, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { standardCleanup } from '@/dev/testkit';

const homes = createHomeGovernanceHarness();
const boundary = { ...homes, request: createSessionReadBatchFetchBoundary(homes.request) };
installHomeGovernanceBoundaries(boundary);
installDisconnectedServerSocketBoundary();
const { getStorage } = await import('@/sync/domains/state/storage');
const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { readSessionFollowRuleInputs } = await import('./sessionFollowRulesApi');
const { visitSessionFollowPersonalReceiverOriginals } = await import('./sessionFollowPersonalReceiverApi');
const initial = getStorage().getState();
let restored: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
beforeEach(async () => { await homes.reset(); installHomeGovernanceBoundaries(boundary); });
afterEach(async () => { await standardCleanup(); await restored?.dispose(); restored = undefined; getStorage().setState(initial, true); });

async function prepare(locked = false) {
    const serverUrl = 'https://follow-personal-reader.test';
    const serverId = await homes.addHome({ name: 'Receiver', serverUrl, accountId: 'alice', currentAccount: true });
    const source = createSessionFixture({ id: 'foreign-source', serverId, ownerAccountId: 'bob',
        origin: { kind: 'direct' }, seq: SESSION_FOLLOW_SOURCE_PROJECTION_MAX_PAGE_ROWS_V1 + 1,
        access: createSessionAccessFixture('view'), ...(locked ? { encryptionMode: 'e2ee', encryptedContentAvailability: 'locked' } : {}) });
    const rule = { ruleId: 'personal-rule', receiver: { kind: 'account' }, version: 0, inception: { createdAt: 1 },
        content: { t: 'plain', v: { v: 1, enabled: true, policy: { preset: 'everything' },
            filter: normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: [serverId], scope: 'all_accessible', startedBy: [] }) } } };
    homes.answer(serverId, '/v2/sessions/query', { body: { sessions: [], hasNext: false, nextCursor: null,
        attentionHasNext: false, attentionNextCursor: null } });
    homes.answer(serverId, '/v2/sessions', { body: { sessions: [], hasNext: false, nextCursor: null } });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [rule] } });
    homes.answer(serverId, '/v2/account/session-follow-preferences', { body: { assigned: false, direct: false, team: false, group: false } });
    const response = locked ? await createLockedEncryptedSessionByIdResponseFixture(source) : createPlainSessionByIdResponseFixture(source);
    homes.answer(serverId, `/v2/sessions/${source.id}`, { body: { session: { ...response.session, ownerAccountId: 'bob' } } });
    const rows = Array.from({ length: source.seq }, (_, index) => SessionMessageV1Schema.parse({
        id: `original-${index + 1}`, localId: `original-local-${index + 1}`, seq: index + 1, createdAt: index + 10, messageRole: 'agent',
        content: { t: 'plain', v: { role: 'agent', content: { type: 'acp', agentId: 'codex', data: {
            type: index === source.seq - 1 ? 'message' : 'reasoning', message: 'Committed source text',
        } } } },
    }));
    const pageRequests: URL[] = [];
    homes.answer(serverId, `/v1/sessions/${source.id}/messages`, { select: (_input, request) => {
        const url = new URL(request.url); pageRequests.push(url);
        const afterSeq = Number(url.searchParams.get('afterSeq'));
        const messages = rows.filter(row => row.seq > afterSeq).slice(0, Number(url.searchParams.get('limit')));
        const throughSeq = messages.at(-1)?.seq ?? afterSeq;
        return { body: { messages, hasMore: throughSeq < source.seq, nextAfterSeq: throughSeq < source.seq ? throughSeq : null } };
    } });
    homes.answer(serverId, `POST /v2/sessions/${source.id}/follows/occurrence-routes`, { body: {
        ok: true, v: 1, sourceSessionId: source.id, routes: [], originalCreatedAt: 10,
        receiverEvaluation: { ownerAccountId: 'bob', production: 'source' },
    } });
    restored = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, request: boundary.request });
    await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Missing fixture Account lifetime');
    const snapshot = await readSessionFollowRuleInputs(serverId);
    if (snapshot.status !== 'ready') throw new Error(snapshot.reason);
    return { serverId, source, snapshot, lifetime, pageRequests };
}

it('traverses real ascending original pages and never reloads private definitions per occurrence', async () => {
    const fixture = await prepare();
    const visited: number[] = [];
    const privateReads = () => homes.requests.filter(request => request.path === '/v2/account/session-follow-rules').length;
    const before = privateReads();
    await visitSessionFollowPersonalReceiverOriginals({ ...fixture, sourceSessionIds: [fixture.source.id], onOccurrence: async value => {
        if ('sourceMessage' in value.original) visited.push(value.original.sourceMessage.seq);
        expect(value.evidence).toMatchObject({ ownerAccountId: 'bob', event: { kind: 'message' } });
        expect(value.isRepresentedInInbox([{ preset: 'everything' }])).toBe(false);
        return true;
    } });
    expect(visited).toEqual([fixture.source.seq]);
    expect(fixture.pageRequests.map(url => Number(url.searchParams.get('afterSeq'))))
        .toEqual([0, SESSION_FOLLOW_SOURCE_PROJECTION_MAX_PAGE_ROWS_V1]);
    expect(fixture.pageRequests.every(url => url.searchParams.get('scope') === 'all')).toBe(true);
    expect(privateReads()).toBe(before);
});

it.each(['account', 'credentials', 'mode'] as const)('refuses a private snapshot from another %s before reading source bodies', async mismatch => {
    const fixture = await prepare();
    const snapshot = { ...fixture.snapshot, ...(mismatch === 'account' ? { accountId: 'bob' }
        : mismatch === 'credentials' ? { credentialScopeKey: 'retired-credentials' } : { mode: 'e2ee' as const }) };
    const onOccurrence = vi.fn(async () => true);
    await expect(visitSessionFollowPersonalReceiverOriginals({ ...fixture, snapshot, sourceSessionIds: [fixture.source.id], onOccurrence })).rejects.toThrow();
    expect(fixture.pageRequests).toHaveLength(0);
    expect(onOccurrence).not.toHaveBeenCalled();
});

it('does not open source bodies or produce an occurrence without that encrypted source key', async () => {
    const fixture = await prepare(true);
    const onOccurrence = vi.fn(async () => true);
    await visitSessionFollowPersonalReceiverOriginals({ ...fixture, sourceSessionIds: [fixture.source.id], onOccurrence });
    expect(fixture.pageRequests).toHaveLength(0);
    expect(onOccurrence).not.toHaveBeenCalled();
});

it('retires receiver evaluation when the installed Account credential becomes a restricted runtime credential', async () => {
    const fixture = await prepare();
    const provenance = AuthTokenProvenanceSchema.parse({ v: 1, kind: 'ephemeral_session_runner', authority: 'session_runtime' });
    const token = `e30.${Buffer.from(JSON.stringify({ sub: 'alice', provenance })).toString('base64url')}.signature`;
    const privateReads = homes.requests.filter(request => request.path === '/v2/account/session-follow-rules').length;
    expect(await TokenStorage.setCredentialsForServerUrl('https://follow-personal-reader.test', { serverId: fixture.serverId }, { token })).toBe(true);
    const onOccurrence = vi.fn(async () => true);
    await expect(visitSessionFollowPersonalReceiverOriginals({ ...fixture, sourceSessionIds: [fixture.source.id], onOccurrence })).rejects.toThrow();
    expect(fixture.pageRequests).toHaveLength(0);
    expect(onOccurrence).not.toHaveBeenCalled();
    expect(homes.requests.filter(request => request.path === '/v2/account/session-follow-rules')).toHaveLength(privateReads);
});

it('stops a source prefix when its current original admission is refused', async () => {
    const fixture = await prepare();
    homes.answer(fixture.serverId, `POST /v2/sessions/${fixture.source.id}/follows/occurrence-routes`, {
        body: { ok: false, v: 1, error: 'forbidden' },
    });
    const onOccurrence = vi.fn(async () => true);
    await visitSessionFollowPersonalReceiverOriginals({ ...fixture, sourceSessionIds: [fixture.source.id], onOccurrence });
    expect(onOccurrence).not.toHaveBeenCalled();
});

it('reads a foreign current request original through the canonical transcript request reader when recipient state is private', async () => {
    const fixture = await prepare();
    const source = createSessionFixture({ ...fixture.source, active: true, seq: 2, agentStateVersion: 3,
        pendingUserActionRequestCount: 1, pendingPermissionRequestCount: 1, pendingRequestObservedAt: 20 });
    const response = createPlainSessionByIdResponseFixture(source);
    expect(response.session.agentState).toBeNull();
    homes.answer(fixture.serverId, `/v2/sessions/${source.id}`, { body: { session: { ...response.session, ownerAccountId: 'bob' } } });
    const row = SessionMessageV1Schema.parse({ id: 'request-original', seq: 1, localId: 'request-local', createdAt: 10,
        messageRole: 'agent', content: { t: 'plain', v: { role: 'agent', content: { type: 'codex', data: {
            type: 'tool-call', callId: 'question', name: 'AskUserQuestion',
            input: { permissionId: 'question', status: 'pending', questions: [{ question: 'Choose a direction' }] },
        } } } } });
    const approval = SessionMessageV1Schema.parse({ ...row, id: 'approval-original', localId: 'approval-local', seq: 2, createdAt: 20,
        content: { t: 'plain', v: { role: 'agent', content: { type: 'codex', data: {
            type: 'tool-call', callId: 'approval', name: 'Bash', input: { permissionId: 'approval', status: 'pending' },
        } } } } });
    homes.answer(fixture.serverId, `/v1/sessions/${source.id}/messages`, { body: {
        messages: [row, approval], hasMore: false, nextAfterSeq: null, nextBeforeSeq: null,
    } });
    const requests: string[] = [];
    let batches = 0;
    await visitSessionFollowPersonalReceiverOriginals({ ...fixture, sourceSessionIds: [source.id], onOccurrence: async value => {
        if ('sourceRequests' in value.original) {
            batches++;
            expect(value.original.requestEvidence).toEqual(expect.arrayContaining([
                expect.objectContaining({ requestId: 'question', evidence: expect.objectContaining({ event: { kind: 'needs_you', type: 'decision' } }) }),
                expect.objectContaining({ requestId: 'approval', evidence: expect.objectContaining({ event: { kind: 'needs_you', type: 'approval' } }) }),
            ]));
            requests.push(...value.original.sourceRequests.requests.map(request => request.requestId));
        }
        return true;
    } });
    expect(requests.sort()).toEqual(['approval', 'question']);
    expect(batches).toBe(1);
});
