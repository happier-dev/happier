import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID } from '@happier-dev/protocol/sessions/follow/changes';
import type { FollowDeliveryMuteScopeV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
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
        [serverId, ['access-changed'], { changeKinds: ['share'] }],
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
    for (const session of [...candidates, ownSource, offScreen, gapSource]) {
        const response = createPlainSessionByIdResponseFixture(session);
        const viewer = session === source && represented ? session.viewer : createSessionViewerFixture({
            follow: { ...ABSENT_SESSION_FOLLOW_FACTS_V1, follows: true },
            readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: 10 },
            attention: { needsAttention: true, reasons: ['unread'], primary: 'unread', presentation: 'full' },
        });
        homes.answer(serverId, `/v2/sessions/${session.id}`, { select: () => ({ body: { session: {
            ...response.session, ownerAccountId: session.ownerAccountId, viewer: readyToDeliver.has(session.id) ? viewer : session.viewer,
        } } }) });
        homes.answer(serverId, `/v1/sessions/${session.id}/messages`, { select: (_input, request) => ({ body: {
            messages: Number(new URL(request.url).searchParams.get('afterSeq')) >= 1 ? [] : [{
                id: 'original-message', localId: 'original-local', seq: 1, createdAt: 10, messageRole: 'agent',
                content: { t: 'plain', v: session === gapSource
                    ? { role: 'agent', content: { type: 'event', id: 'ready-event', data: { type: 'ready', completedTurnId: 'offline-turn' } } }
                    : { role: 'agent', content: { type: 'acp', agentId: 'codex',
                        data: { type: 'message', message: 'Committed update' } } } },
            }], hasMore: false, nextAfterSeq: null,
        } }) });
        homes.answer(serverId, `POST /v2/sessions/${session.id}/follows/occurrence-routes`, { body: {
            ok: true, v: 1, sourceSessionId: session.id, routes: [], originalCreatedAt: 10,
            receiverEvaluation: { ownerAccountId: session.ownerAccountId, production: 'source' },
        } });
    }
    let acceptedEffects = 0;
    const progressPath = '/v2/account/session-follow-rules/personal-progress';
    homes.answer(serverId, `POST ${progressPath}`, { select: input => {
        const progress = SessionFollowPersonalProgressRequestV1Schema.parse(input);
        const alreadyRepresented = delivered.some(source => source.sourceSessionId === progress.sourceSessionId);
        if (!alreadyRepresented) {
            acceptedEffects++;
            delivered.push({ sourceSessionId: progress.sourceSessionId, delivered: {
                ...SESSION_FOLLOW_ZERO_FRONTIER_V1,
                ...('sourceTurn' in progress ? { turn: progress.sourceTurn, readyEventSeq: 1 } : { transcriptSeq: 1 }),
            } });
        }
        return { body: { accepted: true, alreadyRepresented } };
    } });
    restored = await restoreServerAccountForTest({ serverUrl, accountId: 'alice',
        credentials: { token: createAccountTokenForTests('alice', { currentAccount: true }) },
        configureSocket: configureConnectedServerSocketBoundary,
        request: createSessionReadBatchFetchBoundary(homes.request) });
    await vi.waitFor(() => expect(getStorage().getState().isDataReady).toBe(true));
    const publications = new Set<ReturnType<typeof useActivityPersonalSessionMembership>>();
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
        readyToDeliver.add(source.id);
        await act(async () => publishHomeAccountChange(serverId, [source.id], { changeKinds: ['session'], sessionListQueryAffects: false }));
        await vi.waitFor(() => expect(acceptedEffects).toBe(1));
        await flushHookEffects();
        expect.soft(record('one changed source', before)).toEqual({ routes: [route(source.id)], queries: 0 });

        before = mark();
        await act(async () => publishHomeAccountChange(serverId, [offScreen.id, siblings[0]!.id], {
            feedPageConsumed: true, changeKinds: ['share', 'machine'], sessionIdsToCatchUp: [offScreen.id], sessionListQueryAffects: false,
        }));
        await vi.waitFor(() => expect(acceptedEffects).toBe(2));
        await flushHookEffects();
        expect.soft(record('exact off-screen share', before)).toEqual({ routes: [route(offScreen.id)], queries: 0 });

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
