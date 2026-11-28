import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID, buildSessionFollowReceiverChangeEntityIdV1 } from '@happier-dev/protocol/sessions/follow/changes';
import type { ChangeEntry } from '@happier-dev/protocol/changes';
import type { FollowDeliveryMuteScopeV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { decodeV2SessionListCursorV1, encodeV2SessionListCursorV1 } from '@happier-dev/protocol/sessions/listing/cursor';
import { SESSION_LIST_PAGE_DEFAULT_LIMIT, SESSION_LIST_PAGE_MAX_LIMIT, SessionListQueryV1Schema } from '@happier-dev/protocol/sessions/listing/query';
import { SessionReadBatchRequestV1Schema } from '@happier-dev/protocol/sessions/read/sessionReadBatchV1';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { ABSENT_SESSION_FOLLOW_FACTS_V1 } from '@happier-dev/protocol/sessions/follow/accountFollow';
import { SESSION_FOLLOW_ZERO_FRONTIER_V1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import { SessionFollowPersonalProgressRequestV1Schema } from '@happier-dev/protocol/sessions/follow/sessionFollowRuleV1';
import { createSessionListSourceFixture, createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';

import { act, createDeferred, flushHookEffects, renderHook, standardCleanup } from '@/dev/testkit';
import { createAccountTokenForTests, createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';

const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
installDisconnectedServerSocketBoundary();
const { getStorage } = await import('@/sync/domains/state/storage');
const { ActivityPersonalSessionMembershipProvider, useActivityPersonalSessionMembership } = await import('./activityPersonalSessionMembership');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const initial = getStorage().getState();
const mutePath = '/v2/account/session-delivery-mutes';
const serverUrl = 'https://activity-mute-demand.test';
let restored: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;

beforeEach(async () => { await homes.reset(); });
afterEach(async () => {
    await standardCleanup();
    if (vi.isFakeTimers()) vi.useRealTimers();
    await restored?.dispose();
    restored = undefined;
    getStorage().setState(initial, true);
});

async function prepare(enabled: boolean) {
    const serverId = await homes.addHome({ name: 'Activity', serverUrl, accountId: 'alice', currentAccount: true });
    homes.answer(serverId, '/v2/sessions/query', { body: { sessions: [], hasNext: false, nextCursor: null,
        attentionHasNext: false, attentionNextCursor: null } });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    homes.answer(serverId, '/v2/account/session-follow-preferences', { body: { assigned: true, direct: false, team: false, group: false } });
    homes.answer(serverId, mutePath, { body: { scopes: [] } });
    const signals: (AbortSignal | null | undefined)[] = [];
    restored = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) }, request: async (url, init) => {
            if (new URL(String(url)).pathname === mutePath) signals.push(init?.signal);
            return homes.request(url, init);
        } });
    await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
    const hook = await renderHook(() => useActivityPersonalSessionMembership(), {
        wrapper: ({ children }) => <ActivityPersonalSessionMembershipProvider enabled={enabled}>{children}</ActivityPersonalSessionMembershipProvider>,
    });
    const scopes = () => hook.getCurrent().accountDeliveryMutesByServerId?.[serverId]?.scopes;
    const reads = () => homes.requests.filter(request => request.serverId === serverId && request.path === mutePath).length;
    await vi.waitFor(() => expect(scopes()).toEqual([]));
    if (enabled) await vi.waitFor(() => expect(hook.getCurrent().followRulesByServerId?.[serverId]?.status).toBe('ready'));
    await flushHookEffects();
    return { serverId, hook, scopes, reads, signals };
}

it.each([false, true])('keeps unrelated arrivals at zero mute GETs and refreshes changed policy (Activity enabled: %s)', async enabled => {
    const { serverId, hook, scopes, reads } = await prepare(enabled);
    const baseline = reads();
    expect(baseline).toBe(1);
    await act(async () => {
        for (let index = 0; index < 1_000; index++) {
            // Known domain changes may be coarse: missing ids do not make a Machine or transcript a policy write.
            publishHomeAccountChange(serverId, undefined, { changeKinds: index % 2 ? ['machine'] : ['session'] });
        }
        publishHomeAccountChange(serverId, ['self'], { changeKinds: ['artifact'] });
        publishHomeAccountChange(serverId, ['other-account-setting'], { changeKinds: ['account'] });
        publishHomeAccountChange(serverId, ['access-changed'], { changeKinds: ['share'] });
        publishHomeAccountChange('another-home', [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] });
    });
    await flushHookEffects();
    expect(reads()).toBe(baseline);
    expect(scopes()).toEqual([]);

    const changes: Parameters<typeof publishHomeAccountChange>[] = [
        [serverId, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }],
        [serverId, ['self'], { changeKinds: ['account'] }],
        [serverId, undefined, { changeKinds: ['account'] }],
        [serverId, ['unclassified-source']],
        [serverId, ['unclassified-source'], { source: 'connected', changeKinds: [] }],
    ];
    for (const [index, change] of changes.entries()) {
        const next: FollowDeliveryMuteScopeV1[] = [{ kind: 'sender_session', sessionId: `sender-${index}` }];
        homes.answer(serverId, mutePath, { body: { scopes: next } });
        await act(async () => publishHomeAccountChange(...change));
        await vi.waitFor(() => expect(scopes()).toEqual(next));
        await flushHookEffects();
        expect(reads()).toBe(baseline + index + 1);
    }
    // A genuine refresh is unavailable until current authority has answered; errors never retain an unmuted snapshot.
    homes.answer(serverId, mutePath, { status: 503, body: { error: 'mute_state_unavailable' } });
    await act(async () => publishHomeAccountChange(serverId, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
    await vi.waitFor(() => expect(reads()).toBe(baseline + changes.length + 1));
    await flushHookEffects();
    expect(hook.getCurrent().accountDeliveryMutesByServerId?.[serverId]).toBeNull();
});

