import { beforeEach, describe, expect, it } from 'vitest';

import { syncPerformanceTelemetry } from '@/sync/runtime/syncPerformanceTelemetry';
import { createMessagesDomain } from './messages';
import { createPendingDomain } from './pending';

/**
 * The pending → committed CROSSOVER, observed as the store publishes it.
 *
 * `sync/domains/pending/pendingTranscriptProjection.ts` declares the contract: for one utterance
 * localId, exactly one of {pending row, committed row} may be visible "in every frame". The
 * transcript list is a pure fold over this store, so a published state in which BOTH are absent is
 * a transcript list that is one row shorter — the tail row contributes 0 px to Legend's painted
 * content height for that layout pass, which is the measured send-transition excursion
 * (`.project/reviews/2026-08-01-send-transition/`).
 *
 * These tests assert the INTERMEDIATE state, not the settled one. The settled state is already
 * correct today, so a settled-only assertion would be vacuous.
 */

type PublishedState = {
    sessionPending: Record<string, { messages: { id: string; localId?: string | null }[] }>;
    sessionMessages: Record<string, { messagesById?: Record<string, { localId?: string | null }> }>;
};

function createCrossoverHarness() {
    const published: PublishedState[] = [];
    let state: any = {
        sessions: {},
        sessionListRenderables: {},
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        machines: {},
        machineDisplayById: {},
        settings: {},
        sessionPending: {},
        sessionMessages: {},
    };

    const get = () => state;
    const set = (updater: any) => {
        const next = typeof updater === 'function' ? updater(state) : updater;
        if (next === state) return;
        state = { ...state, ...next };
        published.push(state);
    };

    const messages = createMessagesDomain({ get, set } as any);
    const pending = createPendingDomain({ get, set } as any);
    state = { ...state, ...messages, ...pending };

    return { get, published, messages, pending };
}

const SESSION_ID = 's1';
const LOCAL_ID = 'utterance-1';

function acceptedLocalOutboundProjection() {
    return {
        id: LOCAL_ID,
        localId: LOCAL_ID,
        createdAt: 1_000,
        updatedAt: 1_000,
        source: 'local_outbound' as const,
        deliveryStatus: 'accepted' as const,
        text: 'hello',
        rawRecord: { role: 'user', content: { type: 'text', text: 'hello' } } as any,
    };
}

/**
 * What the durable pending queue leaves standing after the server accepts an enqueue
 * (`sync/engine/pending/pendingQueueV2.ts#markPendingOutboxProjectionAcceptedIfOwned`): still
 * `local_outbound`/`accepted`, but carrying the outbox scope that is how the SERVER pending queue
 * addresses this row. The queue owns it, so server pending state — including "discarded" and
 * "absent" — is authoritative for it.
 */
function acceptedDurableOutboxProjection() {
    return {
        ...acceptedLocalOutboundProjection(),
        pendingOutboxScope: { serverId: 'server-a', accountId: 'account-a' },
        pendingDeliveryStatus: 'server_queued' as const,
    };
}

/**
 * The shape production ACTUALLY creates at that moment. Both call sites of
 * `markPendingOutboxProjectionAcceptedIfOwned` (`pendingQueueV2.ts:1759`, `:2041`) pass four
 * arguments, so its optional fifth writes `pendingDeliveryStatus: undefined` — the row carries the
 * outbox scope and NO server delivery status until a later push supplies one.
 *
 * This fixture exists because `acceptedDurableOutboxProjection` above cannot discriminate the
 * ownership clause: it sets `pendingDeliveryStatus` too, so the authority clause rejects it either
 * way and deleting the ownership clause leaves the whole suite green while remote-delete stranding
 * returns for the shape a real send produces.
 */
function acceptedDurableOutboxProjectionAwaitingServerStatus() {
    return {
        ...acceptedLocalOutboundProjection(),
        pendingOutboxScope: { serverId: 'server-a', accountId: 'account-a' },
    };
}

function discardedTwin(overrides?: Record<string, unknown>) {
    return {
        ...acceptedLocalOutboundProjection(),
        source: 'server_pending' as const,
        discardedAt: 2_000,
        discardedReason: 'manual',
        ...overrides,
    } as any;
}

