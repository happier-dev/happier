import { afterEach, describe, expect, it, vi } from 'vitest';

import { Encryption } from '@/sync/encryption/encryption';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import {
    buildSessionListRenderableFromSession,
    preserveSessionListRenderableStaleFields,
    preserveSessionListRenderableTransientState,
    type SessionListRenderableSession,
} from '@/sync/domains/session/listing/sessionListRenderable';
import type { Session } from '@/sync/domains/state/storageTypes';
import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import type { V2SessionRecord } from '@happier-dev/protocol';

import { fetchAndApplySessions, type SessionListEncryption } from './sessionSnapshot';

vi.mock('@/voice/context/voiceHooks', () => ({
    voiceHooks: { onAgentRequest: vi.fn() },
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({
        serverId: 'test',
        serverUrl: 'https://example.test',
        kind: 'custom',
        generation: 1,
    }),
}));

const SESSION_ID = 'session_redundant_decrypt';
const CREATED_AT = 1_699_000_000_000;

type RowMovement = Readonly<{
    seq: number;
    updatedAt: number;
    metadataVersion: number;
    runtimeActivityRevision: number;
    runtimeActivityObservedAt: number;
}>;

/**
 * An encrypted row carrying the full runtime-activity projection the server
 * always emits (`mapV2SessionListRow` spreads all four fields), so the
 * projection parses as `valid` exactly as it does on the wire.
 */
function buildEncryptedRow(movement: RowMovement): V2SessionRecord {
    return {
        id: SESSION_ID,
        seq: movement.seq,
        createdAt: CREATED_AT,
        updatedAt: movement.updatedAt,
        meaningfulActivityAt: movement.updatedAt,
        active: true,
        activeAt: movement.updatedAt,
        archivedAt: null,
        encryptionMode: 'e2ee',
        metadata: `ciphertext-metadata-v${movement.metadataVersion}`,
        metadataVersion: movement.metadataVersion,
        agentState: 'ciphertext-agent-state-v1',
        agentStateVersion: 1,
        lastViewedSessionSeq: 0,
        pendingPermissionRequestCount: 0,
        pendingUserActionRequestCount: 0,
        pendingBlockedCount: 0,
        pendingCount: 0,
        pendingVersion: 1,
        latestTurnStatus: 'running',
        latestTurnStatusObservedAt: movement.updatedAt,
        runtimeActivityState: 'active',
        runtimeActivityActiveCount: 1,
        runtimeActivityObservedAt: movement.runtimeActivityObservedAt,
        runtimeActivityRevision: movement.runtimeActivityRevision,
        dataEncryptionKey: null,
        share: null,
        unreadSince: null,
    } as unknown as V2SessionRecord;
}

/** The shape `fetchAndApplySessions` hands to `applySessions`: presence unresolved. */
type AppliedSession = Omit<Session, 'presence'> & {
    presence?: 'online' | number;
    metadataUnavailable?: boolean;
};

function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}

/**
 * Mirrors the store owner: `replaceSessionListRenderables` runs the incoming
 * renderable through the same two preserve helpers before committing, so a
 * renderable whose metadata could not be rebuilt keeps the previously decrypted
 * plaintext *and* its older `metadataVersion`.
 */
function createStoreHarness() {
    const renderables = new Map<string, SessionListRenderableSession>();
    const sessions = new Map<string, Session>();

    return {
        renderables,
        sessions,
        applySessionListRenderables: (incoming: SessionListRenderableSession[]): void => {
            for (const next of incoming) {
                const previous = renderables.get(next.id);
                renderables.set(next.id, preserveSessionListRenderableTransientState(
                    previous,
                    preserveSessionListRenderableStaleFields(previous, next),
                ));
            }
        },
        applySessionListRenderablePatches: (
            patches: readonly Readonly<{ sessionId: string; patch: object }>[],
        ): void => {
            for (const { sessionId, patch } of patches) {
                const previous = renderables.get(sessionId);
                if (!previous) continue;
                renderables.set(sessionId, { ...previous, ...patch });
            }
        },
        // The store's `applySessions` commits the decrypted session AND refreshes
        // the row's renderable from it, so hydration publishes the plaintext to
        // both readers the snapshot consults.
        applySessions: (incoming: AppliedSession[]): void => {
            for (const session of incoming) {
                const stored = { ...session, presence: session.presence ?? session.activeAt } as Session;
                sessions.set(stored.id, stored);
                const previous = renderables.get(stored.id);
                renderables.set(stored.id, preserveSessionListRenderableTransientState(
                    previous,
                    buildSessionListRenderableFromSession(stored),
                ));
            }
        },
    };
}

type DecryptCounter = Readonly<{ calls: () => number }>;

