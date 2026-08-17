import { beforeEach, describe, expect, it } from 'vitest';

import { Encryption } from '@/sync/encryption/encryption';
import { storage } from '@/sync/domains/state/storage';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';

import {
    enqueuePendingMessageV2,
    fetchAndApplyPendingMessagesV2,
    updatePendingRequestedActionV2,
} from './pendingQueueV2';
import { buildSession, currentPendingEnqueueAck, resetPendingQueueState } from './pendingQueueV2.testHelpers';

/**
 * The DECISION TABLE of `withholdPendingRowsCommittedAfterSnapshotCapture`, taken by ordering.
 *
 * The fence withholds a snapshot row when its committed twin was SEQUENCED ABOVE the session
 * sequence high-water mark this client held when the request was issued. The shape measured on the
 * sibling build for the flap is `source: 'server_pending'`, no `pendingOutboxScope`,
 * `pendingDeliveryStatus: 'server_queued'`
 * (`.project/reviews/2026-08-07-snapshot-readdition/DESIGN.md`) — and it was measured with a LOADED
 * transcript of 106 rows, which is why `armSession` seeds one: an empty, never-loaded transcript is
 * the session-open state, where the fence must assert nothing at all.
 *
 * The capture point must be the RESPONSE's, not the caller's: a refresh that starts while another
 * refresh for the same scoped session is still running can be answered by that refresh's in-flight
 * GET, because `apiSocket.request` shares one in-flight GET among callers and drops the de-dupe entry
 * only in the FIRST caller's continuation. So:
 *
 *   A / B — the twin is a NEW commit above the mark, applied after the request was issued:
 *           withheld.
 *   C     — no refresh in flight, transcript already carried the twin at capture: republished. This
 *           is the durable-coexistence contract; it must not flip.
 *   D     — a second refresh inherits the in-flight mark, but the twin it learns about is OLD news
 *           (sequenced below the mark): republished. Inheritance must not hide a durable row.
 *   E     — the same inheritance with a NEW commit above the mark and one shared response: withheld.
 */

const SESSION_ID = 'readdition-session';
const LOCAL_ID = 'readdition-local';
/** Ordering F: a row the server already held when the shared pre-ACK read was taken. */
const SEED_LOCAL_ID = 'readdition-seed-local';
/** Ordering F: the utterance the server ACKs while that read is outstanding. */
const ACCEPTED_LOCAL_ID = 'readdition-accepted-local';
/** The session tail this client had already loaded before any request below was issued. */
const LOADED_HEAD_SEQ = 6;

/**
 * The mapped shape of a queued server row in THIS repo. It differs from the sibling build, where the
 * snapshot mapping leaves `pendingOutboxScope` unset: here `fetchAndApplyPendingMessagesV2` stamps
 * `pendingOutboxScope: params.outboxScope` onto every server-mapped row, so `scoped` is true.
 */
const REPUBLISHED_ROW = {
    localId: LOCAL_ID,
    source: 'server_pending',
    pendingDeliveryStatus: 'server_queued',
    scoped: true,
} as const;

function committedTwin(localId: string | null, seq = LOADED_HEAD_SEQ + 1) {
    return {
        id: `committed-${localId ?? 'none'}-${seq}`,
        seq,
        localId,
        createdAt: 2_000,
        isSidechain: false,
        role: 'user',
        content: { type: 'text', text: 'hello' },
    } as any;
}

