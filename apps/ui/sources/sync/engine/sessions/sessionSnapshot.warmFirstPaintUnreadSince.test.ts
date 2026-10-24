import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    buildSessionListRenderableFromSession,
    type SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import { projectSessionListPlacement } from '@/sync/domains/session/listing/placement/sessionListPlacementProjection';
import type { Session } from '@/sync/domains/state/storageTypes';
import type { SessionListCacheEntryV1 } from '@/sync/domains/state/warmCachePersistence';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import type { V2SessionRecord } from '@happier-dev/protocol';
import { createSessionFixture } from '@/dev/testkit';

import { fetchAndApplySessions, type SessionListEncryption } from './sessionSnapshot';

/**
 * Voice announcements are a genuine side-effect boundary reached by the hydrated
 * apply path; the session-list logic under test runs unchanged beneath it.
 */
vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: {
        onAgentRequest: vi.fn(),
    },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'test',
        serverUrl: 'https://example.test',
        kind: 'custom',
        generation: 1,
    }),
}));

const SESSION_ID = 'session_unread_warm';
/** The instant the server says the session crossed the read -> unread edge. */
const UNREAD_SINCE = 1_700_000_000_000;
/** Later activity on the still-unread session: the fallback ordering key. */
const ACTIVITY_AT = 1_700_000_600_000;
const CREATED_AT = 1_699_000_000_000;
const PLACEMENT_NOW_MS = ACTIVITY_AT + 3_600_000;

function buildUnreadPlainRow(): V2SessionRecord {
    return {
        id: SESSION_ID,
        seq: 12,
        createdAt: CREATED_AT,
        updatedAt: ACTIVITY_AT,
        meaningfulActivityAt: ACTIVITY_AT,
        active: false,
        activeAt: ACTIVITY_AT,
        archivedAt: null,
        encryptionMode: 'plain',
        metadata: JSON.stringify({ path: '/repo', host: 'host' }),
        metadataVersion: 3,
        agentState: JSON.stringify({}),
        agentStateVersion: 1,
        lastViewedSessionSeq: 4,
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
        pendingBlockedCount: 0,
        // Terminal but not 'completed': the session is unread rather than
        // ready-for-review, so it projects into the unread lane.
        latestTurnStatus: 'cancelled',
        latestTurnStatusObservedAt: ACTIVITY_AT,
        dataEncryptionKey: null,
        share: null,
        unreadSince: UNREAD_SINCE,
    };
}

/** A warm-cache entry whose metadata matches the row: the warm first-paint shape. */
function buildWarmCacheEntry(): SessionListCacheEntryV1 {
    return {
        sessionId: SESSION_ID,
        seq: 12,
        metadataVersion: 3,
        agentStateVersion: 1,
        updatedAt: ACTIVITY_AT,
        meaningfulActivityAt: ACTIVITY_AT,
        createdAt: CREATED_AT,
        active: false,
        activeAt: ACTIVITY_AT,
        archivedAt: null,
        lastViewedSessionSeq: 4,
        path: '/repo',
        host: 'host',
        name: 'warm session',
    };
}

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

function createEncryptionHarness(): SessionListEncryption {
    return {
        decryptEncryptionKeys: vi.fn(async (values: readonly string[]) => values.map(() => null)),
        initializeSessions: vi.fn(async () => {}),
        removeSessionEncryption: vi.fn(),
        getSessionEncryption: vi.fn(() => null),
    };
}

type SnapshotRun = Readonly<{
    firstPaintRenderable: SessionListRenderableSession;
    hydratedRenderable: SessionListRenderableSession;
}>;