it.each(['credentials', 'account'] as const)('withdraws an in-flight mute census on %s retirement', async retirement => {
    const { serverId, hook, scopes, reads, signals } = await prepare(false);
    const release = createDeferred<void>();
    homes.answer(serverId, mutePath, { body: { scopes: [{ kind: 'sender_session', sessionId: 'late-private-source' }] }, respondAfter: release.promise });
    const before = reads();
    await act(async () => publishHomeAccountChange(serverId, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
    await vi.waitFor(() => expect(reads()).toBe(before + 1));
    expect(hook.getCurrent().accountDeliveryMutesByServerId?.[serverId]).toBeNull();
    const pendingSignal = signals.at(-1);
    try {
        await act(async () => {
            if (retirement === 'credentials') await TokenStorage.removeCredentialsForServerUrl(serverUrl, { serverId });
            else getStorage().getState().clearProfileScope();
        });
        await vi.waitFor(() => expect(pendingSignal?.aborted).toBe(true));
    } finally { await act(async () => release.resolve()); }
    await flushHookEffects();
    expect(scopes()).toBeUndefined();
    const after = reads();
    await act(async () => publishHomeAccountChange(serverId, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
    await flushHookEffects();
    expect(reads()).toBe(after);
    expect(scopes()).toBeUndefined();
});

it.each(['credentials', 'account'] as const)('admits a row-only rule candidate only for the active Home and clears it on %s retirement', async retirement => {
    const otherId = await homes.addHome({ name: 'Other rule Home', serverUrl: 'https://other-rule-home.test', accountId: 'alice' });
    const serverId = await homes.addHome({ name: 'Rule corpus', serverUrl, accountId: 'alice', currentAccount: true });
    const features = createRootLayoutFeaturesResponse();
    expect(tryWriteServerEnabledBitInPlace(features, 'sessions.filteredListing', true)).toBe(true);
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    const rule = (home: string, enabled = true) => ({ ruleId: `personal-${home}`, receiver: { kind: 'account' }, version: 0,
        inception: { createdAt: 1 }, content: { t: 'plain', v: { v: 1, enabled, policy: { preset: 'everything' },
            filter: normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: [home], scope: 'all_accessible', startedBy: ['you', 'agents', 'triggers'] }) } } });
    const foreign = createSessionFixture({ id: 'foreign-rule-only', serverId, ownerAccountId: 'bob', encryptionMode: 'plain',
        access: createSessionAccessFixture('view'), viewer: createSessionViewerFixture() });
    const row = { ...createPlainSessionByIdResponseFixture(foreign).session, ownerAccountId: 'bob', viewer: foreign.viewer };
    for (const id of [otherId, serverId]) {
        homes.answer(id, '/v1/features', { body: features });
        homes.answer(id, '/v1/features/authenticated', { body: features });
        primeServerFeaturesSnapshot({ serverId: id, snapshot: { status: 'ready', features } });
        homes.answer(id, '/v2/sessions', { body: { sessions: [], hasNext: false, nextCursor: null } });
        homes.answer(id, '/v2/sessions/query', { select: input => ({ body: createSessionListSourceFixture({
            sessions: id === serverId && input && typeof input === 'object' && 'scope' in input && input.scope === 'all_accessible' ? [row] : [],
            hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null,
        }) }) });
        homes.answer(id, '/v2/account/session-follow-rules', { body: { rules: [rule(id)] } });
        homes.answer(id, '/v2/account/session-follow-preferences', { body: { assigned: false, direct: false, team: false, group: false } });
        homes.answer(id, mutePath, { body: { scopes: [] } });
    }
    restored = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
        configureSocket: configureConnectedServerSocketBoundary, request: createSessionReadBatchFetchBoundary(homes.request) });
    await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
    const { useActivityAttentionSummarySource } = await import('./useActivityAttentionSource');
    const { collectActivitySourceSessionAddresses } = await import('./activitySourceSessionAddresses');
    const hook = await renderHook(() => ({ membership: useActivityPersonalSessionMembership(), source: useActivityAttentionSummarySource() }), {
        wrapper: ({ children }) => <ActivityPersonalSessionMembershipProvider enabled>{children}</ActivityPersonalSessionMembershipProvider>,
    });
    const candidates = () => collectActivitySourceSessionAddresses(hook.getCurrent().source, false);
    await vi.waitFor(() => expect(candidates()).toContainEqual({ serverId, sessionId: foreign.id }));
    expect(hook.getCurrent().membership.membershipByServerId[serverId]).toEqual([]);
    expect(hook.getCurrent().membership.membershipByServerId[otherId]).toEqual([]);
    expect(homes.requests.filter(request => request.serverId === otherId && request.path === '/v2/sessions/query'
        && request.input && typeof request.input === 'object' && 'scope' in request.input && request.input.scope === 'all_accessible')).toHaveLength(0);
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [rule(serverId, false)] } });
    await act(async () => publishHomeAccountChange(serverId, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
    await vi.waitFor(() => expect(candidates()).not.toContainEqual({ serverId, sessionId: foreign.id }));
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [rule(serverId)] } });
    await act(async () => publishHomeAccountChange(serverId, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
    await vi.waitFor(() => expect(candidates()).toContainEqual({ serverId, sessionId: foreign.id }));
    const release = createDeferred<void>();
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [rule(serverId)] }, respondAfter: release.promise });
    const reads = () => homes.requests.filter(request => request.serverId === serverId && request.path === '/v2/account/session-follow-rules').length;
    const before = reads();
    await act(async () => publishHomeAccountChange(serverId, [ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID], { changeKinds: ['account'] }));
    await vi.waitFor(() => expect(reads()).toBe(before + 1));
    try {
        await act(async () => {
            if (retirement === 'credentials') await TokenStorage.removeCredentialsForServerUrl(serverUrl, { serverId });
            else getStorage().getState().clearProfileScope();
        });
    } finally { await act(async () => release.resolve()); }
    await flushHookEffects();
    expect(candidates()).not.toContainEqual({ serverId, sessionId: foreign.id });
    expect(hook.getCurrent().membership.followRulesByServerId?.[serverId]?.status).not.toBe('ready');
});

