import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiUpdateContainer } from '@/sync/api/types/apiTypes';
import type { PendingMessage, Session } from '@/sync/domains/state/storageTypes';
import { clearActiveViewingSessionsForServerScopeReset } from '@/sync/domains/session/activeViewingSession';
import { storage } from '@/sync/domains/state/storage';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';
import { registerSessionRealtimeTranscriptConsumer } from '@/sync/runtime/sessionRealtimeTranscriptConsumers';
import { Encryption } from '@/sync/encryption/encryption';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { fetchAndApplyPendingMessagesV2 } from '@/sync/engine/pending/pendingQueueV2';
import { handleUpdateContainer } from './socket';

/**
 * The pending -> committed handover ACROSS THE SOCKET, which is where its two halves actually race.
 *
 * The server settles a materialization as one transaction and publishes it as two bodies, in this
 * order (`apps/server/sources/app/session/pending/acceptedPendingSettlementCoordinator.ts`):
 * the committed `new-message` first, then `pending-changed` reporting the queue empty. The client
 * receives them in that order and must not invert it: `pending-changed` with `pendingCount === 0`
 * retires the pending rows, and if it runs before the committed twin is applied, the transcript
 * publishes a frame carrying NEITHER row for that utterance — the measured iOS excursion in
 * `.project/reviews/2026-08-01-send-transition/U2-app-data-revert.md` (44 rows -> 43 with the
 * pre-send tail -> 44).
 *
 * Inversion is the default without a barrier: socket events are dispatched without awaiting the
 * previous handler, the `new-message` path always yields (it awaits the stored-message read, plus a
 * decrypt for an e2ee session) and may hand its message to the apply coalescer, while the
 * `pending-changed` branch runs straight through. These tests drive both halves the way the socket
 * does — the message handler is started and NOT awaited before the pending body is handled.
 */

const SESSION_ID = 'session-crossover';
const LOCAL_ID = 'utterance-crossover';

const initialStorageState = storage.getState();
type HandleUpdateContainerParams = Parameters<typeof handleUpdateContainer>[0];

function buildSession(id: string): Session {
    return {
        id,
        seq: 1,
        createdAt: 1_000,
        updatedAt: 1_000,
        active: true,
        activeAt: 1_000,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        encryptionMode: 'plain',
    };
}

function durableServerPendingRow(): PendingMessage {
    return {
        id: LOCAL_ID,
        localId: LOCAL_ID,
        createdAt: 1_000,
        updatedAt: 1_000,
        source: 'server_pending',
        pendingDeliveryStatus: 'server_delivering',
        text: 'hello',
        rawRecord: { role: 'user', content: { type: 'text', text: 'hello' } },
    } as PendingMessage;
}

function buildCommittedTwinUpdate(params: Readonly<{ id: string; seq: number; localId: string | null }>): ApiUpdateContainer {
    return {
        id: `update-${params.id}`,
        seq: params.seq,
        createdAt: 2_000,
        body: {
            t: 'new-message',
            sid: SESSION_ID,
            message: {
                id: params.id,
                seq: params.seq,
                localId: params.localId,
                createdAt: 2_000,
                updatedAt: 2_000,
                content: {
                    t: 'plain',
                    v: {
                        role: 'user',
                        content: { type: 'text', text: 'hello' },
                    },
                },
            },
        },
    } as ApiUpdateContainer;
}

function buildPendingChangedUpdate(params: Readonly<{ seq: number; pendingCount: number; pendingVersion: number }>): ApiUpdateContainer {
    return {
        id: `update-pending-${params.seq}`,
        seq: params.seq,
        createdAt: 2_100,
        body: {
            t: 'pending-changed',
            sid: SESSION_ID,
            sessionId: SESSION_ID,
            pendingVersion: params.pendingVersion,
            pendingCount: params.pendingCount,
        },
    } as ApiUpdateContainer;
}

function buildEmptyQueueUpdate(seq: number): ApiUpdateContainer {
    return buildPendingChangedUpdate({ seq, pendingCount: 0, pendingVersion: 4 });
}