async function runSessionListSnapshot(options: Readonly<{
    row?: V2SessionRecord;
    cachedEntry?: SessionListCacheEntryV1;
    existingSession?: Session;
}> = {}): Promise<SnapshotRun> {
    const firstPaintRenderables: SessionListRenderableSession[][] = [];
    const hydratedSessions: Session[] = [];

    await fetchAndApplySessions({
        credentials: { token: 't', secret: 's' } as AuthCredentials,
        encryption: createEncryptionHarness(),
        sessionDataKeys: new Map<string, Uint8Array>(),
        request: async () => jsonResponse({
            sessions: [options.row ?? buildUnreadPlainRow()],
            nextCursor: null,
            hasNext: false,
        }),
        cachedSessionListEntries: { [SESSION_ID]: options.cachedEntry ?? buildWarmCacheEntry() },
        getExistingSession: () => options.existingSession,
        requiredHydrationSessionIds: [SESSION_ID],
        awaitSessionListHydration: true,
        applySessionListRenderables: (renderables) => {
            firstPaintRenderables.push(renderables);
        },
        applySessions: (sessions) => {
            // The store resolves `presence` before it builds a renderable from a
            // hydrated session; resolving it the same way here keeps the hydrated
            // renderable below the one the store would produce.
            for (const session of sessions) {
                hydratedSessions.push({ ...session, presence: session.presence ?? session.activeAt });
            }
        },
        repairInvalidReadStateV1: async () => {},
        log: { log: () => {} },
    });

    const firstPaintRenderable = firstPaintRenderables[0]?.find((entry) => entry.id === SESSION_ID);
    const hydratedSession = hydratedSessions.find((session) => session.id === SESSION_ID) ?? options.existingSession;
    expect(firstPaintRenderable).toBeDefined();
    expect(hydratedSession).toBeDefined();

    return {
        firstPaintRenderable: firstPaintRenderable!,
        hydratedRenderable: buildSessionListRenderableFromSession(hydratedSession!),
    };
}

afterEach(() => {
    vi.clearAllMocks();
    syncPerformanceTelemetry.configure({ enabled: false });
});

describe('warm first-paint session-list renderables', () => {
    it.each(['plain-row', 'existing-encrypted-session'] as const)(
        'prefers complete identity evidence from %s over a matching legacy cache flavor',
        async (source) => {
            const metadata = {
                path: '/repo',
                host: 'host',
                flavor: 'claude',
                agentRuntimeDescriptorV1: { v: 1, providerId: 'codex', provider: { backendMode: 'mcp' } } as const,
            };
            const row = buildUnreadPlainRow();
            const existingSession = source === 'existing-encrypted-session'
                ? createSessionFixture({
                    id: SESSION_ID,
                    metadata,
                    metadataVersion: row.metadataVersion,
                    agentState: {},
                    agentStateVersion: row.agentStateVersion,
                })
                : undefined;
            const { firstPaintRenderable, hydratedRenderable } = await runSessionListSnapshot({
                row: {
                    ...row,
                    encryptionMode: source === 'plain-row' ? 'plain' : 'e2ee',
                    metadata: source === 'plain-row' ? JSON.stringify(metadata) : 'encrypted-metadata',
                },
                cachedEntry: { ...buildWarmCacheEntry(), flavor: 'claude' },
                existingSession,
            });

            expect(firstPaintRenderable.metadata?.flavor).toBe('codex');
            expect(hydratedRenderable.metadata?.flavor).toBe('codex');
        },
    );

    it('carries the server-materialized unreadSince onto the warm first-paint renderable', async () => {
        const { firstPaintRenderable } = await runSessionListSnapshot();

        expect(firstPaintRenderable.hasUnreadMessages).toBe(true);
        expect(firstPaintRenderable.unreadSince).toBe(UNREAD_SINCE);
    });

    it('orders the row by the same key at warm first paint and after hydration', async () => {
        const { firstPaintRenderable, hydratedRenderable } = await runSessionListSnapshot();

        const firstPaintPlacement = projectSessionListPlacement({
            session: firstPaintRenderable,
            nowMs: PLACEMENT_NOW_MS,
        });
        const hydratedPlacement = projectSessionListPlacement({
            session: hydratedRenderable,
            nowMs: PLACEMENT_NOW_MS,
        });

        // Anti-vacuity: the fallback key is a different instant, so an equal
        // pair cannot be "both fell back to activity".
        expect(ACTIVITY_AT).not.toBe(UNREAD_SINCE);
        expect(hydratedPlacement.kind).toBe('unread');
        expect(hydratedPlacement.timestamp).toBe(UNREAD_SINCE);

        // The point of the fix: hydration landing must not move the row.
        expect(firstPaintPlacement.kind).toBe(hydratedPlacement.kind);
        expect(firstPaintPlacement.timestamp).toBe(hydratedPlacement.timestamp);
    });
});