it.each(['follow', 'rule', 'pending'] as const)('settles a foreign original only when the incumbent Inbox represents it (%s)', async representation => {
    const represented = representation !== 'pending';
    const serverId = await homes.addHome({ name: 'Receiver', serverUrl, accountId: 'alice', currentAccount: true });
    const features = createRootLayoutFeaturesResponse();
    expect(tryWriteServerEnabledBitInPlace(features, 'sessions.filteredListing', true)).toBe(true);
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    const source = createSessionFixture({ id: 'foreign-source', serverId, ownerAccountId: 'bob', seq: 1,
        encryptionMode: 'plain', latestTurnStatus: 'completed', access: createSessionAccessFixture('view'), viewer: createSessionViewerFixture({
            follow: { ...ABSENT_SESSION_FOLLOW_FACTS_V1, follows: representation === 'follow' },
            readState: representation === 'follow' ? { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: 10 } : { state: 'not_started' },
            ...(representation === 'follow' ? { attention: { needsAttention: true, reasons: ['unread' as const], primary: 'unread' as const,
                presentation: 'full' as const } } : {}),
            ...(representation === 'rule' ? { ruleReadStates: [{ ruleId: 'receiver-rule', ruleVersion: 0,
                readState: { state: 'tracking' as const, lastViewedSessionSeq: 0, unreadSince: 1 } }] } : {}),
        }) });
    const ownSource = createSessionFixture({ ...source, id: 'own-source', ownerAccountId: 'alice', access: createSessionAccessFixture('owner') });
    const siblings = represented ? [] : Array.from({ length: 5 }, (_, index) => createSessionFixture({
        ...source, id: `foreign-sibling-${index}`,
    }));
    const offScreen = createSessionFixture({ ...source, id: 'newly-shared-source' });
    const gapSource = createSessionFixture({ ...source, id: 'offline-source' });
    const candidates = [source, ...siblings];
    const readyToDeliver = new Set(represented ? [source.id] : [offScreen.id, gapSource.id]);
    const delivered: { sourceSessionId: string; delivered: typeof SESSION_FOLLOW_ZERO_FRONTIER_V1 }[] = [];
    const rule = { ruleId: 'receiver-rule', receiver: { kind: 'account' }, version: 0, inception: { createdAt: 1 },
        content: { t: 'plain', v: { v: 1, enabled: true, policy: { preset: 'everything' },
            filter: normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: [serverId], scope: 'all_accessible', startedBy: ['you', 'agents', 'triggers'] }) } } };
    homes.answer(serverId, '/v2/sessions', { body: { sessions: [], hasNext: false, nextCursor: null } });
    homes.answer(serverId, '/v2/sessions/query', { select: input => ({ body: createSessionListSourceFixture({
        sessions: input && typeof input === 'object' && 'scope' in input && input.scope === 'all_accessible'
            ? [...candidates, ownSource].map(session => ({ ...createPlainSessionByIdResponseFixture(session).session, ownerAccountId: session.ownerAccountId,
                viewer: session.viewer })) : [],
        hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null,
    }) }) });
    homes.answer(serverId, '/v2/account/session-follow-rules', { select: () => ({ body: { rules: [{ ...rule, sources: delivered }] } }) });
    homes.answer(serverId, '/v2/account/session-follow-preferences', { body: { assigned: false, direct: false, team: false, group: false } });
    homes.answer(serverId, mutePath, { body: { scopes: [] } });
    homes.answer(serverId, '/v2/cursor', { body: { cursor: 0, changesFloor: 0 } });
    let changePage: { changes: ChangeEntry[]; nextCursor: number } = { changes: [], nextCursor: 0 };
    homes.answer(serverId, '/v2/changes', { select: (_input, request) => ({
        body: Number(new URL(request.url).searchParams.get('after')) < changePage.nextCursor
            ? changePage : { changes: [], nextCursor: changePage.nextCursor },
    }) });
    let finishedTurnArrived = false;
    for (const session of [...candidates, ownSource, offScreen, gapSource]) {
        const response = createPlainSessionByIdResponseFixture(session);
        const viewer = session === source && represented ? session.viewer : createSessionViewerFixture({
            follow: { ...ABSENT_SESSION_FOLLOW_FACTS_V1, follows: true },
            readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: 10 },
            attention: { needsAttention: true, reasons: ['unread'], primary: 'unread', presentation: 'full' },
        });
        homes.answer(serverId, `/v2/sessions/${session.id}`, { select: () => ({ body: { session: {
            ...response.session, ownerAccountId: session.ownerAccountId, viewer: readyToDeliver.has(session.id) ? viewer : session.viewer,
            ...(session === source && finishedTurnArrived ? { seq: 2 } : {}),
        } } }) });
        homes.answer(serverId, `/v1/sessions/${session.id}/messages`, { select: (_input, request) => {
            const afterSeq = Number(new URL(request.url).searchParams.get('afterSeq'));
            const messages = [{
                id: 'original-message', localId: 'original-local', seq: 1, createdAt: 10, messageRole: 'agent',
                content: { t: 'plain', v: session === gapSource
                    ? { role: 'agent', content: { type: 'event', id: 'ready-event', data: { type: 'ready', completedTurnId: 'offline-turn' } } }
                    : { role: 'agent', content: { type: 'acp', agentId: 'codex',
                        data: { type: 'message', message: 'Committed update' } } } },
            }];
            if (session === source && finishedTurnArrived) messages.push({
                id: 'new-terminal-message', localId: 'new-terminal-local', seq: 2, createdAt: 20, messageRole: 'agent',
                content: { t: 'plain', v: { role: 'agent',
                    content: { type: 'event', id: 'new-ready-event', data: { type: 'ready', completedTurnId: 'new-turn' } } } },
            });
            return { body: { messages: messages.filter(message => message.seq > afterSeq), hasMore: false, nextAfterSeq: null } };
        } });
        homes.answer(serverId, `POST /v2/sessions/${session.id}/follows/occurrence-routes`, { body: {
            ok: true, v: 1, sourceSessionId: session.id, routes: [], originalCreatedAt: 10,
            receiverEvaluation: { ownerAccountId: session.ownerAccountId, production: 'source' },
        } });
    }
    let acceptedEffects = 0;
    const progressPath = '/v2/account/session-follow-rules/personal-progress';
    homes.answer(serverId, `POST ${progressPath}`, { select: input => {
        const progress = SessionFollowPersonalProgressRequestV1Schema.parse(input);
        if (!('evaluation' in progress)) throw new Error('Expected receiver progress');
        const index = delivered.findIndex(source => source.sourceSessionId === progress.sourceSessionId);
        const previous = delivered[index]?.delivered ?? SESSION_FOLLOW_ZERO_FRONTIER_V1;
        let next = previous;
        if ('sourceTurn' in progress) {
            if (progress.terminalSourceMessage.seq > previous.readyEventSeq) {
                next = { ...previous, turn: progress.sourceTurn, readyEventSeq: progress.terminalSourceMessage.seq };
            }
        } else if ('sourceMessage' in progress && progress.sourceMessage) {
            if (progress.sourceMessage.seq > previous.transcriptSeq) next = { ...previous, transcriptSeq: progress.sourceMessage.seq };
        } else {
            throw new Error('Expected transcript or terminal Turn progress');
        }
        const alreadyRepresented = next === previous;
        if (!alreadyRepresented) {
            acceptedEffects++;
            const sourceProgress = { sourceSessionId: progress.sourceSessionId, delivered: next };
            if (index < 0) delivered.push(sourceProgress);
            else delivered[index] = sourceProgress;
        }
        return { body: { accepted: true, alreadyRepresented } };
    } });
    restored = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
        configureSocket: configureConnectedServerSocketBoundary,
        request: createSessionReadBatchFetchBoundary(homes.request) });
    await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
    const publications = new Set<ReturnType<typeof useActivityPersonalSessionMembership>>();
    if (!represented) vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const hook = await renderHook(() => {
        const membership = useActivityPersonalSessionMembership();
        publications.add(membership);
        return membership;
    }, {
        wrapper: ({ children }) => <ActivityPersonalSessionMembershipProvider enabled>{children}</ActivityPersonalSessionMembershipProvider>,
    });
    await vi.waitFor(() => expect(hook.getCurrent().followRulesByServerId?.[serverId]?.status).toBe('ready'));
    await vi.waitFor(() => expect(homes.requests.some(request => request.path === '/v2/sessions/query'
        && request.input && typeof request.input === 'object' && 'scope' in request.input && request.input.scope === 'all_accessible')).toBe(true));
    if (represented) {
        await vi.waitFor(() => expect(homes.requests.filter(request => request.path === '/v2/account/session-follow-rules/personal-progress')).toHaveLength(1));
        expect(homes.requests.find(request => request.path === '/v2/account/session-follow-rules/personal-progress')?.input).toMatchObject({
            evaluation: 'receiver', production: 'source', sourceSessionId: source.id,
            rules: [{ ruleId: 'receiver-rule', ruleVersion: 0 }], sourceMessage: { localId: 'original-local', seq: 1 },
        });
    } else {
        await vi.waitFor(() => expect(Object.keys(hook.getCurrent().receiverRuleEvaluationByServerId?.[serverId]?.pendingBySourceSessionId ?? {}).sort())
            .toEqual(candidates.map(session => session.id).sort()));
        await flushHookEffects();
        expect(homes.requests.filter(request => request.path === '/v2/account/session-follow-rules/personal-progress')).toHaveLength(0);
    }
    const coldRoutes = homes.requests.filter(request => request.path.endsWith('/follows/occurrence-routes')).length;
    const readsBefore = homes.requests.length;
    await act(async () => {
        for (let index = 0; index < 1_000; index++) publishHomeAccountChange(serverId, [`machine-${index}`], { changeKinds: ['machine'] });
        publishHomeAccountChange(serverId, [source.id], { changeKinds: ['session'], sessionListQueryAffects: false });
    });
    await flushHookEffects();
    expect(homes.requests.slice(readsBefore).filter(request => request.path === '/v2/account/session-follow-rules')).toHaveLength(0);
    expect(homes.requests.filter(request => request.path === '/v2/account/session-follow-rules/personal-progress')).toHaveLength(represented ? 1 : 0);
    expect(homes.requests.filter(request => request.path.startsWith('/v1/sessions/own-source/messages'))).toHaveLength(0);
    if (!represented) {
        const observed = () => homes.requests.filter(request => request.path.endsWith('/follows/occurrence-routes')).map(request => request.path);
        const queries = () => homes.requests.filter(request => request.path === '/v2/sessions/query');
        const changesSince = (before: number) => observed().slice(before);
        const route = (id: string) => `/v2/sessions/${id}/follows/occurrence-routes`;
        const record = (label: string, before: { routes: number; queries: number }) => {
            const counts = { routes: changesSince(before.routes), queries: queries().length - before.queries };
            console.info('Follow HTTP count', label, counts.routes.length, counts.queries, 'publications', publications.size);
            return counts;
        };
        const mark = () => {
            publications.clear();
            return { routes: observed().length, queries: queries().length };
        };
        expect(hook.getCurrent().membershipByServerId[serverId]).toEqual([]);
        expect(new Set(observed())).toEqual(new Set(candidates.map(session => route(session.id))));
        const exhaustiveQueries = queries().filter(request => request.input && typeof request.input === 'object'
            && 'scope' in request.input && request.input.scope === 'all_accessible');
        console.info('Follow HTTP count cold', coldRoutes, queries().length, 'exhaustive', exhaustiveQueries.length);

        let before = mark();
        await flushHookEffects({ cycles: 1, advanceTimersMs: 60_000 });
        expect.soft(record('settled 60-second idle', before)).toEqual({ routes: [], queries: 0 });

        before = mark();
        await act(async () => publishHomeAccountChange(serverId, undefined, { source: 'connected', changesCatchUp: true }));
        await flushHookEffects();
        expect.soft(record('equal reconnect', before)).toEqual({ routes: [], queries: 0 });
        expect.soft(publications.size).toBe(0);

        before = mark();
        const { invalidateSessionListQueryHome } = await import('@/sync/domains/session/listing/sessionListQueryInvalidation');
        await act(async () => { await invalidateSessionListQueryHome(serverId); });
        await flushHookEffects();
        expect.soft(record('explicit equal refresh', before)).toEqual({ routes: [], queries: 2 });

        before = mark();
        const { sync } = await import('@/sync/syncEngine');
        const runtime = sync as unknown as {
            changesCursor: string | null;
            handleUpdate(update: { id: string; seq: number; createdAt: number; body: { t: 'account-change' } }): Promise<void>;
        };
        changePage = { nextCursor: 1, changes: [{ kind: 'session', entityId: source.id, cursor: 1, changedAt: 11,
            hint: { metadataVersion: 2, followSourceChanged: false, followSourceUnchangedSinceCursor: 0, followReceiverAvailabilityChanged: false } }] };
        await act(async () => runtime.handleUpdate({ id: 'projection-after-send', seq: 1, createdAt: 11, body: { t: 'account-change' } }));
        await vi.waitFor(() => expect(runtime.changesCursor).toBe('1'));
        await flushHookEffects({ cycles: 2, advanceTimersMs: 60_000 });
        expect.soft(record('projection-only echo followed by 60 seconds idle', before)).toEqual({ routes: [], queries: 0 });

        before = mark();
        readyToDeliver.add(source.id);
        changePage = { nextCursor: 3, changes: [{ kind: 'session', entityId: source.id, cursor: 3, changedAt: 13,
            hint: { metadataVersion: 3, followSourceChanged: false, followSourceUnchangedSinceCursor: 2, followReceiverAvailabilityChanged: false } }] };
        await act(async () => runtime.handleUpdate({ id: 'new-original-then-projection', seq: 3, createdAt: 13, body: { t: 'account-change' } }));
        await vi.waitFor(() => expect(runtime.changesCursor).toBe('3'));
        await vi.waitFor(() => expect(acceptedEffects).toBe(1));
        await flushHookEffects();
        expect.soft(record('one changed source', before)).toEqual({ routes: [route(source.id)], queries: 0 });
        const beforeSettledIdle = homes.requests.length;
        await flushHookEffects({ cycles: 1, advanceTimersMs: 60_000 });
        expect(homes.requests.slice(beforeSettledIdle).filter(request =>
            request.path === '/v2/sessions/query' || request.path === '/v2/sessions/read-batch'
            || request.path === '/v2/changes' || request.path.startsWith('/v2/account/settings/history/')
            || request.path.endsWith('/messages') || request.path.endsWith('/follows/occurrence-routes'))).toEqual([]);

        before = mark();
        const beforeShare = homes.requests.length;
        await act(async () => publishHomeAccountChange(serverId, [offScreen.id, siblings[0]!.id], {
            feedPageConsumed: true, changeKinds: ['share', 'machine'], sessionFollowSourceIds: [offScreen.id], sessionListQueryAffects: false,
        }));
        await vi.waitFor(() => expect(acceptedEffects).toBe(2));
        await flushHookEffects();
        expect.soft(record('exact off-screen share', before)).toEqual({ routes: [route(offScreen.id)], queries: 0 });
        expect(homes.requests.slice(beforeShare).filter(request => [
            '/v2/account/session-follow-rules', '/v2/account/session-follow-preferences', mutePath,
        ].includes(request.path))).toHaveLength(0);

        before = mark();
        await act(async () => publishHomeAccountChange(serverId, [ownSource.id], { changeKinds: ['share'], sessionListQueryAffects: true }));
        await vi.waitFor(() => expect(hook.getCurrent().statesByServerId[serverId]?.phase).toBe('ready'));
        await flushHookEffects();
        expect.soft(record('real list invalidation', before)).toEqual({ routes: [], queries: 2 });

        before = mark();
        candidates.push(gapSource);
        await act(async () => publishHomeAccountChange(serverId, undefined, { source: 'snapshot' }));
        await vi.waitFor(() => expect(acceptedEffects).toBe(3));
        await flushHookEffects();
        expect(homes.requests.find(request => request.path === progressPath && request.input && typeof request.input === 'object'
            && 'sourceSessionId' in request.input && request.input.sourceSessionId === gapSource.id)?.input).toMatchObject({
            sourceTurn: { id: 'offline-turn', status: 'completed' }, terminalSourceMessage: { localId: 'original-local', seq: 1 },
        });
        const gap = record('snapshot repair', before);
        expect.soft(gap.routes.filter(path => path === route(gapSource.id))).toHaveLength(1);
        expect.soft(gap.queries).toBe(2);

        before = mark();
        await act(async () => publishHomeAccountChange(serverId, [gapSource.id], { changeKinds: ['session'], sessionListQueryAffects: false }));
        await flushHookEffects();
        expect.soft(record('delivered Turn frontier', before)).toEqual({ routes: [], queries: 0 });

        before = mark();
        finishedTurnArrived = true;
        changePage = { nextCursor: 4, changes: [{ kind: 'account', entityId: buildSessionFollowReceiverChangeEntityIdV1(source.id),
            cursor: 4, changedAt: 14, hint: null }] };
        const turnWake = { id: 'finished-turn-demand', seq: 4, createdAt: 14, body: { t: 'account-change' as const } };
        await act(async () => runtime.handleUpdate(turnWake));
        await vi.waitFor(() => expect(runtime.changesCursor).toBe('4'));
        await vi.waitFor(() => expect(acceptedEffects).toBe(4));
        await flushHookEffects();
        expect.soft(record('one new finished Turn', before)).toEqual({ routes: [route(source.id)], queries: 0 });
        expect(homes.requests.filter(request => request.path === progressPath).at(-1)?.input).toMatchObject({
            sourceTurn: { id: 'new-turn', status: 'completed' }, terminalSourceMessage: { localId: 'new-terminal-local', seq: 2 },
        });

        before = mark();
        await act(async () => runtime.handleUpdate({ ...turnWake, id: 'finished-turn-demand-repeated' }));
        await flushHookEffects({ cycles: 2, advanceTimersMs: 60_000 });
        expect.soft(record('unchanged finished Turn', before)).toEqual({ routes: [], queries: 0 });
        expect(acceptedEffects).toBe(4);
    }
    await act(async () => getStorage().getState().clearProfileScope());
    await flushHookEffects();
    const receiverReads = () => homes.requests.filter(request => request.path.includes('/messages')
        || request.path.includes('/session-follow-rules') || request.path.includes('/follows/occurrence-routes'));
    const retiredReads = receiverReads();
    const retiredQueries = homes.requests.filter(request => request.path === '/v2/sessions/query').length;
    await act(async () => publishHomeAccountChange(serverId, [source.id], { changeKinds: ['session'], sessionListQueryAffects: false }));
    await flushHookEffects();
    expect(receiverReads()).toEqual(retiredReads);
    expect(homes.requests.filter(request => request.path === '/v2/sessions/query')).toHaveLength(retiredQueries);
});

