import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';

import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createPlainSessionByIdResponseFixture, createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { hasDeferredSessionStateHydration, type DeferredSessionStateHydrationState } from './domains/session/realtime/deferredSessionStateHydration';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';

const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock('react-native-mmkv', () => {
    class MMKV {
        getString(key: string) {
            return kvStore.get(key);
        }
        set(key: string, value: string) {
            kvStore.set(key, value);
        }
        delete(key: string) {
            kvStore.delete(key);
        }
        getAllKeys() {
            return [...kvStore.keys()];
        }
        clearAll() {
            kvStore.clear();
        }
    }

    return { MMKV };
});

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        AppState: {
            currentState: 'active',
            addEventListener: vi.fn(() => ({ remove: vi.fn() })),
        },
    });
});

vi.mock('@/sync/api/session/apiSocket', () => ({
    apiSocket: {
        onMessage: vi.fn(),
        onError: vi.fn(),
        onReconnected: vi.fn(),
        onStatusChange: vi.fn(() => () => {}),
        onConnectionStateChange: vi.fn(() => () => {}),
        connect: vi.fn(),
        disconnect: vi.fn(),
        invalidateRequests: vi.fn(),
        initialize: vi.fn(),
        request: vi.fn(async () => new Response(
            JSON.stringify({ messages: [], hasMore: false, nextAfterSeq: null }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
        )),
    },
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Packaged Expo assets are absent in this unit harness; retain the real plugin owners.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', async (importOriginal) => {
    const { emptyBundledPluginUiAssetsModule } = await importOriginal<typeof import('@/dev/testkit/mocks/bundledPluginUiAssets')>();
    return emptyBundledPluginUiAssetsModule;
});

// Warm the real Sync graph during collection; each case still resets its runtime below.
await loadSyncSingletonForTests();

describe('sync session viewport', () => {
    type RuntimeViewportChangeSync = Readonly<{
        onSessionViewportChange: (
            sessionId: string,
            state: Readonly<{
                isPinned: boolean;
                offsetY?: number;
                shouldRestoreViewport?: boolean;
                shouldPersistViewport?: boolean;
                anchor?: unknown;
            }>,
        ) => void;
    }>;

    const validViewportAnchor = {
        kind: 'message',
        messageId: 'message-1',
        seq: 42,
        itemId: 'item-1',
        itemOffsetPx: 84,
        capturedAtMs: 1234,
    } as const;

    type SyncWithHydrationPrioritySelector = Readonly<{
        getPrioritizedSessionHydrationIds: () => string[];
    }>;

    function buildSessionListItem(id: string): SessionListViewItem {
        return {
            type: 'session',
            session: buildSessionListRenderableFromSession(createSessionFixture({ id })),
        };
    }

    beforeEach(async () => {
        vi.resetModules();
        kvStore.clear();
        await loadSyncSingletonForTests();
    });

    it('leaves eager session-list hydration rows out of prioritized hydration ids', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { sync } = await import('./syncEngine');

        storage.setState((state) => ({
            ...state,
            sessionListViewData: [
                buildSessionListItem('s_eager_1'),
                buildSessionListItem('s_eager_2'),
                buildSessionListItem('s_eager_3'),
            ],
        }));

        const ids = (sync as unknown as SyncWithHydrationPrioritySelector).getPrioritizedSessionHydrationIds();

        expect(ids).toEqual([]);
    });

    it('keeps live-tail intent for transient unpinned viewport reports', async () => {
        const { sync } = await import('./sync');

        expect(sync.getSessionViewport('session-1')).toBeNull();

        sync.onSessionVisible('session-1');
        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: true,
            offsetY: 0,
            source: 'default',
            anchor: null,
        });

        sync.onSessionViewportChange('session-1', { isPinned: false, offsetY: 420, shouldRestoreViewport: false });
        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: true,
            offsetY: 0,
            source: 'default',
            anchor: null,
        });
    });

    it('preserves observed viewport intent after the user releases bottom follow', async () => {
        const { sync } = await import('./sync');

        sync.onSessionVisible('session-1');
        sync.onSessionViewportChange('session-1', { isPinned: false, offsetY: 420, shouldRestoreViewport: true });
        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            offsetY: 420,
            source: 'observed',
        });

        sync.onSessionVisible('session-1');
        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            offsetY: 420,
            source: 'observed',
        });
    });

    it('hydrates a cold persisted viewport before session visibility can apply live-tail intent', async () => {
        const { upsertPersistedSessionViewport } = await import('./domains/state/sessionViewportPersistence');
        upsertPersistedSessionViewport('session-cold', {
            isPinned: false,
            anchor: validViewportAnchor,
            offsetY: 420,
            lastUpdatedAt: 2_000,
        });

        const { sync } = await import('./sync');
        sync.onSessionVisible('session-cold');

        expect(sync.getSessionViewport('session-cold')).toMatchObject({
            isPinned: false,
            offsetY: 420,
            source: 'observed',
            anchor: validViewportAnchor,
        });
    });

    it('preserves prior position and anchor when a detach report has unknown position', async () => {
        const { sync } = await import('./sync');
        const runtimeSync = sync as unknown as RuntimeViewportChangeSync;

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });
        runtimeSync.onSessionViewportChange('session-1', {
            isPinned: false,
            shouldRestoreViewport: true,
            shouldPersistViewport: false,
        });

        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            offsetY: 420,
            source: 'observed',
            anchor: validViewportAnchor,
        });
    });

    it('preserves an omitted anchor but clears an explicitly null anchor', async () => {
        const { sync } = await import('./sync');

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });
        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 320,
            shouldRestoreViewport: true,
        });
        expect(sync.getSessionViewport('session-1')).toMatchObject({ anchor: validViewportAnchor });

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 300,
            shouldRestoreViewport: true,
            anchor: null,
        });
        expect(sync.getSessionViewport('session-1')).toMatchObject({ anchor: null });
    });

    it('stores a valid viewport anchor when the anchored row starts above the viewport', async () => {
        const { sync } = await import('./sync');
        const partiallyVisibleAnchor = {
            ...validViewportAnchor,
            itemOffsetPx: -48,
        };

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: partiallyVisibleAnchor,
        });

        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            offsetY: 420,
            source: 'observed',
            anchor: partiallyVisibleAnchor,
        });
    });

    it('drops invalid viewport anchors while preserving distance fallback', async () => {
        const { sync } = await import('./sync');
        const runtimeSync = sync as unknown as RuntimeViewportChangeSync;
        const invalidAnchors = [
            { ...validViewportAnchor, itemId: '' },
            { ...validViewportAnchor, messageId: '' },
            { ...validViewportAnchor, kind: 'unknown' },
            { ...validViewportAnchor, itemOffsetPx: Number.NaN },
            { ...validViewportAnchor, capturedAtMs: Number.POSITIVE_INFINITY },
        ];

        invalidAnchors.forEach((anchor, index) => {
            const sessionId = `session-invalid-${index}`;

            runtimeSync.onSessionViewportChange(sessionId, {
                isPinned: false,
                offsetY: 420 + index,
                shouldRestoreViewport: true,
                anchor,
            });

            expect(sync.getSessionViewport(sessionId)).toMatchObject({
                isPinned: false,
                offsetY: 420 + index,
                source: 'observed',
                anchor: null,
            });
        });
    });

    it('clears stale anchors for viewport reports without restore intent', async () => {
        const { sync } = await import('./sync');

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });
        expect(sync.getSessionViewport('session-1')).toMatchObject({ anchor: validViewportAnchor });

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 320,
            shouldRestoreViewport: false,
            anchor: validViewportAnchor,
        });

        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: true,
            offsetY: 0,
            source: 'default',
            anchor: null,
        });
    });

    it('preserves observed viewport intent when a passive pinned observation still requests restore', async () => {
        const { sync } = await import('./sync');

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });
        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            source: 'observed',
            anchor: validViewportAnchor,
        });

        sync.onSessionViewportChange('session-1', {
            isPinned: true,
            offsetY: 0,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });

        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            offsetY: 420,
            source: 'observed',
            anchor: validViewportAnchor,
        });
    });

    it('treats pinned viewport reports as live-tail intent when restore is not requested', async () => {
        const { sync } = await import('./sync');

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });
        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            source: 'observed',
            anchor: validViewportAnchor,
        });

        sync.onSessionViewportChange('session-1', {
            isPinned: true,
            offsetY: 0,
            shouldRestoreViewport: false,
            anchor: validViewportAnchor,
        });

        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: true,
            offsetY: 0,
            source: 'default',
            anchor: null,
        });
    });

    it('hydrates durable identity-first viewport state across runtime reloads', async () => {
        const { sync } = await import('./sync');

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });
        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            offsetY: 420,
            source: 'observed',
            anchor: validViewportAnchor,
        });

        vi.resetModules();
        await loadSyncSingletonForTests();
        const { sync: reloadedSync } = await import('./sync');

        expect(reloadedSync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            offsetY: 420,
            source: 'observed',
            anchor: validViewportAnchor,
        });
    });

    it('deletes the durable viewport record when live-tail intent wins', async () => {
        const { sync } = await import('./sync');
        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });
        sync.markSessionLiveTailIntent('session-1');

        vi.resetModules();
        await loadSyncSingletonForTests();
        const { sync: reloadedSync } = await import('./sync');
        expect(reloadedSync.getSessionViewport('session-1')).toBeNull();
    });

    it('deletes a same-session viewport another tab persisted after hydration', async () => {
        const { sync } = await import('./sync');
        const {
            readPersistedSessionViewport,
            upsertPersistedSessionViewport,
        } = await import('./domains/state/sessionViewportPersistence');

        expect(sync.getSessionViewport('session-shared')).toBeNull();
        upsertPersistedSessionViewport('session-shared', {
            isPinned: false,
            anchor: validViewportAnchor,
            offsetY: 420,
            lastUpdatedAt: 2_000,
        });
        expect(readPersistedSessionViewport('session-shared')).not.toBeNull();

        sync.markSessionLiveTailIntent('session-shared');

        expect(readPersistedSessionViewport('session-shared')).toBeNull();
    });

    it.each([
        ['retries failed deferred state hydration on reveal and stops refreshing after materialization', 'failure'],
        ['preserves a hidden invalidation during hydration for the next reveal', 'hidden_update'],
        ['recovers a deferred invalidation after a fresh replacement fails without reviving its retired read', 'fresh_recovery'],
        ['preserves deferred state after a same-scope abort for the next reveal', 'abort'],
        ['does not restore deferred state into a retired Account scope', 'retired_scope'],
    ] as const)('%s', async (_name, scenario) => {
        const { sync } = await import('./sync');
        const { storage } = await import('@/sync/domains/state/storage');
        const { apiSocket } = await import('@/sync/api/session/apiSocket');
        const { Encryption } = await import('@/sync/encryption/encryption');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverProfiles');
        const { publishAppliedActiveServerSnapshot } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
        const snapshot = getActiveServerSnapshot();
        const accountId = 'deferred-state-account';
        storage.getState().activateProfileScope({ serverId: snapshot.serverId, accountId });
        publishAppliedActiveServerSnapshot(snapshot);
        const sessionId = 'session-deferred-state-reveal';
        type DeferredStateHarness = {
            credentials: AuthCredentials;
            deferredSessionStateHydrationState: DeferredSessionStateHydrationState;
            markSessionStateHydrationDeferred: (sessionId: string) => void;
            sessionByIdHydrationInFlight: Map<string, unknown>;
        };
        const harness = sync as unknown as DeferredStateHarness;
        const requestMock = vi.mocked(apiSocket.request);
        const firstResponse = createDeferred<Response>();
        const response = createDeferred<Response>();
        const sessionPath = `/v2/sessions/${sessionId}`;
        const sessionReads = () => requestMock.mock.calls.filter(([path]) => String(path).split('?')[0] === sessionPath);
        const staleSession = createSessionFixture({ id: sessionId, serverId: snapshot.serverId, encryptionMode: 'plain', agentState: {} });
        const currentAgentState = {
            requests: {
                'question-request': {
                    tool: 'AskUserQuestion',
                    arguments: { questions: [{ question: 'Which option?' }] },
                },
            },
        };

        storage.getState().applySessions([staleSession]);
        sync.encryption = await Encryption.create(new Uint8Array(32).fill(7));
        harness.credentials = { token: `e30.${btoa(JSON.stringify({ sub: accountId }))}.signature` };
        requestMock.mockReset();
        requestMock.mockImplementation(async (path) => {
            if (String(path).split('?')[0] === sessionPath) {
                if (sessionReads().length === 1) {
                    if (scenario === 'failure') throw new Error('Network unavailable');
                    return await firstResponse.promise;
                }
                if (scenario === 'fresh_recovery' && sessionReads().length === 2) throw new Error('Replacement unavailable');
                return await response.promise;
            }
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            return Response.json({ messages: [], hasMore: false, nextAfterSeq: null });
        });
        harness.markSessionStateHydrationDeferred(sessionId);
        const controller = new AbortController();
        const initialRead = scenario === 'fresh_recovery' || scenario === 'abort' || scenario === 'retired_scope'
            ? sync.ensureSessionVisibleForMessageRoute(sessionId, { forceRefresh: true, hydrateMessages: false, signal: controller.signal })
            : undefined;
        try {
            sync.onSessionVisible(sessionId);
            sync.onSessionVisible(sessionId);
            await expect.poll(() => sessionReads().length).toBe(1);
            const firstAgentState = scenario === 'hidden_update' ? { controlledByUser: true } : {};
            if (scenario === 'hidden_update') {
                // The hidden update invalidates the snapshot already in flight.
                harness.markSessionStateHydrationDeferred(sessionId);
                firstResponse.resolve(Response.json(createPlainSessionByIdResponseFixture({
                    ...staleSession, agentState: firstAgentState,
                })));
            } else if (scenario === 'fresh_recovery') {
                expect(await sync.ensureSessionVisibleForMessageRoute(sessionId, { fresh: true, hydrateMessages: false }))
                    .toMatchObject({ kind: 'retryable_failure' });
            } else if (scenario === 'abort' || scenario === 'retired_scope') {
                if (scenario === 'retired_scope') {
                    storage.getState().activateProfileScope({ serverId: snapshot.serverId, accountId: 'replacement-account' });
                }
                controller.abort();
                firstResponse.resolve(Response.json(createPlainSessionByIdResponseFixture({
                    ...staleSession, agentState: { controlledByUser: true },
                })));
                expect(await initialRead).toMatchObject({ kind: 'awaiting_push' });
            }
            await expect.poll(() => harness.sessionByIdHydrationInFlight.size).toBe(0);
            expect(storage.getState().sessions[sessionId]?.agentState).toEqual(firstAgentState);

            if (scenario === 'retired_scope') {
                expect(hasDeferredSessionStateHydration(harness.deferredSessionStateHydrationState, sessionId)).toBe(false);
                return;
            }
            // A later reveal retries; concurrent reveals share the existing exact read.
            sync.onSessionVisible(sessionId);
            sync.onSessionVisible(sessionId);
            const expectedReads = scenario === 'fresh_recovery' ? 3 : 2;
            await expect.poll(() => sessionReads().length).toBe(expectedReads);
            response.resolve(Response.json(createPlainSessionByIdResponseFixture({
                ...staleSession, updatedAt: staleSession.updatedAt + 1,
                agentState: currentAgentState, agentStateVersion: staleSession.agentStateVersion + 1,
            })));
            await expect.poll(() => storage.getState().sessions[sessionId]?.agentState).toEqual(currentAgentState);
            await expect.poll(() => harness.sessionByIdHydrationInFlight.size).toBe(0);
            if (scenario === 'fresh_recovery') {
                firstResponse.resolve(Response.json(createPlainSessionByIdResponseFixture({
                    ...staleSession, agentState: { controlledByUser: true },
                })));
                expect(await initialRead).toMatchObject({ kind: 'awaiting_push' });
            }

            sync.onSessionVisible(sessionId);
            await new Promise((resolve) => setTimeout(resolve, 0));
            expect(sessionReads()).toHaveLength(expectedReads);
            expect(storage.getState().sessions[sessionId]?.agentState).toEqual(currentAgentState);
            expect(requestMock.mock.calls.filter(([path]) => /^\/v\d+\/sessions(?:\?|$)/.test(String(path)))).toHaveLength(0);
        } finally {
            firstResponse.resolve(Response.json(createPlainSessionByIdResponseFixture(staleSession)));
            response.resolve(Response.json(createPlainSessionByIdResponseFixture(staleSession)));
            await initialRead;
        }
    });

    it('keeps historical viewport restoration state out of session-list hydration priority', async () => {
        const { sync } = await import('./sync');
        const harness = sync as unknown as {
            getPrioritizedSessionHydrationIds: () => string[];
        };

        ['session-1', 'session-2', 'session-3', 'session-4', 'session-5'].forEach((sessionId) => {
            sync.onSessionVisible(sessionId);
            sync.onSessionViewportChange(sessionId, {
                isPinned: false, offsetY: 420, shouldRestoreViewport: true, anchor: validViewportAnchor,
            });
        });

        expect(harness.getPrioritizedSessionHydrationIds()).toEqual([]);
        expect(sync.getSessionViewport('session-5')).toMatchObject({
            isPinned: false, offsetY: 420, source: 'observed', anchor: validViewportAnchor,
        });
    });

    it('includes the actively viewed session in hydration priority before viewport tracking exists', async () => {
        const { sync } = await import('./sync');
        const { beginSessionViewingActivation, endSessionViewingActivation } = await import(
            './domains/session/readState/sessionManualUnreadHold'
        );

        const activationId = beginSessionViewingActivation('session-active');
        try {
            const priorityIds = (
                sync as unknown as { getPrioritizedSessionHydrationIds: () => string[] }
            ).getPrioritizedSessionHydrationIds();

            expect(priorityIds[0]).toBe('session-active');
        } finally {
            endSessionViewingActivation('session-active', activationId);
        }
    });

    it('prioritizes focused, route-anchored, and visible session surfaces while excluding historical viewport rows', async () => {
        const { sync } = await import('./sync');
        const {
            markSessionSurfaceVisible,
            resetSessionSurfaceVisibilityForTests,
            setFocusedSessionId,
            setRouteAnchorSessionId,
        } = await import('./domains/session/sessionSurfaceVisibility');
        const dateNow = vi.spyOn(Date, 'now');
        try {
            resetSessionSurfaceVisibilityForTests();
            dateNow.mockReturnValue(1_000);
            sync.onSessionVisible('session-history');
            markSessionSurfaceVisible('session-visible');
            setFocusedSessionId('session-focused');
            setRouteAnchorSessionId('session-route');

            const priorityIds = (
                sync as unknown as { getPrioritizedSessionHydrationIds: () => string[] }
            ).getPrioritizedSessionHydrationIds();

            expect(priorityIds).toEqual([
                'session-focused',
                'session-route',
                'session-visible',
            ]);
        } finally {
            dateNow.mockRestore();
            resetSessionSurfaceVisibilityForTests();
        }
    });

    it('clears current viewing hydration priority when server-scoped runtime state resets', async () => {
        const { sync } = await import('./sync');
        const {
            beginSessionViewingActivation,
            getCurrentViewingSessionId,
        } = await import('./domains/session/readState/sessionManualUnreadHold');
        const {
            isSessionSurfaceVisible,
            markSessionSurfaceVisible,
        } = await import('./domains/session/sessionSurfaceVisibility');

        beginSessionViewingActivation('session-active');
        markSessionSurfaceVisible('session-active');
        expect(getCurrentViewingSessionId()).toBe('session-active');
        expect(isSessionSurfaceVisible('session-active')).toBe(true);

        sync.disconnectServer();

        const priorityIds = (
            sync as unknown as { getPrioritizedSessionHydrationIds: () => string[] }
        ).getPrioritizedSessionHydrationIds();

        expect(getCurrentViewingSessionId()).toBeNull();
        expect(isSessionSurfaceVisible('session-active')).toBe(false);
        expect(priorityIds).not.toContain('session-active');
    });
});