function createEncryptionHarness(counter: { count: number }): SessionListEncryption & DecryptCounter {
    const sessionEncryption = {
        decryptMetadata: async () => ({ path: '/repo', host: 'host', name: 'session' }),
        decryptAgentState: async () => ({}),
        decryptSessionSnapshotState: async (metadataVersion: number) => {
            counter.count += 1;
            return {
                metadata: { path: '/repo', host: 'host', name: `session-v${metadataVersion}` },
                agentState: {},
            };
        },
    };
    return {
        decryptEncryptionKeys: vi.fn(async (values: readonly string[]) => values.map(() => null)),
        initializeSessions: vi.fn(async () => {}),
        removeSessionEncryption: vi.fn(),
        getSessionEncryption: vi.fn(() => sessionEncryption),
        calls: () => counter.count,
    };
}

type SnapshotHarness = Readonly<{
    run: (movement: RowMovement) => Promise<void>;
    decryptCalls: () => number;
}>;

/** Lets the fire-and-forget background hydration reach its final flush. */
async function settleBackgroundHydration(): Promise<void> {
    for (let tick = 0; tick < 8; tick += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
}

/**
 * `withStoredSessions: false` reproduces the caller that cannot consult the
 * decrypted session store (`concurrentSessionCache` passes
 * `getExistingSession: () => null`), which is the only shape that reaches
 * `isCurrentRenderableCompleteForWarmHydration`.
 *
 * `required` reproduces the visible/route rows the app names in
 * `requiredHydrationSessionIds` on every foreground refresh.
 */
function createSnapshotHarness(options: Readonly<{
    withStoredSessions: boolean;
    required?: boolean;
}>): SnapshotHarness {
    const store = createStoreHarness();
    const counter = { count: 0 };
    const encryption = createEncryptionHarness(counter);
    const required = options.required === true;

    return {
        decryptCalls: () => counter.count,
        run: async (movement) => {
            await fetchAndApplySessions({
                serverId: 'test',
                credentials: { token: 't', secret: 's' } as AuthCredentials,
                encryption,
                sessionDataKeys: new Map<string, Uint8Array>([[SESSION_ID, new Uint8Array(32)]]),
                request: async () => jsonResponse({
                    sessions: [buildEncryptedRow(movement)],
                    nextCursor: null,
                    hasNext: false,
                }),
                getExistingSession: (sessionId) => (
                    options.withStoredSessions ? store.sessions.get(sessionId) ?? null : null
                ),
                getCurrentSessionListRenderable: (sessionId) => store.renderables.get(sessionId) ?? null,
                applySessionListRenderables: store.applySessionListRenderables,
                applySessionListRenderablePatches: store.applySessionListRenderablePatches,
                applySessions: store.applySessions,
                ...(required ? { requiredHydrationSessionIds: [SESSION_ID] } : {}),
                awaitSessionListHydration: required,
                sessionListBackgroundHydrationApplyFlushDelayMs: 0,
                sessionListBackgroundHydrationYieldDelayMs: 0,
                repairInvalidReadStateV1: async () => {},
                log: { log: () => {} },
            });
            await settleBackgroundHydration();
        },
    };
}

const FIRST: RowMovement = {
    seq: 10,
    updatedAt: CREATED_AT + 1_000,
    metadataVersion: 3,
    runtimeActivityRevision: 5,
    runtimeActivityObservedAt: CREATED_AT + 1_000,
};
/** A streaming tick: seq, updatedAt and the runtime-activity projection all move. */
const STREAMING_TICK: RowMovement = {
    seq: 11,
    updatedAt: CREATED_AT + 2_000,
    metadataVersion: 3,
    runtimeActivityRevision: 6,
    runtimeActivityObservedAt: CREATED_AT + 2_000,
};
/** A genuine metadata write: the plaintext changed, so the version advanced. */
const METADATA_WRITE: RowMovement = {
    seq: 12,
    updatedAt: CREATED_AT + 3_000,
    metadataVersion: 4,
    runtimeActivityRevision: 7,
    runtimeActivityObservedAt: CREATED_AT + 3_000,
};

afterEach(() => {
    vi.clearAllMocks();
    syncPerformanceTelemetry.configure({ enabled: false });
});

describe('session-list snapshot metadata decryption', () => {
    it('keeps plain sessions readable when a keyless account also has unavailable encrypted history', async () => {
        const encrypted = { ...buildEncryptedRow(FIRST), dataEncryptionKey: 'unavailable-history-key' };
        const metadata = { path: '/plain/project', host: 'plain-host' };
        const plain = { ...buildEncryptedRow(FIRST), id: 'session-plain', encryptionMode: 'plain', metadata: JSON.stringify(metadata), agentState: null, dataEncryptionKey: null };
        const sessions: Array<{ id: string; metadata: unknown }> = [];
        await fetchAndApplySessions({
            credentials: { token: 'plain-token' },
            encryption: Encryption.createWithoutKeyMaterial(),
            sessionDataKeys: new Map(),
            request: async () => jsonResponse({ sessions: [encrypted, plain], nextCursor: null, hasNext: false }),
            applySessions: (values) => sessions.push(...values),
            repairInvalidReadStateV1: async () => {},
            log: { log: () => {} },
        });
        expect(sessions.find((session) => session.id === 'session-plain')?.metadata).toEqual(expect.objectContaining(metadata));
        expect(sessions.find((session) => session.id === encrypted.id)?.metadata ?? null).toBeNull();
    });

    it('does not re-decrypt unchanged metadata when a streaming tick moves seq and runtime activity', async () => {
        const harness = createSnapshotHarness({ withStoredSessions: true });

        await harness.run(FIRST);
        const afterFirstPaint = harness.decryptCalls();
        expect(afterFirstPaint).toBe(1);

        await harness.run(STREAMING_TICK);

        expect(harness.decryptCalls()).toBe(afterFirstPaint);
    });

    it('re-decrypts exactly once when metadataVersion advances', async () => {
        const harness = createSnapshotHarness({ withStoredSessions: true });

        await harness.run(FIRST);
        await harness.run(STREAMING_TICK);
        const beforeMetadataWrite = harness.decryptCalls();

        await harness.run(METADATA_WRITE);

        expect(harness.decryptCalls()).toBe(beforeMetadataWrite + 1);
    });

    it('does not re-decrypt unchanged metadata for a caller without the decrypted session store', async () => {
        const harness = createSnapshotHarness({ withStoredSessions: false });

        await harness.run(FIRST);
        const afterFirstPaint = harness.decryptCalls();
        expect(afterFirstPaint).toBe(1);

        await harness.run(STREAMING_TICK);

        expect(harness.decryptCalls()).toBe(afterFirstPaint);
    });

    it('does not re-decrypt unchanged metadata for a row named in requiredHydrationSessionIds', async () => {
        const harness = createSnapshotHarness({ withStoredSessions: true, required: true });

        await harness.run(FIRST);
        const afterFirstPaint = harness.decryptCalls();
        expect(afterFirstPaint).toBe(1);

        await harness.run(STREAMING_TICK);

        expect(harness.decryptCalls()).toBe(afterFirstPaint);
    });

    it('re-decrypts a required row exactly once when metadataVersion advances', async () => {
        const harness = createSnapshotHarness({ withStoredSessions: true, required: true });

        await harness.run(FIRST);
        await harness.run(STREAMING_TICK);
        const beforeMetadataWrite = harness.decryptCalls();

        await harness.run(METADATA_WRITE);

        expect(harness.decryptCalls()).toBe(beforeMetadataWrite + 1);
    });

    it('still republishes the moved runtime-activity projection while reusing the payload', async () => {
        // The keystone: reuse must not degrade into "skip the row". A required
        // row's scalars move on every streaming tick and have to reach the
        // stored session even though the encrypted payload did not change.
        const store = createStoreHarness();
        const counter = { count: 0 };
        const encryption = createEncryptionHarness(counter);
        const run = async (movement: RowMovement): Promise<void> => {
            await fetchAndApplySessions({
                serverId: 'test',
                credentials: { token: 't', secret: 's' } as AuthCredentials,
                encryption,
                sessionDataKeys: new Map<string, Uint8Array>([[SESSION_ID, new Uint8Array(32)]]),
                request: async () => jsonResponse({
                    sessions: [buildEncryptedRow(movement)],
                    nextCursor: null,
                    hasNext: false,
                }),
                getExistingSession: (sessionId) => store.sessions.get(sessionId) ?? null,
                getCurrentSessionListRenderable: (sessionId) => store.renderables.get(sessionId) ?? null,
                applySessionListRenderables: store.applySessionListRenderables,
                applySessionListRenderablePatches: store.applySessionListRenderablePatches,
                applySessions: store.applySessions,
                requiredHydrationSessionIds: [SESSION_ID],
                awaitSessionListHydration: true,
                sessionListBackgroundHydrationApplyFlushDelayMs: 0,
                sessionListBackgroundHydrationYieldDelayMs: 0,
                repairInvalidReadStateV1: async () => {},
                log: { log: () => {} },
            });
            await settleBackgroundHydration();
        };

        await run(FIRST);
        expect(store.sessions.get(SESSION_ID)?.runtimeActivityRevision).toBe(FIRST.runtimeActivityRevision);

        await run(STREAMING_TICK);

        const stored = store.sessions.get(SESSION_ID);
        expect(stored?.runtimeActivityRevision).toBe(STREAMING_TICK.runtimeActivityRevision);
        expect(stored?.runtimeActivityObservedAt).toBe(STREAMING_TICK.runtimeActivityObservedAt);
        expect(stored?.seq).toBe(STREAMING_TICK.seq);
        // ...and it cost no decrypt.
        expect(counter.count).toBe(1);
    });

    it('still hydrates a required row whose plaintext is not in the decrypted session store', async () => {
        // The row being opened has only the warm-cache projection behind its
        // renderable, so reusing it would leave the session screen without real
        // metadata. Freshness evidence must come from the decrypted session.
        const harness = createSnapshotHarness({ withStoredSessions: false, required: true });

        await harness.run(FIRST);
        await harness.run(STREAMING_TICK);

        expect(harness.decryptCalls()).toBe(2);
    });
});