function committedTwin() {
    return {
        id: 'committed-1',
        seq: 7,
        localId: LOCAL_ID,
        createdAt: 1_000,
        isSidechain: false,
        role: 'user',
        content: { type: 'text', text: 'hello' },
    } as any;
}

/** How many published states render NEITHER the pending row nor its committed twin. */
function countVoidFrames(published: PublishedState[]): number {
    let voidFrames = 0;
    for (const frame of published) {
        const hasPending = (frame.sessionPending[SESSION_ID]?.messages ?? [])
            .some((message) => (message.localId ?? message.id) === LOCAL_ID);
        const messagesById = frame.sessionMessages[SESSION_ID]?.messagesById ?? {};
        const hasCommitted = Object.values(messagesById)
            .some((message) => message?.localId === LOCAL_ID);
        if (!hasPending && !hasCommitted) voidFrames += 1;
    }
    return voidFrames;
}

beforeEach(() => {
    syncPerformanceTelemetry.configure({ enabled: false });
});

describe('pending domain: committed crossover publishes one transition', () => {
    it('never publishes a state with neither row when a server pending-count push races the commit', () => {
        const harness = createCrossoverHarness();
        harness.pending.upsertPendingMessage(SESSION_ID, acceptedLocalOutboundProjection());
        const beforeCrossover = harness.published.length;

        // Socket ordering B: `pending-changed` with pendingCount 0 is handled inline and
        // synchronously (sync/engine/socket/socket.ts), while the committed twin arrives a task
        // later behind message decryption and the apply coalescer.
        harness.pending.pruneServerPendingMessages(SESSION_ID);
        harness.messages.applyMessages(SESSION_ID, [committedTwin()]);

        const crossoverFrames = harness.published.slice(beforeCrossover);
        expect(countVoidFrames(crossoverFrames)).toBe(0);
        expect(crossoverFrames).toHaveLength(1);
    });

    it('never publishes a state with neither row when a server snapshot omits the uncommitted local row', () => {
        const harness = createCrossoverHarness();
        harness.pending.upsertPendingMessage(SESSION_ID, acceptedLocalOutboundProjection());
        const beforeCrossover = harness.published.length;

        // A direct send is never in the server pending queue, so a pending refresh that lands
        // between the send and the commit reconciles the bucket to a snapshot without it.
        harness.pending.applyPendingSnapshot(SESSION_ID, { messages: [], discarded: [] });
        harness.messages.applyMessages(SESSION_ID, [committedTwin()]);

        const crossoverFrames = harness.published.slice(beforeCrossover);
        expect(countVoidFrames(crossoverFrames)).toBe(0);
    });

    it('retires the pending row in the same published state that appends the committed twin', () => {
        const harness = createCrossoverHarness();
        harness.pending.upsertPendingMessage(SESSION_ID, acceptedLocalOutboundProjection());
        const beforeCrossover = harness.published.length;

        harness.messages.applyMessages(SESSION_ID, [committedTwin()]);

        expect(harness.published.slice(beforeCrossover)).toHaveLength(1);
        expect(countVoidFrames(harness.published.slice(beforeCrossover))).toBe(0);
        expect(harness.get().sessionPending[SESSION_ID].messages).toHaveLength(0);
    });

    it('still retires a locally owned row that the user cancelled and that will never commit', () => {
        const harness = createCrossoverHarness();
        harness.pending.upsertPendingMessage(SESSION_ID, acceptedLocalOutboundProjection());

        harness.pending.removePendingMessage(SESSION_ID, LOCAL_ID);

        expect(harness.get().sessionPending[SESSION_ID].messages).toHaveLength(0);
    });

    it('still prunes a server-owned pending row when the server reports an empty queue', () => {
        const harness = createCrossoverHarness();
        harness.pending.upsertPendingMessage(SESSION_ID, {
            ...acceptedLocalOutboundProjection(),
            source: 'server_pending' as const,
        });

        harness.pending.pruneServerPendingMessages(SESSION_ID);

        expect(harness.get().sessionPending[SESSION_ID].messages).toHaveLength(0);
    });
});