function buildBaseParams(overrides: Partial<Omit<HandleUpdateContainerParams, 'updateData'>> = {}) {
    return {
        encryption: {
            getSessionEncryption: () => null,
            getMachineEncryption: () => null,
            removeSessionEncryption: () => {},
            decryptEncryptionKey: vi.fn(async () => null as Uint8Array | null),
            initializeMachines: vi.fn(async () => {}),
        } as unknown as HandleUpdateContainerParams['encryption'],
        artifactDataKeys: new Map(),
        applySessions: vi.fn(),
        fetchSessions: vi.fn(),
        applyMessages: (sessionId: string, messages: any) => storage.getState().applyMessages(sessionId, messages),
        onSessionVisible: vi.fn(),
        isSessionMessagesLoaded: vi.fn(() => true),
        getSessionMaterializedMaxSeq: vi.fn(() => 1),
        markSessionMaterializedMaxSeq: vi.fn(),
        onMessageGapDetected: vi.fn(),
        markSessionKnownRemoteSeq: vi.fn(),
        markSessionTranscriptDeferred: vi.fn(),
        markSessionTranscriptStale: vi.fn(),
        assumeUsers: vi.fn(async () => {}),
        applyTodoSocketUpdates: vi.fn(async () => {}),
        invalidateMachines: vi.fn(),
        invalidateSessions: vi.fn(),
        invalidateArtifacts: vi.fn(),
        invalidateFriends: vi.fn(),
        invalidateFriendRequests: vi.fn(),
        invalidateFeed: vi.fn(),
        invalidateAutomations: vi.fn(),
        invalidateTodos: vi.fn(),
        log: { log: vi.fn() },
        ...overrides,
    };
}

/** Does this published state carry a row — pending OR committed — for the utterance? */
function carriesTheUtterance(state: ReturnType<typeof storage.getState>): boolean {
    const pending = state.sessionPending[SESSION_ID]?.messages ?? [];
    if (pending.some((message) => (message.localId ?? message.id) === LOCAL_ID)) return true;
    const messagesById = state.sessionMessages[SESSION_ID]?.messagesById ?? {};
    return Object.values(messagesById).some((message: any) => message?.localId === LOCAL_ID);
}