it('keeps personal membership identity when an equal refetch moves only the query lifecycle', async () => {
    const serverId = await homes.addHome({ name: 'Refetch', serverUrl, accountId: 'alice', currentAccount: true });
    const features = createRootLayoutFeaturesResponse();
    expect(tryWriteServerEnabledBitInPlace(features, 'sessions.filteredListing', true)).toBe(true);
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });
    const sessions = ['own-one', 'own-two'].map(id => createSessionFixture({ id, serverId, ownerAccountId: 'alice', seq: 1,
        encryptionMode: 'plain', access: createSessionAccessFixture('owner'), viewer: createSessionViewerFixture() }));
    homes.answer(serverId, '/v2/sessions', { body: { sessions: [], hasNext: false, nextCursor: null } });
    homes.answer(serverId, '/v2/sessions/query', { body: createSessionListSourceFixture({
        sessions: sessions.map(session => ({ ...createPlainSessionByIdResponseFixture(session).session, ownerAccountId: 'alice',
            viewer: session.viewer })),
        hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null,
    }) });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [] } });
    homes.answer(serverId, '/v2/account/session-follow-preferences', { body: { assigned: true, direct: false, team: false, group: false } });
    homes.answer(serverId, mutePath, { body: { scopes: [] } });
    restored = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
        configureSocket: configureConnectedServerSocketBoundary,
        request: createSessionReadBatchFetchBoundary(homes.request) });
    await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
    const membershipIdentities = new Set<object>();
    const hook = await renderHook(() => {
        const membership = useActivityPersonalSessionMembership();
        membershipIdentities.add(membership.membershipByServerId);
        return membership;
    }, {
        wrapper: ({ children }) => <ActivityPersonalSessionMembershipProvider enabled>{children}</ActivityPersonalSessionMembershipProvider>,
    });
    await vi.waitFor(() => expect([...hook.getCurrent().membershipByServerId[serverId] ?? []].sort()).toEqual(['own-one', 'own-two']));
    await vi.waitFor(() => expect(hook.getCurrent().statesByServerId[serverId]?.phase).toBe('ready'));
    await flushHookEffects();
    const before = hook.getCurrent();
    const queryReads = () => homes.requests.filter(request => request.serverId === serverId && request.path === '/v2/sessions/query').length;
    const readsBefore = queryReads();
    membershipIdentities.clear();

    const { invalidateSessionListQueryHome } = await import('@/sync/domains/session/listing/sessionListQueryInvalidation');
    for (let index = 0; index < 3; index++) {
        await act(async () => { await invalidateSessionListQueryHome(serverId); });
        await vi.waitFor(() => expect(hook.getCurrent().statesByServerId[serverId]?.phase).toBe('ready'));
    }
    await flushHookEffects();

    expect(queryReads()).toBe(readsBefore + 3);
    // The lifecycle genuinely moved; the membership facts did not.
    expect(hook.getCurrent().statesByServerId).not.toBe(before.statesByServerId);
    expect(hook.getCurrent().membershipByServerId).toBe(before.membershipByServerId);
    expect([...membershipIdentities]).toEqual([before.membershipByServerId]);
});

