import { beforeEach, describe, expect, it } from 'vitest';

import { Encryption } from '@/sync/encryption/encryption';
import { storage } from '@/sync/domains/state/storage';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';

import { fetchAndApplyPendingMessagesV2 } from './pendingQueueV2';
import { buildSession, resetPendingQueueState } from './pendingQueueV2.testHelpers';

/**
 * DURABLE COEXISTENCE, pinned at the FENCE.
 *
 * A pending row and a committed message for the same `localId` can coexist PERMANENTLY on the
 * server. Measured on the sibling deployment's live database (2026-08-07, read-only): 7 such rows,
 * 3 of them `status: 'queued'` / `deliveryState: 'blocked'` /
 * `deliveryBlockedReason: 'delivery_outcome_uncertain'` — the shape
 * `apps/server/sources/app/session/pending/providerDeliveryClaimStaleness.ts` creates deliberately
 * when a provider claim goes stale after the utterance was already committed. Those rows carry the
 * blocked-delivery banner and its handled / dismiss / send-as-new actions; hiding one is
 * message-loss-shaped, strictly worse than the transcript flap the fence exists to stop.
 *
 * `withholdPendingRowsCommittedAfterSnapshotCapture` must therefore fire for a commit that is
 * NEWER than the read it is fencing, and never for a commit this client merely LEARNED about while
 * the read was outstanding. On every one of those 7 live rows the committed twin's `seq` is at or
 * below the session's own `seq` (1≤1, 8834≤8838, 5≤6, 25586≤25639, 1≤1, 1≤1, 4≤22), and
 * `Session.seq == max(SessionMessage.seq)` on all 7 — so a twin that is old news never exceeds the
 * sequence high-water mark this client could already observe.
 *
 * These cases live at the FENCE (`fetchAndApplyPendingMessagesV2`), not at the store: the fence
 * deletes rows BEFORE `applyPendingSnapshot`, so the store-level contracts
 * (`sync/store/domains/pending.ordering.test.ts`, `components/sessions/chatListItems.test.ts`)
 * cannot observe a row that never arrives. Their green was not evidence that this contract holds.
 *
 * Fixture note for THIS repo (not a diff-port of the sibling's): the wire parser here treats any
 * `deliveryState` outside `delivering|external_handoff|blocked` as malformed, so the live blocked
 * shape is used verbatim and no row carries `deliveryState: 'queued'`; and the snapshot mapping
 * here stamps `pendingOutboxScope` on every server-mapped row, so the assertions read the delivery
 * status rather than the scope.
 */

const SESSION_ID = 'durable-coexistence-session';
const LOCAL_ID = 'durable-coexistence-local';

/** The session tail this client had already loaded before the pending GET was issued. */
const LOADED_HEAD_SEQ = 40;

function committedMessage(params: { localId: string | null; seq: number }) {
    return {
        id: `committed-${params.localId ?? 'none'}-${params.seq}`,
        seq: params.seq,
        localId: params.localId,
        createdAt: 2_000,
        isSidechain: false,
        role: 'user',
        content: { type: 'text', text: 'hello' },
    } as any;
}