function queuedRowResponse(localId: string): Response {
    return new Response(JSON.stringify({
        pending: [{
            localId,
            content: {
                t: 'plain',
                v: { role: 'user', content: { type: 'text', text: 'hello' }, meta: {} },
            },
            requestedAction: { v: 1, kind: 'enqueue' },
            status: 'queued',
            // A genuinely queued server row carries no deliveryState — this repo's parser treats any
            // value outside delivering|external_handoff|blocked as malformed and blocks the row.
            deliveryState: null,
            position: 0,
            createdAt: 1_000,
            updatedAt: 1_100,
            discardedAt: null,
            discardedReason: null,
        }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function publishedPending(): Array<Readonly<{
    localId: string;
    source: PendingMessage['source'];
    pendingDeliveryStatus: PendingMessage['pendingDeliveryStatus'];
    scoped: boolean;
}>> {
    return (storage.getState().sessionPending[SESSION_ID]?.messages ?? []).map((message: PendingMessage) => ({
        localId: message.localId ?? message.id,
        source: message.source,
        pendingDeliveryStatus: message.pendingDeliveryStatus,
        scoped: message.pendingOutboxScope !== undefined,
    }));
}

function publishedLocalIds(): string[] {
    return publishedPending().map((message) => message.localId);
}

function committedTranscriptLocalIds(): string[] {
    const sessionMessages = storage.getState().sessionMessages[SESSION_ID];
    if (!sessionMessages) return [];
    return (sessionMessages.messageIdsOldestFirst ?? [])
        .map((id: string) => {
            // Not every transcript message kind carries a localId (agent events do not).
            const message = sessionMessages.messagesById?.[id];
            return message && 'localId' in message ? message.localId : null;
        })
        .filter((localId): localId is string => typeof localId === 'string');
}

describe('pending snapshot re-addition after a committed twin', () => {
    beforeEach(() => resetPendingQueueState());

    function armSession() {
        const server = upsertServerProfile({ serverUrl: 'https://readdition.example.test', name: 'Readdition' });
        storage.getState().applySessions([{
            ...buildSession({ sessionId: SESSION_ID }),
            encryptionMode: 'plain',
            seq: LOADED_HEAD_SEQ,
        }]);
        // The flap was measured on an OPEN session with its transcript loaded; the fence asserts
        // nothing until the transcript is a basis, so the loaded tail is part of the flap's shape.
        storage.getState().applyMessages(SESSION_ID, [committedTwin('readdition-loaded-tail', LOADED_HEAD_SEQ)]);
        storage.getState().applyMessagesLoaded(SESSION_ID);
        return { serverId: server.id, accountId: 'account' } as const;
    }

    /** A — twin committed while the GET is outstanding: withheld. */
    it('withholds a row whose twin commits while the request is outstanding', async () => {
        const scope = armSession();
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });

        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => { await gate; return queuedRowResponse(LOCAL_ID); },
        });
        storage.getState().applyMessages(SESSION_ID, [committedTwin(LOCAL_ID)]);
        release();
        await refresh;

        expect(publishedPending()).toEqual([]);
    });

    /** B — twin committed after the response, before the publish: withheld. */
    it('withholds a row whose twin commits between the response and the publish', async () => {
        const scope = armSession();
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));

        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => queuedRowResponse(LOCAL_ID),
        });
        await Promise.resolve();
        storage.getState().applyMessages(SESSION_ID, [committedTwin(LOCAL_ID)]);
        await refresh;

        expect(publishedPending()).toEqual([]);
    });

    /**
     * C — the twin was already in the transcript when the refresh captured, so it RAISED the mark to
     * its own `seq` and cannot be above it; the fence's above-the-mark test simply does not select
     * it. This is no longer a named exemption: "escape hatch" belonged to the superseded
     * set-membership predicate, which had to carve this case out explicitly (`committedNow &&
     * !committedAtCapture`) because membership alone could not tell it from a settlement.
     */
    it('republishes a row whose twin was already committed at capture', async () => {
        const scope = armSession();
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));
        storage.getState().applyMessages(SESSION_ID, [committedTwin(LOCAL_ID)]);

        await fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => queuedRowResponse(LOCAL_ID),
        });

        expect(publishedPending()).toEqual([REPUBLISHED_ROW]);
    });

    /**
     * E — the live chain: `apiSocket.request` de-dupes in-flight GETs by URL and only deletes the map
     * entry in the FIRST caller's continuation, so on a congested thread a refresh that starts AFTER
     * the committed twin still adopts the response of a GET issued BEFORE it — with no second request
     * on the wire. The adopting refresh would capture AFTER the twin, taking a mark that already
     * includes it, so the settled row is republished, unless the adopting refresh inherits the
     * in-flight refresh's capture point, which is the response's own.
     */
    it('withholds a row when a late refresh adopts an in-flight response captured before the twin', async () => {
        const scope = armSession();
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));

        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        // One server read, shared by both refreshes — the in-flight de-dupe, modelled.
        const sharedRead = (async () => { await gate; return queuedRowResponse(LOCAL_ID); })();
        const dedupedRequest = async () => (await sharedRead).clone();

        const first = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: dedupedRequest,
        });
        // The settlement lands while the read is outstanding: twin applied, then the pendingVersion
        // bump schedules the next refresh, which starts before the first caller's continuation has
        // run and therefore adopts the very same response.
        release();
        storage.getState().applyMessages(SESSION_ID, [committedTwin(LOCAL_ID)]);
        const second = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: dedupedRequest,
        });
        await Promise.all([first, second]);

        expect(publishedPending()).toEqual([]);
        // Withholding may never leave the utterance with NO row. This repo does not carry the
        // sibling's store-side crossover retention (`fix(ui-pending): make committed-message
        // crossover atomic`), so prove the twin holds the slot rather than assuming it: the fence
        // only withholds a localId whose committed twin is in the transcript above the mark, so a
        // withhold is always paired with a committed twin already there.
        expect(committedTranscriptLocalIds()).toEqual(['readdition-loaded-tail', LOCAL_ID]);
    });

    /**
     * D — a second refresh starts while the first is still outstanding and inherits its mark, but
     * the twin it learns about is OLD news.
     *
     * This ordering is NOT the flap, and the previous round asserted a withhold for it in error:
     * the second refresh issues its OWN request, whose response is therefore genuinely fresh — and
     * a fresh response cannot list a row a settlement just deleted. A response that still lists the
     * row is the server asserting it still owns it, i.e. the durable-coexistence shape (7 such rows
     * live on the sibling deployment's server, 3 of them blocked/`delivery_outcome_uncertain`).
     * Withholding here hides a real queued message, which is worse than the flap. Only ordering E —
     * where BOTH refreshes are answered by one shared, pre-settlement read — is the flap.
     */
    /**
     * F — the OTHER half of the same capture point, taken by the same ordering as E.
     *
     * The token carries two capture-time facts: the session-sequence mark above, and the set of
     * localIds the SERVER acknowledged after the request was issued. The accepted set is the fence
     * against message loss: a response read before an ACK cannot list the row that ACK created, so
     * applying it deletes a message the user sent and the server already owns
     * (`pendingSnapshotRepresentsAcceptedLocalIdsAfterCapture`, which iterates the set — an EMPTY
     * set is the trivially-passing state, so forgetting an accept is silent).
     *
     * `markPendingLocalIdAcceptedAfterSnapshotCapture` records an accepted localId on the LATEST token
     * only — the map holds one token per scoped session — so every accept recorded while the
     * predecessor was latest lives on the predecessor. A successor that adopts the predecessor's
     * in-flight response therefore has to carry those accepts too, for exactly the reason the
     * sequence mark is inherited: the capture point belongs to the RESPONSE.
     */
    it('withholds an adopted pre-ACK response that omits a localId accepted while it was in flight', async () => {
        const scope = armSession();
        setActiveServerId(scope.serverId, { scope: 'tab' });
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));

        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        // One server read, shared by both refreshes — the in-flight de-dupe, modelled. It was read
        // BEFORE the enqueue below was accepted, so it lists only the row that already existed.
        const sharedRead = (async () => { await gate; return queuedRowResponse(SEED_LOCAL_ID); })();
        const dedupedRequest = async () => (await sharedRead).clone();

        const first = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: dedupedRequest,
        });

        // The user sends while that read is outstanding and the server ACKs the enqueue.
        await enqueuePendingMessageV2({
            sessionId: SESSION_ID,
            localId: ACCEPTED_LOCAL_ID,
            text: 'accepted while the snapshot read was outstanding',
            encryption,
            outboxScope: scope,
            serverWireMode: 'pending_input_v1',
            request: async (_path, init) => currentPendingEnqueueAck(init),
        });
        expect(publishedLocalIds()).toEqual([ACCEPTED_LOCAL_ID]);

        // The ACK bumps `pendingVersion`, which schedules the next refresh; it starts before the
        // first caller's continuation has run and is answered by that same pre-ACK read.
        const second = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: dedupedRequest,
        });
        release();
        await Promise.all([first, second]);

        expect(publishedLocalIds()).toEqual([ACCEPTED_LOCAL_ID]);
    });

    /**
     * G — ordering F with one ordinary step inserted: the user edits a queued row's requested action
     * while the same pre-ACK read is still outstanding.
     *
     * `updatePendingRequestedActionV2` (and `updatePendingMessageV2`) invalidate the in-flight
     * snapshot refresh, because a read issued BEFORE the PATCH must not overwrite the projection the
     * PATCH just wrote. That job is real. But the invalidation was expressed by DELETING the map
     * entry, which also erased the capture-time facts the successor inherits — so the successor took
     * a fresh EMPTY accepted set while the predecessor's pre-ACK GET was still outstanding and could
     * still answer it. An empty set is the trivially-passing state of
     * `pendingSnapshotRepresentsAcceptedLocalIdsAfterCapture`, so the pre-ACK response applied and
     * deleted a row the user sent and the server already owns.
     *
     * The two facts on the token have OPPOSITE failure directions — losing the sequence mark
     * republishes a settled row (a flap), losing an accept DROPS a message — but neither is made
     * invalid by a PATCH: the response's capture point is a property of the response, and the PATCH
     * does not move it. So the invalidation must discard the refresh's AUTHORITY only.
     */
    it('keeps a localId accepted in flight when a requested-action PATCH invalidates the refresh', async () => {
        const scope = armSession();
        setActiveServerId(scope.serverId, { scope: 'tab' });
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));

        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const sharedRead = (async () => { await gate; return queuedRowResponse(SEED_LOCAL_ID); })();
        const dedupedRequest = async () => (await sharedRead).clone();

        const first = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: dedupedRequest,
        });

        await enqueuePendingMessageV2({
            sessionId: SESSION_ID,
            localId: ACCEPTED_LOCAL_ID,
            text: 'accepted while the snapshot read was outstanding',
            encryption,
            outboxScope: scope,
            serverWireMode: 'pending_input_v1',
            request: async (_path, init) => currentPendingEnqueueAck(init),
        });
        expect(publishedLocalIds()).toEqual([ACCEPTED_LOCAL_ID]);

        // The user changes the queued row's requested action while that read is still outstanding.
        await updatePendingRequestedActionV2({
            sessionId: SESSION_ID,
            localId: ACCEPTED_LOCAL_ID,
            requestedAction: { v: 1, kind: 'steer_now' },
            outboxScope: scope,
            request: async () => Response.json({ didUpdate: true }),
        });

        const second = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: dedupedRequest,
        });
        release();
        await Promise.all([first, second]);

        expect(publishedLocalIds()).toContain(ACCEPTED_LOCAL_ID);
    });

    /**
     * H — the OTHER capture-time fact, taken by the same ordering as G.
     *
     * The two facts fail in OPPOSITE directions — losing an accept drops a message, losing the
     * sequence mark republishes a settled row — but a PATCH invalidates NEITHER: the capture point
     * belongs to the response, and a local write does not move it. So the same invalidation that
     * must stop erasing the accepted set must stop erasing the mark, for the same reason ordering E
     * inherits it. This is ordering E with the PATCH inserted, and its accepted set is empty
     * throughout, so only the mark can decide it.
     */
    it('withholds a settled row for a refresh registered after a requested-action PATCH', async () => {
        const scope = armSession();
        setActiveServerId(scope.serverId, { scope: 'tab' });
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));

        // Accepted BEFORE any refresh is registered, so nothing is recorded on a refresh token and
        // the accepted-localId fence stays out of this ordering entirely.
        await enqueuePendingMessageV2({
            sessionId: SESSION_ID,
            localId: LOCAL_ID,
            text: 'queued before the refresh',
            encryption,
            outboxScope: scope,
            serverWireMode: 'pending_input_v1',
            request: async (_path, init) => currentPendingEnqueueAck(init),
        });

        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const sharedRead = (async () => { await gate; return queuedRowResponse(LOCAL_ID); })();
        const dedupedRequest = async () => (await sharedRead).clone();

        const first = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: dedupedRequest,
        });

        await updatePendingRequestedActionV2({
            sessionId: SESSION_ID,
            localId: LOCAL_ID,
            requestedAction: { v: 1, kind: 'steer_now' },
            outboxScope: scope,
            request: async () => Response.json({ didUpdate: true }),
        });

        // The settlement lands while that read is still outstanding.
        storage.getState().applyMessages(SESSION_ID, [committedTwin(LOCAL_ID)]);
        const second = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: dedupedRequest,
        });
        release();
        await Promise.all([first, second]);

        expect(publishedPending()).toEqual([]);
    });

    it('republishes a row when a second refresh inherits an in-flight mark and the twin is old news', async () => {
        const scope = armSession();
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });

        const first = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => { await gate; return queuedRowResponse(LOCAL_ID); },
        });
        // Learned during the request (an older page, a backfill), sequenced below the loaded tail.
        storage.getState().applyMessages(SESSION_ID, [committedTwin(LOCAL_ID, LOADED_HEAD_SEQ - 3)]);
        const second = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => queuedRowResponse(LOCAL_ID),
        });
        release();
        await Promise.all([first, second]);

        expect(publishedPending()).toEqual([REPUBLISHED_ROW]);
    });
});
