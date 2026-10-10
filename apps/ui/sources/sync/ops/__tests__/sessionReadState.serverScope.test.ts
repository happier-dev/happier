import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SessionViewerProjectionV1 } from '@happier-dev/protocol';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListRenderableSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

describe('sessionSetManualReadStateWithServerScope (real Action and scoped transport)', () => {
    let boundary: Awaited<ReturnType<typeof import('@/dev/testkit/harness/sessionOpsNetworkBoundary').installSessionOpsNetworkBoundary>>;
    let storage: typeof import('@/sync/domains/state/storage').storage;
    let fixtures: typeof import('@/dev/testkit/fixtures/sessionFixtures');
    let profiles: typeof import('@/sync/domains/server/serverProfiles');
    let holds: typeof import('@/sync/domains/session/readState/sessionManualUnreadHold');
    let visibility: typeof import('@/sync/domains/session/sessionSurfaceVisibility');
    let setReadState: typeof import('../sessionReadState').sessionSetManualReadStateWithServerScope;
    let accountConnection: Awaited<ReturnType<typeof import('@/dev/testkit/harness/serverAccountConnectionHarness').restoreServerAccountForTest>> | undefined;
    let home: Awaited<ReturnType<typeof boundary.addHome>>;
    let otherHome: Awaited<ReturnType<typeof boundary.addHome>>;
    let reply: () => Promise<Response>;
    const mutations: Array<{ url: string; init: RequestInit | undefined }> = [];

    const tracking = (): SessionViewerProjectionV1 => ({
        readState: { state: 'tracking', lastViewedSessionSeq: 7, unreadSince: null },
        relevance: { relevant: true, reasons: ['owned_by_me'] },
        attention: { needsAttention: false, reasons: [], primary: null, presentation: 'full' },
        follow: { follows: false, notificationLevel: null },
        notification: { level: 'important', source: 'owner' },
    });
    const quiet = (): SessionViewerProjectionV1 => ({
        ...tracking(), readState: { state: 'not_started' },
        relevance: { relevant: false, reasons: [] }, notification: { level: 'none', source: 'none' },
    });
    const answer = (state: 'read' | 'unread', cursor: number | null, viewer?: SessionViewerProjectionV1, didChange = true) => {
        reply = async () => Response.json({ success: true, state, lastViewedSessionSeq: cursor, didChange, ...(viewer ? { viewer } : {}) });
    };
    const session = (overrides: Partial<Session> = {}) => fixtures.createSessionFixture({
        id: 'sid-1', serverId: home.id, seq: 7, lastViewedSessionSeq: 7, updatedAt: 100,
        metadataLayoutVersion: 0, metadata: null, ...overrides,
    });
    const seedSession = (overrides: Partial<Session> = {}) => {
        storage.getState().applySessions([session(overrides)]);
        return storage.getState().sessions['sid-1'];
    };
    const seedRow = (serverId: string, overrides: Partial<SessionListRenderableSession> = {}) => {
        const row = fixtures.createSessionListRenderableSessionFixture({
            id: 'sid-1', seq: 7, lastViewedSessionSeq: 7, metadata: null,
            metadataLayoutVersion: 0, ...overrides,
        });
        storage.getState().applyServerScopedSessionListRows(serverId, [row], { source: 'ordinary', mode: 'replace' });
    };

    beforeAll(async () => {
        const { installSessionOpsNetworkBoundary } = await import('@/dev/testkit/harness/sessionOpsNetworkBoundary');
        boundary = await installSessionOpsNetworkBoundary();
        await loadSyncSingletonForTests();
        storage = (await import('@/sync/domains/state/storage')).storage;
        fixtures = await import('@/dev/testkit/fixtures/sessionFixtures');
        profiles = await import('@/sync/domains/server/serverProfiles');
        holds = await import('@/sync/domains/session/readState/sessionManualUnreadHold');
        visibility = await import('@/sync/domains/session/sessionSurfaceVisibility');
        setReadState = (await import('../sessionReadState')).sessionSetManualReadStateWithServerScope;
    });
    beforeEach(async () => {
        storage.setState(storage.getInitialState(), true);
        boundary.resetRequests();
        home = await boundary.addHome('https://read-state-active.example.test', 'alice');
        otherHome = await boundary.addHome('https://read-state-background.example.test', 'background-account');
        mutations.length = 0;
        answer('unread', 6);
        boundary.setHttpResponder(async (input, init) => {
            const url = new URL(String(input));
            if (url.pathname === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
            if (url.pathname === '/v2/account/settings') return Response.json({ content: null, version: 0 });
            if (!url.pathname.endsWith('/read-state')) return null;
            mutations.push({ url: url.href, init });
            return await reply();
        });
        const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
        accountConnection = await restoreServerAccountForTest({
            serverUrl: home.serverUrl,
            accountId: home.accountId,
            credentials: { token: home.token },
            request: boundary.request,
        });
        // Keep both saved Homes reachable after the active Account's real cold restoration.
        (await import('@/utils/system/runtimeFetch')).setRuntimeFetch(boundary.request);
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        expect(captureActiveServerAccountScopeLifetime()?.scope).toEqual({ serverId: home.id, accountId: home.accountId });
        holds.resetSessionManualUnreadHoldsForTests();
        visibility.resetSessionSurfaceVisibilityForTests();
    });
    afterEach(async () => {
        await accountConnection?.dispose();
        accountConnection = undefined;
    });
    afterAll(async () => {
        await accountConnection?.dispose();
        await (await import('@/sync/runtime/connectivity/serverReachabilitySupervisorPool')).resetServerReachabilitySupervisors();
        await boundary?.dispose();
    });

    it('enters the shared Action policy before the domain transport', async () => {
        const original = seedSession();
        const { settingsParse } = await import('@/sync/domains/settings/settings');
        storage.getState().applySettings(settingsParse({ actionsSettingsV1: {
            v: 1, actions: { 'session.read_state.set': { enabled: false } },
        } }), 1);
        await expect(setReadState('sid-1', 'read', { serverId: home.id }))
            .resolves.toEqual({ success: false, message: 'action_disabled' });
        expect(mutations).toEqual([]);
        expect(storage.getState().sessions['sid-1']).toBe(original);
    });

    it('updates the private viewer frontier without rewriting owner metadata', async () => {
        const metadata = { path: '', host: '', readStateV1: { v: 1 as const, sessionSeq: 7, pendingActivityAt: 0, updatedAt: 1 } };
        seedSession({ metadata, viewer: tracking() });
        const viewer = { ...tracking(), readState: { state: 'tracking' as const, lastViewedSessionSeq: 6, unreadSince: 123 } };
        answer('unread', 6, viewer);
        expect((await setReadState('sid-1', 'unread', { serverId: home.id })).success).toBe(true);
        expect(storage.getState().sessions['sid-1'].viewer).toEqual(viewer);
        expect(storage.getState().sessions['sid-1'].metadata).toEqual(metadata);
    });

    it('applies canonical attention from the private viewer response', async () => {
        seedSession({ viewer: { ...tracking(), attention: {
            ...tracking().attention, needsAttention: true, reasons: ['unread'], primary: 'unread',
        } } });
        answer('read', 7, tracking());
        await setReadState('sid-1', 'read', { serverId: home.id });
        expect(storage.getState().sessions['sid-1'].viewer).toEqual(tracking());
    });

    it('does not retarget a response when the selected Home changes during the request', async () => {
        seedRow(home.id);
        const original = seedSession({ lastViewedSessionSeq: 1 });
        reply = async () => {
            await profiles.setActiveServerId(otherHome.id, { scope: 'device' });
            return Response.json({ success: true, state: 'unread', lastViewedSessionSeq: 6, didChange: true });
        };
        await setReadState('sid-1', 'unread', { serverId: home.id });
        expect(mutations[0]?.url).toBe(`${home.serverUrl}/v2/sessions/sid-1/read-state`);
        expect(storage.getState().sessions['sid-1']).toBe(original);
        expect(storage.getState().sessionListRowsByServerId[home.id]?.['sid-1']?.lastViewedSessionSeq).toBe(6);
    });

    it('lets the Home enroll an untracked viewer for an explicit manual read', async () => {
        seedSession({ viewer: quiet() });
        answer('read', 7, tracking());
        await expect(setReadState('sid-1', 'read', { serverId: home.id }))
            .resolves.toEqual({ success: true, readState: 'read', lastViewedSessionSeq: 7, didChange: true });
        expect(mutations).toHaveLength(1);
        expect(storage.getState().sessions['sid-1'].viewer).toEqual(tracking());
    });

    it('does not restore tracking when the Home rejects a delayed read after Unfollow', async () => {
        seedSession({ viewer: tracking() });
        reply = async () => {
            storage.getState().applySessions([session({ viewer: quiet() })]);
            return Response.json({ error: 'session_not_tracked', viewer: quiet() }, { status: 409 });
        };
        await expect(setReadState('sid-1', 'read', { serverId: home.id }))
            .resolves.toEqual({ success: false, message: 'session_not_tracked' });
        expect(storage.getState().sessions['sid-1'].viewer).toEqual(quiet());
    });

    it('refreshes a no-longer-tracked viewer on conflict without reporting a read mutation', async () => {
        seedSession({ viewer: tracking() });
        reply = async () => Response.json({ error: 'session_not_tracked', viewer: quiet() }, { status: 409 });
        const result = await setReadState('sid-1', 'read', { serverId: home.id });
        expect(result).toEqual({ success: false, message: 'session_not_tracked' });
        expect(storage.getState().sessions['sid-1'].viewer).toEqual(quiet());
    });

    it('does not apply a private response after switching Accounts on the same Home', async () => {
        seedSession();
        let replacement: Session | undefined;
        reply = async () => {
            await boundary.setAccount(home.serverUrl, 'bob');
            expect(storage.getState().profileScope).toEqual({ serverId: home.id, accountId: 'bob' });
            replacement = seedSession({ seq: 20, lastViewedSessionSeq: 15 });
            return Response.json({ success: true, state: 'unread', lastViewedSessionSeq: 6, didChange: true });
        };
        await expect(setReadState('sid-1', 'unread', { serverId: home.id }))
            .resolves.toEqual({ success: false, message: 'session_account_changed' });
        expect(replacement).toBeDefined();
        expect(storage.getState().sessions['sid-1']).toBe(replacement);
    });

    it('denies a same-Home credential for a different mounted Account before the mutation', async () => {
        const original = seedSession();
        const { captureActiveServerAccountScopeLifetime } = await import('@/sync/domains/scope/activeServerAccountScope');
        const lifetime = captureActiveServerAccountScopeLifetime();
        expect(lifetime?.scope).toEqual({ serverId: home.id, accountId: home.accountId });
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { createAccountTokenForTests } = await import('@/dev/testkit/harness/homeGovernanceHarness');
        // Custody may change before the mounted Account reconnects; it cannot authorize a write as Alice.
        const credentialWrite = await TokenStorage.setCredentialsForServerUrlWithRollback(
            home.serverUrl, { serverId: home.id }, { token: createAccountTokenForTests('bob') },
        );
        if (!credentialWrite) throw new Error('Fixture credential replacement was refused');
        try {
            expect(captureActiveServerAccountScopeLifetime()).toBe(lifetime);
            expect(lifetime?.isCurrent()).toBe(true);
            const { resolveServerAccountRequestContext } = await import('@/sync/runtime/orchestration/serverScopedRpc/resolveServerAccountRequestContext');
            const context = await resolveServerAccountRequestContext({ serverId: home.id, preferScoped: true });
            try {
                expect(context).toMatchObject({ scope: 'scoped', targetServerId: home.id, targetServerUrl: home.serverUrl, targetAccountId: 'bob' });
            } finally {
                if (context.scope === 'scoped') await context.release?.();
            }
            await expect(setReadState('sid-1', 'read', { serverId: home.id }))
                .resolves.toEqual({ success: false, message: 'unavailable' });
            expect(mutations).toEqual([]);
            expect(boundary.httpRequests.filter(request => request.url.endsWith('/read-state'))).toEqual([]);
            expect(boundary.httpRequests.every(request => new URL(request.url).origin === home.serverUrl)).toBe(true);
            expect(boundary.requests).toEqual([]);
            expect(storage.getState().sessions['sid-1']).toBe(original);
        } finally {
            await credentialWrite.rollback();
        }
    });

    it('uses the exact-Home scoped transport and applies the returned cursor after success', async () => {
        seedSession();
        await expect(setReadState('sid-1', 'unread', { serverId: home.id }))
            .resolves.toEqual({ success: true, readState: 'unread', lastViewedSessionSeq: 6, didChange: true });
        expect(mutations).toEqual([{ url: `${home.serverUrl}/v2/sessions/sid-1/read-state`,
            init: expect.objectContaining({ method: 'POST', body: JSON.stringify({ state: 'unread' }), signal: expect.any(AbortSignal) }) }]);
        expect(boundary.httpRequests.find(request => request.url.endsWith('/read-state'))?.token).toBe(`Bearer ${home.token}`);
        expect(storage.getState().sessions['sid-1'].lastViewedSessionSeq).toBe(6);
    });

    it('uses the requested background Home and its Account credential', async () => {
        answer('read', 7, undefined, false);
        await expect(setReadState('sid-2', 'read', { serverId: otherHome.id }))
            .resolves.toEqual({ success: true, readState: 'read', lastViewedSessionSeq: 7, didChange: false });
        expect(mutations[0]?.url).toBe(`${otherHome.serverUrl}/v2/sessions/sid-2/read-state`);
        const headers = new Headers(mutations[0]?.init?.headers);
        expect(headers.get('Authorization')).toBe(`Bearer ${otherHome.token}`);
        expect(headers.get('Content-Type')).toBe('application/json');
    });

    it('keeps a nullable cursor without maintaining legacy metadata after success', async () => {
        const metadata = { path: '', host: '', readStateV1: { v: 1 as const, sessionSeq: 7, pendingActivityAt: 0, updatedAt: 100 } };
        seedSession({ metadata, lastViewedSessionSeq: null });
        answer('unread', null, undefined, false);
        await expect(setReadState('sid-1', 'unread', { serverId: home.id }))
            .resolves.toEqual({ success: true, readState: 'unread', lastViewedSessionSeq: null, didChange: false });
        expect(storage.getState().sessions['sid-1'].lastViewedSessionSeq).toBeNull();
        expect(storage.getState().sessions['sid-1'].metadata).toEqual(metadata);
    });

    it('updates direct-session attention metadata when marking unread', async () => {
        seedSession({ seq: 0, lastViewedSessionSeq: 0, metadata: {
            path: '', host: '', externalSessionV1: { v: 1, agentId: 'codex', machineId: 'machine-1',
                remoteSessionId: 'remote-1', source: { kind: 'codexHome', home: 'user' } },
            externalSessionAttentionV1: { v: 1, observedProgressToken: '2:message', viewedProgressToken: '2:message' },
        } });
        answer('unread', 0, undefined, false);
        await setReadState('sid-1', 'unread', { serverId: home.id });
        expect(storage.getState().sessions['sid-1'].metadata?.externalSessionAttentionV1)
            .toEqual({ v: 1, observedProgressToken: '2:message' });
    });

    it.each([
        { state: 'unread' as const, oldCursor: 7, cursor: 6, unread: true },
        { state: 'read' as const, oldCursor: 6, cursor: 7, unread: false },
        { state: 'unread' as const, oldCursor: null, cursor: null, unread: true },
    ])('patches renderable-only $state state and cursor $cursor without rewriting legacy metadata', async ({ state, oldCursor, cursor, unread }) => {
        const metadata = { path: '', host: '', readStateV1: { v: 1 as const, sessionSeq: 7, pendingActivityAt: 0, updatedAt: 100 } };
        seedRow(home.id, { lastViewedSessionSeq: oldCursor, metadata });
        answer(state, cursor);
        await setReadState('sid-1', state, { serverId: home.id });
        const row = storage.getState().sessionListRowsByServerId[home.id]?.['sid-1'];
        expect(row).toMatchObject({ hasUnreadMessages: unread, lastViewedSessionSeq: cursor, metadata });
        expect(storage.getState().sessions['sid-1']).toBeUndefined();
    });

    it.each([6, null])('patches only the non-active Home cache with cursor %s', async cursor => {
        const original = seedSession();
        const metadata = { path: '', host: '', readStateV1: { v: 1 as const, sessionSeq: 7, pendingActivityAt: 0, updatedAt: 100 } };
        seedRow(otherHome.id, { metadata, lastViewedSessionSeq: cursor === null ? null : 7 });
        answer('unread', cursor);
        await setReadState('sid-1', 'unread', { serverId: otherHome.id });
        expect(storage.getState().sessions['sid-1']).toBe(original);
        expect(storage.getState().sessionListRowsByServerId[otherHome.id]?.['sid-1'])
            .toMatchObject({ hasUnreadMessages: true, lastViewedSessionSeq: cursor, metadata });
    });

    it('registers an active-view hold after marking the focused session unread', async () => {
        seedSession();
        const activationId = holds.beginSessionViewingActivation('sid-1');
        visibility.setFocusedSessionId('sid-1');
        await setReadState('sid-1', 'unread', { serverId: home.id });
        expect(holds.shouldSuppressAutomaticMarkViewed({ sessionId: 'sid-1', sessionSeq: 7, activationId })).toBe(true);
    });

    it('returns a structured failure without applying local state', async () => {
        const original = seedSession();
        // The external route response is validated by the real Action transport projector.
        reply = async () => Response.json({ error: 'Forbidden' }, { status: 403 });
        await expect(setReadState('sid-1', 'unread', { serverId: home.id }))
            .resolves.toEqual({ success: false, message: 'forbidden' });
        expect(storage.getState().sessions['sid-1']).toBe(original);
    });
});