it('batches the cold Follow candidate census on a 665-Machine Home and stays quiet once settled', async () => {
    const serverId = await homes.addHome({ name: 'Fleet', serverUrl, accountId: 'alice', currentAccount: true });
    const features = createRootLayoutFeaturesResponse();
    expect(tryWriteServerEnabledBitInPlace(features, 'sessions.filteredListing', true)).toBe(true);
    homes.answer(serverId, '/v1/features', { body: features });
    homes.answer(serverId, '/v1/features/authenticated', { body: features });
    const { primeServerFeaturesSnapshot } = await import('@/sync/api/capabilities/serverFeaturesClient');
    primeServerFeaturesSnapshot({ serverId, snapshot: { status: 'ready', features } });

    const machines = Array.from({ length: 665 }, (_, index) => createPlainMachineRowFixture({
        id: `machine-${index}`, accountId: 'alice',
    }));
    const sessions = machines.map(({ id }, index) => createSessionFixture({
        id: `owned-${index}`, serverId, ownerAccountId: 'alice',
        metadata: { machineId: id }, encryptionMode: 'plain',
        access: createSessionAccessFixture('owner'), viewer: createSessionViewerFixture(),
    }));
    const rows = sessions.map(session => ({
        ...createPlainSessionByIdResponseFixture(session).session, ownerAccountId: 'alice', viewer: session.viewer,
    }));
    for (const row of rows) homes.answer(serverId, `/v2/sessions/${row.id}`, { body: { session: row } });
    homes.answer(serverId, '/v1/machines', { body: machines });
    const emptySessionPage = { sessions: [], hasNext: false, nextCursor: null };
    homes.answer(serverId, '/v2/sessions', { body: emptySessionPage });
    homes.answer(serverId, '/v2/sessions/active', { body: emptySessionPage });
    homes.answer(serverId, '/v2/sessions/query', { select: input => {
        const query = SessionListQueryV1Schema.parse(input);
        const corpus = query.scope === 'all_accessible' ? rows : [];
        const previousId = query.cursor ? decodeV2SessionListCursorV1(query.cursor) : null;
        const offset = previousId ? corpus.findIndex(row => row.id === previousId) + 1 : 0;
        const page = corpus.slice(offset, offset + (query.limit ?? SESSION_LIST_PAGE_DEFAULT_LIMIT));
        const hasNext = offset + page.length < corpus.length;
        return { body: createSessionListSourceFixture({
            sessions: page, hasNext, nextCursor: hasNext ? encodeV2SessionListCursorV1(page.at(-1)!.id) : null,
            attentionHasNext: false, attentionNextCursor: null,
        }) };
    } });
    homes.answer(serverId, '/v2/account/session-follow-rules', { body: { rules: [{
        ruleId: 'fleet-rule', receiver: { kind: 'account' }, version: 0, inception: { createdAt: 1 }, sources: [],
        content: { t: 'plain', v: { v: 1, enabled: true, policy: { preset: 'everything' },
            filter: normalizeSessionListFilterV1({ show: 'sessions', homeServerIds: [serverId],
                scope: 'all_accessible', startedBy: ['you', 'agents', 'triggers'] }) } },
    }] } });
    homes.answer(serverId, '/v2/account/session-follow-preferences', { body: { assigned: false, direct: false, team: false, group: false } });
    homes.answer(serverId, mutePath, { body: { scopes: [] } });
    const batchSizes: number[] = [];
    const request = createSessionReadBatchFetchBoundary(homes.request);
    restored = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
        configureSocket: configureConnectedServerSocketBoundary,
        request: async (url, init) => {
            if (new URL(String(url)).pathname === '/v2/sessions/read-batch' && init?.method === 'POST') {
                const batch = SessionReadBatchRequestV1Schema.parse(JSON.parse(String(init.body)));
                batchSizes.push(batch.sessionIds.filter(id => id.startsWith('owned-')).length);
            }
            return request(url, init);
        } });
    await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
    await vi.waitFor(() => expect(getStorage().getState().machineListByServerId[serverId]).toHaveLength(machines.length));
    const hook = await renderHook(() => useActivityPersonalSessionMembership(), {
        wrapper: ({ children }) => <ActivityPersonalSessionMembershipProvider enabled>{children}</ActivityPersonalSessionMembershipProvider>,
    });
    const candidateReads = () => homes.requests.filter(request => request.path === '/v2/sessions/query'
        && (request.input as { scope?: string } | undefined)?.scope === 'all_accessible').length;
    const candidateIds = () => hook.getCurrent().ruleSessionMembershipByServerId?.[serverId];
    await vi.waitFor(() => expect(candidateIds()).toHaveLength(sessions.length), { timeout: 10_000 });
    expect(candidateIds()).toEqual(sessions.map(session => session.id));
    const coldReads = candidateReads();
    console.info('Fleet Follow candidate reads', coldReads);
    expect.soft(coldReads).toBe(Math.ceil(sessions.length / SESSION_LIST_PAGE_MAX_LIMIT));

    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    await flushHookEffects({ cycles: 1, advanceTimersMs: 60_000 });
    expect(candidateReads()).toBe(coldReads);
    vi.useRealTimers();
    const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
    const { readSessionListRowsForServerId } = await import('@/sync/domains/session/listing/sessionListRowStateLookup');
    const { readSessionFollowRuleInputs } = await import('@/sync/api/session/sessionFollowRulesApi');
    const { visitSessionFollowPersonalReceiverOriginals } = await import('@/sync/api/session/sessionFollowPersonalReceiverApi');
    const lifetime = captureActiveServerAccountScopeLifetime();
    const snapshot = await readSessionFollowRuleInputs(serverId);
    if (!lifetime || snapshot.status !== 'ready') throw new Error('Missing fixture Follow authority');
    const publishedRows = readSessionListRowsForServerId(getStorage().getState().sessionListRowsByServerId, serverId);
    expect(sessions.filter(session => publishedRows?.[session.id]?.ownerAccountId === 'alice')).toHaveLength(sessions.length);
    batchSizes.length = 0;
    await visitSessionFollowPersonalReceiverOriginals({ lifetime, snapshot, sourceSessionIds: sessions.map(session => session.id),
        onOccurrence: async () => { throw new Error('The receiver cannot evaluate local originals'); } });
    console.info('Fleet Follow owned snapshot batch sizes', batchSizes);
    expect.soft(batchSizes.filter(size => size > 0)).toEqual([]);

    const removed = rows.pop()!;
    await act(async () => publishHomeAccountChange(serverId, [removed.id], { changeKinds: ['share'], sessionListQueryAffects: true }));
    await vi.waitFor(() => expect(candidateIds()).toHaveLength(rows.length));
    expect(candidateIds()).toEqual(rows.map(row => row.id));
    expect(candidateReads() - coldReads).toBe(coldReads);
});