describe('socket pending -> committed ordering', () => {
    let unregisterConsumer: (() => void) | null = null;
    let unsubscribe: (() => void) | null = null;

    beforeEach(() => {
        storage.setState(initialStorageState, true);
        projectManager.clear();
        clearActiveViewingSessionsForServerScopeReset();
        unregisterConsumer = registerSessionRealtimeTranscriptConsumer(SESSION_ID);
    });

    afterEach(() => {
        unsubscribe?.();
        unsubscribe = null;
        unregisterConsumer?.();
        unregisterConsumer = null;
        storage.setState(initialStorageState, true);
        projectManager.clear();
        clearActiveViewingSessionsForServerScopeReset();
    });

    function armSession(coalescing: Readonly<{ enabled: boolean; windowMs: number }>) {
        storage.getState().applySessions([buildSession(SESSION_ID)]);
        storage.setState((state: any) => ({
            settings: {
                ...state.settings,
                transcriptStreamingCoalesceEnabled: coalescing.enabled,
                transcriptStreamingCoalesceWindowMs: coalescing.windowMs,
                transcriptStreamingCoalesceMaxBatchSize: 64,
            },
        }));
        storage.getState().upsertPendingMessage(SESSION_ID, durableServerPendingRow());

        const framesWithoutTheUtterance: number[] = [];
        let frame = 0;
        unsubscribe = storage.subscribe((state) => {
            frame += 1;
            if (!carriesTheUtterance(state as any)) framesWithoutTheUtterance.push(frame);
        });
        return framesWithoutTheUtterance;
    }

    it('does not retire the pending row before the committed twin it is the receipt for', async () => {
        const framesWithoutTheUtterance = armSession({ enabled: false, windowMs: 0 });
        const params = buildBaseParams();

        // The socket dispatches handlers without awaiting the previous one.
        const committing = handleUpdateContainer({
            ...params,
            updateData: buildCommittedTwinUpdate({ id: 'committed-1', seq: 2, localId: LOCAL_ID }),
        });
        await handleUpdateContainer({ ...params, updateData: buildEmptyQueueUpdate(3) });
        await committing;

        expect(framesWithoutTheUtterance).toEqual([]);
        expect(storage.getState().sessionPending[SESSION_ID]?.messages ?? []).toHaveLength(0);
        expect(carriesTheUtterance(storage.getState())).toBe(true);
    });

    it('materializes messages queued in the apply coalescer before retiring the pending rows', async () => {
        const framesWithoutTheUtterance = armSession({ enabled: true, windowMs: 200 });
        const params = buildBaseParams();

        // A leading message opens the coalescer window, so the twin behind it is queued, not applied.
        await handleUpdateContainer({
            ...params,
            updateData: buildCommittedTwinUpdate({ id: 'unrelated-1', seq: 2, localId: null }),
        });
        const committing = handleUpdateContainer({
            ...params,
            updateData: buildCommittedTwinUpdate({ id: 'committed-1', seq: 3, localId: LOCAL_ID }),
        });
        await handleUpdateContainer({ ...params, updateData: buildEmptyQueueUpdate(4) });
        await committing;

        expect(framesWithoutTheUtterance).toEqual([]);
        expect(storage.getState().sessionPending[SESSION_ID]?.messages ?? []).toHaveLength(0);
        expect(carriesTheUtterance(storage.getState())).toBe(true);
    });

    /**
     * The barrier delays only the ROW RETIREMENT. The session-level pending count is a whole-session
     * write through `socketSessionApplyCoalescer`, and the next body builds on the QUEUED session
     * (`getSocketSessionApplyBase`), so deferring that write would let a newer `pending-changed`
     * apply first and then be overwritten by this older, smaller count — a session listed as having
     * an empty queue while a message is still queued in it.
     */
    it('does not let a delayed empty-queue body overwrite a newer pending count', async () => {
        armSession({ enabled: false, windowMs: 0 });
        const params = buildBaseParams({
            applySessions: (sessions: any) => storage.getState().applySessions(sessions),
        });

        const committing = handleUpdateContainer({
            ...params,
            updateData: buildCommittedTwinUpdate({ id: 'committed-1', seq: 2, localId: LOCAL_ID }),
        });
        // The empty-queue body is held by the barrier; the user's NEXT message is queued meanwhile.
        const retiring = handleUpdateContainer({ ...params, updateData: buildEmptyQueueUpdate(3) });
        await handleUpdateContainer({
            ...params,
            updateData: buildPendingChangedUpdate({ seq: 4, pendingCount: 1, pendingVersion: 5 }),
        });
        await retiring;
        await committing;
        await new Promise((resolve) => setTimeout(resolve, 80));

        const session = storage.getState().sessions[SESSION_ID];
        expect(session?.pendingCount).toBe(1);
        expect(session?.pendingVersion).toBe(5);
    });

    /**
     * The SECOND writer that retires pending rows. `pending-changed` is not the only receipt for a
     * materialization: a pending snapshot captured after the settlement transaction answers with an
     * EMPTY queue, and `SessionPendingMessagesRefresh` re-issues that GET on every `pendingVersion`
     * change — i.e. on the very body that reports the settlement. On a client whose committed twin
     * is still being read/decrypted, that empty response retires the row while the twin has not
     * landed, which is the same void frame from the other transport.
     */
    it('does not let an empty pending snapshot retire the row before the committed twin lands', async () => {
        // The twin is RECEIVED but not yet applied: it sits in the apply coalescer's open window,
        // which is the state a slow client is in for as long as that window lasts.
        const framesWithoutTheUtterance = armSession({ enabled: true, windowMs: 200 });
        const params = buildBaseParams();
        const server = upsertServerProfile({ serverUrl: 'https://crossover.example.test', name: 'Crossover' });
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));

        await handleUpdateContainer({
            ...params,
            updateData: buildCommittedTwinUpdate({ id: 'unrelated-1', seq: 2, localId: null }),
        });
        const committing = handleUpdateContainer({
            ...params,
            updateData: buildCommittedTwinUpdate({ id: 'committed-1', seq: 3, localId: LOCAL_ID }),
        });
        await fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: { serverId: server.id, accountId: 'account' },
            isOutboxScopeCurrent: () => true,
            request: async () => new Response(
                JSON.stringify({ pending: [] }),
                { status: 200, headers: { 'Content-Type': 'application/json' } },
            ),
        });
        await committing;

        expect(framesWithoutTheUtterance).toEqual([]);
        expect(carriesTheUtterance(storage.getState())).toBe(true);
    });

    it('still retires the pending rows when no message materialization is in flight', async () => {
        armSession({ enabled: false, windowMs: 0 });
        const params = buildBaseParams();

        await handleUpdateContainer({ ...params, updateData: buildEmptyQueueUpdate(2) });

        expect(storage.getState().sessionPending[SESSION_ID]?.messages ?? []).toHaveLength(0);
    });
});
