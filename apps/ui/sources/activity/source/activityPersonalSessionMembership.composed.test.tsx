import * as React from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ACCOUNT_SESSION_FOLLOW_CHANGE_ENTITY_ID } from '@happier-dev/protocol/sessions/follow/changes';
import type { FollowDeliveryMuteScopeV1 } from '@happier-dev/protocol/sessions/follow/sessionDeliveryMuteV1';
import { normalizeSessionListFilterV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { createPlainSessionByIdResponseFixture, createSessionAccessFixture, createSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
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