/**
 * Retention exists to keep the crossover one transition. It must not outlive that justification:
 * a row retired for any reason OTHER than "its committed twin is arriving" has no twin coming, so
 * retaining it strands a live-looking pending row until app restart (the store has no persist
 * middleware). The two facts that bound it are ownership and authority:
 *
 *   - OWNERSHIP — a durable outbox projection (`pendingOutboxScope` set) is addressed by the
 *     SERVER pending queue. Server pending state is authoritative for it, including "discarded"
 *     and "absent".
 *   - AUTHORITY — for a locally owned projection, a server write speaks only about the localIds it
 *     names. `sync/engine/pending/pendingQueueV2.ts#reconcileServerPendingSnapshotWithLocalOutbound`
 *     already resolves this with `serverLocalIds` = queued ∪ discarded; the store must consult the
 *     same set or the two disagree and the loser re-adds a row the winner just retired.
 */
describe('pending domain: retention does not outlive its justification', () => {
    it('does not retain a durable outbox projection the server reports discarded', () => {
        const harness = createCrossoverHarness();
        harness.pending.upsertPendingMessage(SESSION_ID, acceptedDurableOutboxProjection());

        harness.pending.applyPendingSnapshot(SESSION_ID, {
            messages: [],
            discarded: [discardedTwin()],
        });

        expect(harness.get().sessionPending[SESSION_ID].messages).toHaveLength(0);
    });

    it('does not retain a durable outbox projection the server no longer lists at all', () => {
        const harness = createCrossoverHarness();
        harness.pending.upsertPendingMessage(SESSION_ID, acceptedDurableOutboxProjection());

        // Another device deleted the queued row: it is neither queued nor discarded on the server.
        harness.pending.applyPendingSnapshot(SESSION_ID, { messages: [], discarded: [] });

        expect(harness.get().sessionPending[SESSION_ID].messages).toHaveLength(0);
    });

    it('does not retain a durable outbox projection when the server reports an empty queue', () => {
        const harness = createCrossoverHarness();
        harness.pending.upsertPendingMessage(SESSION_ID, acceptedDurableOutboxProjection());

        harness.pending.pruneServerPendingMessages(SESSION_ID);

        expect(harness.get().sessionPending[SESSION_ID].messages).toHaveLength(0);
    });

    it('does not retain a projection the server has already reported delivery state for', () => {
        const harness = createCrossoverHarness();
        harness.pending.upsertPendingMessage(SESSION_ID, {
            ...acceptedLocalOutboundProjection(),
            pendingDeliveryStatus: 'server_delivering' as const,
        });

        harness.pending.pruneServerPendingMessages(SESSION_ID);

        expect(harness.get().sessionPending[SESSION_ID].messages).toHaveLength(0);
    });

    it('does not retain a durable projection the server dropped before reporting any delivery status', () => {
        // The discriminating case for the OWNERSHIP clause on its own. Every other durable fixture
        // here also carries `pendingDeliveryStatus`, so the authority clause rejects it and the
        // ownership clause could be deleted with the suite still green — while this shape, which is
        // what a real accepted send leaves standing, would strand a live-looking pending row forever.
        const harness = createCrossoverHarness();
        harness.pending.upsertPendingMessage(SESSION_ID, acceptedDurableOutboxProjectionAwaitingServerStatus());

        // Another device deleted the queued row: the server names it nowhere — not queued, not
        // discarded — so consulting the discarded set alone would re-add it on every snapshot.
        harness.pending.applyPendingSnapshot(SESSION_ID, { messages: [], discarded: [] });

        expect(harness.get().sessionPending[SESSION_ID].messages).toHaveLength(0);
    });

    it('does not retain a locally owned projection whose localId the snapshot reports discarded', () => {
        const harness = createCrossoverHarness();
        harness.pending.upsertPendingMessage(SESSION_ID, acceptedLocalOutboundProjection());

        harness.pending.applyPendingSnapshot(SESSION_ID, {
            messages: [],
            discarded: [discardedTwin({ id: 'server-row-1' })],
        });

        expect(harness.get().sessionPending[SESSION_ID].messages).toHaveLength(0);
    });
});
