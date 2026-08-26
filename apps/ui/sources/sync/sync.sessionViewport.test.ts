import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionFixture } from '@/dev/testkit';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import type { SessionListViewItem } from '@/sync/domains/session/listing/sessionListViewData';
import type { NormalizedMessage } from '@/sync/typesRaw';

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
        initialize: vi.fn(),
        request: vi.fn(async () => new Response('ok', { status: 200 })),
    },
}));

vi.mock('@/log', () => ({
    log: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('sync session viewport', () => {
    type RuntimeViewportChangeSync = Readonly<{
        onSessionViewportChange: (
            sessionId: string,
            state: Readonly<{
                isPinned: boolean;
                offsetY?: number;
                shouldPersistViewport?: boolean;
                shouldRestoreViewport?: boolean;
                anchor?: unknown;
            }>
        ) => void;
    }>;

    const validViewportAnchor = {
        kind: 'message',
        messageId: 'message-1',
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

    function buildMessage(id: string, seq: number): NormalizedMessage {
        return {
            id,
            localId: null,
            createdAt: seq,
            role: 'user',
            content: { type: 'text', text: id },
            seq,
            isSidechain: false,
        };
    }

    beforeEach(() => {
        vi.resetModules();
    });

    it('leaves eager session-list hydration rows out of prioritized hydration ids', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const { sync } = await import('./sync');

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

    it('preserves live-tail default for position-unknown detach reports without prior observation', async () => {
        const { sync } = await import('./sync');
        const runtimeSync = sync as unknown as RuntimeViewportChangeSync;

        sync.onSessionVisible('session-1');
        runtimeSync.onSessionViewportChange('session-1', {
            isPinned: false,
            shouldPersistViewport: false,
            shouldRestoreViewport: true,
        });

        // Position-unknown detach must not fabricate a restore distance; with no prior
        // observed offset the stored record keeps the live-tail geometry (0) while flipping
        // pinned state so conditional send intent works.
        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            offsetY: 0,
            source: 'observed',
            anchor: null,
        });
    });

    it('preserves prior observed offset and anchor for position-unknown detach reports', async () => {
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
            shouldPersistViewport: false,
            shouldRestoreViewport: true,
        });

        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            offsetY: 420,
            source: 'observed',
            anchor: validViewportAnchor,
        });
    });

    it('treats non-finite observed offsets as position-unknown', async () => {
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
            offsetY: Number.NaN,
            shouldPersistViewport: false,
            shouldRestoreViewport: true,
        });

        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            offsetY: 420,
            source: 'observed',
            anchor: validViewportAnchor,
        });
    });

    it('stores a valid viewport anchor for observed restore intent', async () => {
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

    it('marks outbound user messages as live-tail intent', async () => {
        const { sync } = await import('./sync');
        const liveTailSync = sync as unknown as {
            markSessionLiveTailIntent?: (sessionId: string) => void;
        };

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

        expect(typeof liveTailSync.markSessionLiveTailIntent).toBe('function');
        liveTailSync.markSessionLiveTailIntent?.('session-1');

        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: true,
            offsetY: 0,
            source: 'default',
            anchor: null,
        });
    });

    it('hydrates the persisted viewport anchor across app restarts (N2b.1)', async () => {
        const { sync } = await import('./sync');

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });
        expect(sync.getSessionViewport('session-1')).toMatchObject({ anchor: validViewportAnchor });

        vi.resetModules();
        const { sync: reloadedSync } = await import('./sync');

        expect(reloadedSync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            offsetY: 420,
            source: 'observed',
            anchor: {
                kind: validViewportAnchor.kind,
                messageId: validViewportAnchor.messageId,
                itemId: validViewportAnchor.itemId,
                itemOffsetPx: validViewportAnchor.itemOffsetPx,
            },
        });

        // Session entry keeps the hydrated anchored intent instead of defaulting to live-tail.
        reloadedSync.onSessionVisible('session-1');
        expect(reloadedSync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            offsetY: 420,
            source: 'observed',
        });
    });

    it('stamps the persisted anchor with the message seq when the message is materialized (identity-first)', async () => {
        const { sync } = await import('./sync');
        const { storage } = await import('@/sync/domains/state/storage');

        storage.getState().applyMessages('session-1', [buildMessage('message-1', 7)]);
        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });

        vi.resetModules();
        const { sync: reloadedSync } = await import('./sync');

        expect(reloadedSync.getSessionViewport('session-1')).toMatchObject({
            anchor: { messageId: 'message-1', seq: 7 },
        });
    });

    it('preserves an incoming durable anchor seq before identity stamping can run', async () => {
        const { sync } = await import('./sync');

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: {
                ...validViewportAnchor,
                messageId: 'server-message-1',
                seq: 7,
            },
        });

        expect(sync.getSessionViewport('session-1')).toMatchObject({
            anchor: { messageId: 'server-message-1', seq: 7 },
        });
    });

    it('hydrates an anchor whose message is no longer materialized (deleted/pruned window degrades downstream)', async () => {
        const { sync } = await import('./sync');

        // No message store entry for the anchor: identity is persisted regardless;
        // entry resolution degrades through nearest-surviving / bounded materialization.
        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });

        vi.resetModules();
        const { sync: reloadedSync } = await import('./sync');

        const hydrated = reloadedSync.getSessionViewport('session-1');
        expect(hydrated).toMatchObject({
            isPinned: false,
            anchor: { messageId: 'message-1' },
        });
        // Raw distance survives as degraded fallback metadata only.
        expect(hydrated?.offsetY).toBe(420);
    });

    it('does not leak a persisted anchor across the fork boundary (per-session keying)', async () => {
        const { sync } = await import('./sync');

        sync.onSessionViewportChange('session-parent', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });

        vi.resetModules();
        const { sync: reloadedSync } = await import('./sync');

        expect(reloadedSync.getSessionViewport('session-parent')).toMatchObject({ isPinned: false });
        expect(reloadedSync.getSessionViewport('session-parent-fork')).toBeNull();

        reloadedSync.onSessionVisible('session-parent-fork');
        expect(reloadedSync.getSessionViewport('session-parent-fork')).toMatchObject({
            isPinned: true,
            offsetY: 0,
            source: 'default',
            anchor: null,
        });
    });

    it('live-tail intent beats a stale persisted anchor across restarts (catchup precedence)', async () => {
        const { sync } = await import('./sync');
        const liveTailSync = sync as unknown as { markSessionLiveTailIntent: (sessionId: string) => void };

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });
        liveTailSync.markSessionLiveTailIntent('session-1');

        vi.resetModules();
        const { sync: reloadedSync } = await import('./sync');

        expect(reloadedSync.getSessionViewport('session-1')).toBeNull();

        reloadedSync.onSessionVisible('session-1');
        expect(reloadedSync.getSessionViewport('session-1')).toMatchObject({
            isPinned: true,
            offsetY: 0,
            source: 'default',
            anchor: null,
        });
    });

    it('deletes a same-session viewport another tab persisted after hydration', async () => {
        const { sync } = await import('./sync');
        const {
            readPersistedSessionViewport,
            upsertPersistedSessionViewport,
        } = await import('./domains/state/sessionViewportPersistence');
        const liveTailSync = sync as unknown as { markSessionLiveTailIntent: (sessionId: string) => void };

        // Tab A hydrates an empty scope. Tab B then persists a detached viewport
        // for the same session without updating tab A's in-memory ID set.
        expect(sync.getSessionViewport('session-shared')).toBeNull();
        upsertPersistedSessionViewport('session-shared', {
            isPinned: false,
            anchor: {
                ...validViewportAnchor,
                seq: 7,
            },
            offsetY: 420,
            lastUpdatedAt: 2_000,
        });
        expect(readPersistedSessionViewport('session-shared')).not.toBeNull();

        // Last-committer-wins: tab A's later live-tail intent is the durable
        // delete, even though the session ID was absent at its first hydration.
        liveTailSync.markSessionLiveTailIntent('session-shared');

        expect(readPersistedSessionViewport('session-shared')).toBeNull();
    });

    it('does not persist transient unpinned viewport reports', async () => {
        const { sync } = await import('./sync');

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });
        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 9_999,
            shouldRestoreViewport: false,
        });

        vi.resetModules();
        const { sync: reloadedSync } = await import('./sync');

        expect(reloadedSync.getSessionViewport('session-1')).toBeNull();
    });

    it('keeps the hydrated anchored intent against passive pinned reports after restart', async () => {
        const { sync } = await import('./sync');

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });

        vi.resetModules();
        const { sync: reloadedSync } = await import('./sync');

        // A passive pinned observation that still requests restore must not wipe the
        // hydrated anchor (same guard as the in-memory path).
        reloadedSync.onSessionViewportChange('session-1', {
            isPinned: true,
            offsetY: 0,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });

        expect(reloadedSync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            offsetY: 420,
            source: 'observed',
        });
    });

    it('preserves the stored identity anchor across anchor-less passive observation emits (N2b.5)', async () => {
        const { sync } = await import('./sync');

        // User dwell capture stores the durable identity anchor.
        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });

        // App restart hydrates the persisted anchor (cold reopen #1).
        vi.resetModules();
        const { sync: reloadedSync } = await import('./sync');
        expect(reloadedSync.getSessionViewport('session-1')).toMatchObject({
            anchor: { messageId: 'message-1', itemId: 'item-1' },
        });

        // Passive observation emit from the onScroll pipeline: unpinned restore
        // intent with NO anchor field (the capture is suppressed for passive
        // frames). It must merge — update offset metadata, keep the identity.
        reloadedSync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 380,
            shouldRestoreViewport: true,
        });
        expect(reloadedSync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            offsetY: 380,
            source: 'observed',
            anchor: { messageId: 'message-1', itemId: 'item-1' },
        });

        // Cold reopen #2: the identity round-trip must survive the visit.
        vi.resetModules();
        const { sync: coldSync } = await import('./sync');
        const hydrated = coldSync.getSessionViewport('session-1');
        expect(hydrated).toMatchObject({
            isPinned: false,
            anchor: { messageId: 'message-1', itemId: 'item-1' },
        });
        expect(hydrated?.offsetY).toBe(380);
    });

    it('clears the stored anchor when a capture outcome explicitly reports no anchor', async () => {
        const { sync } = await import('./sync');

        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 420,
            shouldRestoreViewport: true,
            anchor: validViewportAnchor,
        });

        // A user-attributed capture that found no anchor (anchor-capture-empty)
        // emits an explicit null: the record degrades to distance fallback at
        // the NEW position instead of keeping a stale identity.
        sync.onSessionViewportChange('session-1', {
            isPinned: false,
            offsetY: 980,
            shouldRestoreViewport: true,
            anchor: null,
        });
        expect(sync.getSessionViewport('session-1')).toMatchObject({
            isPinned: false,
            offsetY: 980,
            source: 'observed',
            anchor: null,
        });

        vi.resetModules();
        const { sync: reloadedSync } = await import('./sync');
        const hydrated = reloadedSync.getSessionViewport('session-1');
        expect(hydrated).toMatchObject({ isPinned: false, anchor: null });
        expect(hydrated?.offsetY).toBe(980);
    });

    it('hydrates deferred hidden session state on reveal and clears the marker', async () => {
        const { sync } = await import('./sync');
        const invalidateCoalesced = vi.fn();
        const hydrateVisibleSession = vi.fn(async () => true);
        const sessionId = 'session-state-reveal';
        type DeferredStateHydrationHarness = {
            markSessionStateHydrationDeferred: (sessionId: string) => void;
            messagesSync: Map<string, { invalidateCoalesced: () => void }>;
            ensureSessionVisibleForMessageRoute: (
                sessionId: string,
                options?: Readonly<{ forceRefresh?: boolean }>,
            ) => Promise<boolean>;
        };
        const harness = sync as unknown as DeferredStateHydrationHarness;

        harness.messagesSync = new Map([[sessionId, { invalidateCoalesced }]]);
        harness.ensureSessionVisibleForMessageRoute = hydrateVisibleSession;
        harness.markSessionStateHydrationDeferred(sessionId);

        sync.onSessionVisible(sessionId);
        sync.onSessionVisible(sessionId);

        expect(hydrateVisibleSession).toHaveBeenCalledTimes(1);
        expect(hydrateVisibleSession).toHaveBeenCalledWith(sessionId, { forceRefresh: true });
        expect(invalidateCoalesced).toHaveBeenCalledTimes(2);
    });

    it('limits historical viewport sessions used for session-list hydration priority', async () => {
        const { sync } = await import('./sync');
        const dateNow = vi.spyOn(Date, 'now');
        const harness = sync as unknown as {
            syncTuning: { sessionViewportHydrationPriorityMaxRows: number };
            getPrioritizedSessionHydrationIds: () => string[];
        };
        harness.syncTuning = {
            ...harness.syncTuning,
            sessionViewportHydrationPriorityMaxRows: 3,
        };

        ['session-1', 'session-2', 'session-3', 'session-4', 'session-5'].forEach((sessionId, index) => {
            dateNow.mockReturnValue(1_000 + index);
            sync.onSessionVisible(sessionId);
        });

        expect(harness.getPrioritizedSessionHydrationIds()).toEqual(['session-5', 'session-4', 'session-3']);

        dateNow.mockRestore();
    });

    it('includes the actively viewed session in hydration priority before viewport tracking exists', async () => {
        const { sync } = await import('./sync');
        const { clearActiveViewingSessionId, setActiveViewingSessionId } = await import(
            '@/sync/domains/session/activeViewingSession'
        );

        setActiveViewingSessionId('session-active', 1);
        try {
            const priorityIds = (
                sync as unknown as { getPrioritizedSessionHydrationIds: () => string[] }
            ).getPrioritizedSessionHydrationIds();

            expect(priorityIds[0]).toBe('session-active');
        } finally {
            clearActiveViewingSessionId('session-active', 1);
        }
    });

    it('includes route-visible session surfaces in hydration priority before read lifecycle mounts', async () => {
        const { sync } = await import('./sync');
        const { clearActiveViewingSessionsForServerScopeReset, markSessionHidden, markSessionVisible } = await import(
            '@/sync/domains/session/activeViewingSession'
        );

        clearActiveViewingSessionsForServerScopeReset();
        markSessionVisible('session-route-visible', 'server-a');
        try {
            const priorityIds = (
                sync as unknown as { getPrioritizedSessionHydrationIds: () => string[] }
            ).getPrioritizedSessionHydrationIds();

            expect(priorityIds[0]).toBe('session-route-visible');
        } finally {
            markSessionHidden('session-route-visible', 'server-a');
        }
    });

    it('clears active viewing hydration priority when server-scoped runtime state resets', async () => {
        const { sync } = await import('./sync');
        const { getActiveViewingSessionId, setActiveViewingSessionId } = await import(
            '@/sync/domains/session/activeViewingSession'
        );

        setActiveViewingSessionId('session-active', 1);
        expect(getActiveViewingSessionId()).toBe('session-active');

        sync.disconnectServer();

        const priorityIds = (
            sync as unknown as { getPrioritizedSessionHydrationIds: () => string[] }
        ).getPrioritizedSessionHydrationIds();

        expect(getActiveViewingSessionId()).toBeNull();
        expect(priorityIds).not.toContain('session-active');
    });
});