function blockedRowResponse(localId: string): Response {
    return new Response(JSON.stringify({
        pending: [{
            localId,
            content: {
                t: 'plain',
                v: { role: 'user', content: { type: 'text', text: 'hello' }, meta: {} },
            },
            requestedAction: { v: 1, kind: 'enqueue' },
            status: 'queued',
            deliveryState: 'blocked',
            deliveryBlockedReason: 'delivery_outcome_uncertain',
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
    deliveryStatus: PendingMessage['pendingDeliveryStatus'];
}>> {
    return (storage.getState().sessionPending[SESSION_ID]?.messages ?? []).map((message: PendingMessage) => ({
        localId: message.localId ?? message.id,
        deliveryStatus: message.pendingDeliveryStatus,
    }));
}

const COEXISTING_ROW = { localId: LOCAL_ID, deliveryStatus: 'blocked' } as const;

describe('pendingQueueV2 durable pending/committed coexistence', () => {
    beforeEach(() => resetPendingQueueState());

    function armSession(params?: { sessionSeq?: number }) {
        const server = upsertServerProfile({ serverUrl: 'https://durable.example.test', name: 'Durable' });
        storage.getState().applySessions([{
            ...buildSession({ sessionId: SESSION_ID }),
            encryptionMode: 'plain',
            seq: params?.sessionSeq ?? LOADED_HEAD_SEQ,
        }]);
        return { serverId: server.id, accountId: 'account' } as const;
    }

    /** The transcript this client had already loaded when the pending GET was issued. */
    function loadTranscript(seqs: readonly number[]): void {
        storage.getState().applyMessages(
            SESSION_ID,
            seqs.map((seq) => committedMessage({ localId: `loaded-local-${seq}`, seq })),
        );
        storage.getState().applyMessagesLoaded(SESSION_ID);
    }

    async function encryption(): Promise<Encryption> {
        return Encryption.create(new Uint8Array(32).fill(6));
    }

    /**
     * SESSION OPEN. `sessionMessages` has no warm cache, so the transcript store is EMPTY when the
     * session surface fires the refresh, and the first page lands inside the GET's window (measured
     * RTT for that GET on the sibling device traces: 155–264 ms). The twin the page carries is old
     * news, not a settlement.
     */
    it('publishes a blocked coexisting row when the transcript first loads during the pending GET', async () => {
        const scope = armSession();
        let releaseResponse!: () => void;
        const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });

        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption: await encryption(),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => { await responseGate; return blockedRowResponse(LOCAL_ID); },
        });
        loadTranscript([LOADED_HEAD_SEQ - 1, LOADED_HEAD_SEQ]);
        storage.getState().applyMessages(SESSION_ID, [committedMessage({ localId: LOCAL_ID, seq: 4 })]);
        releaseResponse();
        await refresh;

        expect(publishedPending()).toEqual([COEXISTING_ROW]);
    });

    /**
     * LOADED, BUT EMPTY — the loaded flag is not a basis.
     *
     * `isLoaded === true` with NOTHING loaded is reachable in this repo's own bytes: `sync/sync.ts`'s
     * `fetchMessages` calls `applyMessagesLoaded(sessionId)` and returns without applying a single
     * message when the session cannot be resolved to the active or a locally known owner server, and
     * `sync/engine/sessions/syncSessions.ts` calls `markMessagesLoaded(sessionId)` at the end of the
     * initial page pipeline even when that page was empty. In that state the only mark left is
     * `session.seq`, which `sync/domains/state/warmCacheAdapters.ts` persists (and rehydrates) while
     * it caches NEITHER `sessionMessages` nor `sessionPending` — so it can be arbitrarily stale-low,
     * and a durable twin then sits ABOVE it and the live blocked row is hidden.
     *
     * A client holding no committed message cannot tell "this commit is newer than my read" from "I
     * had not loaded this commit yet", so the answer for that state is to assert nothing.
     */
    it('publishes a blocked coexisting row when the transcript is marked loaded but empty', async () => {
        const scope = armSession({ sessionSeq: 0 });
        storage.getState().applyMessagesLoaded(SESSION_ID);
        let releaseResponse!: () => void;
        const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });

        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption: await encryption(),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => { await responseGate; return blockedRowResponse(LOCAL_ID); },
        });
        storage.getState().applyMessages(SESSION_ID, [committedMessage({ localId: LOCAL_ID, seq: 1 })]);
        releaseResponse();
        await refresh;

        expect(publishedPending()).toEqual([COEXISTING_ROW]);
    });

    /**
     * ADOPTING REFRESH. `apiSocket.request` shares one in-flight GET, so a refresh that starts after
     * the twin is known can be answered by a request issued before it and inherits that request's
     * capture point. Inheriting must not turn "old news I had not loaded yet" into a withhold.
     */
    it('publishes a blocked coexisting row for a refresh that inherits an in-flight capture', async () => {
        const scope = armSession();
        const sharedEncryption = await encryption();
        let releaseResponse!: () => void;
        const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });

        const first = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption: sharedEncryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => { await responseGate; return blockedRowResponse(LOCAL_ID); },
        });
        loadTranscript([LOADED_HEAD_SEQ]);
        storage.getState().applyMessages(SESSION_ID, [committedMessage({ localId: LOCAL_ID, seq: 4 })]);
        const second = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption: sharedEncryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => blockedRowResponse(LOCAL_ID),
        });
        releaseResponse();
        await Promise.all([first, second]);

        expect(publishedPending()).toEqual([COEXISTING_ROW]);
    });

    /**
     * BACKWARD PAGINATION. The transcript is loaded (tail page only) when the GET is issued; the
     * user scrolls back and an OLDER page carrying the twin lands inside the GET's window.
     * Backward pagination can only ever add messages below the loaded head, so nothing it reveals
     * is newer than the read.
     */
    it('publishes a blocked coexisting row when an older transcript page lands during the pending GET', async () => {
        const scope = armSession();
        loadTranscript([LOADED_HEAD_SEQ]);
        let releaseResponse!: () => void;
        const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });

        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption: await encryption(),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => { await responseGate; return blockedRowResponse(LOCAL_ID); },
        });
        storage.getState().applyMessages(SESSION_ID, [committedMessage({ localId: LOCAL_ID, seq: 4 })]);
        releaseResponse();
        await refresh;

        expect(publishedPending()).toEqual([COEXISTING_ROW]);
    });

    /**
     * The withhold must stay row-scoped, and it must still fire for the flap in the same snapshot:
     * one utterance settles while the GET is outstanding (its twin is the new session tail) while a
     * durable blocked row for an older utterance coexists.
     */
    it('withholds only the freshly settled row and keeps the durable one in the same snapshot', async () => {
        const scope = armSession();
        loadTranscript([LOADED_HEAD_SEQ]);
        const settledLocalId = 'durable-coexistence-settled';
        let releaseResponse!: () => void;
        const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
        const twoRowResponse = () => new Response(JSON.stringify({
            pending: [LOCAL_ID, settledLocalId].map((localId, index) => ({
                localId,
                content: {
                    t: 'plain',
                    v: { role: 'user', content: { type: 'text', text: 'hello' }, meta: {} },
                },
                requestedAction: { v: 1, kind: 'enqueue' },
                status: 'queued',
                deliveryState: index === 0 ? 'blocked' : 'delivering',
                ...(index === 0 ? { deliveryBlockedReason: 'delivery_outcome_uncertain' } : {}),
                position: index,
                createdAt: 1_000 + index,
                updatedAt: 1_100,
                discardedAt: null,
                discardedReason: null,
            })),
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });

        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption: await encryption(),
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => { await responseGate; return twoRowResponse(); },
        });
        // The durable twin is old news; the settled twin is the session's new tail.
        storage.getState().applyMessages(SESSION_ID, [
            committedMessage({ localId: LOCAL_ID, seq: 4 }),
            committedMessage({ localId: settledLocalId, seq: LOADED_HEAD_SEQ + 1 }),
        ]);
        releaseResponse();
        await refresh;

        expect(publishedPending()).toEqual([COEXISTING_ROW]);
    });
});
