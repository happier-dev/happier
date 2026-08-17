import { beforeEach, describe, expect, it } from 'vitest';

import { Encryption } from '@/sync/encryption/encryption';
import { storage } from '@/sync/domains/state/storage';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';

import { fetchAndApplyPendingMessagesV2 } from './pendingQueueV2';
import { buildSession, resetPendingQueueState } from './pendingQueueV2.testHelpers';

/**
 * A pending snapshot is a READ of server state, and a read may not overwrite state that is newer
 * than it.
 *
 * The server settles a materialization in ONE transaction — it deletes the pending row and writes
 * the committed message — and publishes the committed message first
 * (`apps/server/sources/app/session/pending/acceptedPendingSettlementCoordinator.ts`). So a
 * snapshot GET issued before that transaction still answers with the row, and on a slow client its
 * response lands after the committed twin has already been applied. `server_pending` outranks a
 * committed twin in the transcript crossover
 * (`sync/domains/pending/pendingTranscriptProjection.ts`), so republishing that row takes the tail
 * slot BACK from a message the reader has already seen — the measured
 * pending → committed → pending → committed flap in
 * `.project/reviews/2026-08-06-simplify-and-native/C3-void-writer.md` (3/3 captures, content height
 * +41 / −41 / −31 px for one utterance).
 *
 * The discriminator is the snapshot's own capture point, not a preference between the two rows.
 */

const SESSION_ID = 'crossover-snapshot-session';
const LOCAL_ID = 'crossover-local';
/** The session tail this client had already loaded before any request below was issued. */
const LOADED_HEAD_SEQ = 6;

function committedTwin(localId: string, seq = LOADED_HEAD_SEQ + 1) {
    return {
        id: `committed-${localId}-${seq}`,
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
            deliveryState: 'delivering',
            position: 0,
            createdAt: 1_000,
            updatedAt: 1_100,
            discardedAt: null,
            discardedReason: null,
        }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function publishedPendingLocalIds(): string[] {
    return (storage.getState().sessionPending[SESSION_ID]?.messages ?? [])
        .map((message) => message.localId ?? message.id);
}

describe('pendingQueueV2 snapshot vs committed crossover', () => {
    beforeEach(() => resetPendingQueueState());

    function armSession() {
        const server = upsertServerProfile({ serverUrl: 'https://crossover.example.test', name: 'Crossover' });
        storage.getState().applySessions([{
            ...buildSession({ sessionId: SESSION_ID }),
            encryptionMode: 'plain',
            seq: LOADED_HEAD_SEQ,
        }]);
        // The flap was measured on an open session with a loaded 106-row transcript. The fence
        // asserts nothing before the transcript is a basis, so the loaded tail is part of its shape.
        storage.getState().applyMessages(SESSION_ID, [committedTwin('crossover-loaded-tail', LOADED_HEAD_SEQ)]);
        storage.getState().applyMessagesLoaded(SESSION_ID);
        return { serverId: server.id, accountId: 'account' } as const;
    }

    it('does not republish a pending row for an utterance committed after the snapshot was captured', async () => {
        const scope = armSession();
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));
        let releaseResponse!: () => void;
        const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });

        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => {
                await responseGate;
                return queuedRowResponse(LOCAL_ID);
            },
        });

        // The settlement's `new-message` reaches this client while the GET is still outstanding.
        storage.getState().applyMessages(SESSION_ID, [committedTwin(LOCAL_ID)]);
        releaseResponse();
        await refresh;

        expect(publishedPendingLocalIds()).toEqual([]);
    });

    it('publishes a server row whose utterance was already committed when the snapshot was captured', async () => {
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

        expect(publishedPendingLocalIds()).toEqual([LOCAL_ID]);
    });

    it('publishes a server row for an utterance that has no committed twin', async () => {
        const scope = armSession();
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));
        storage.getState().applyMessages(SESSION_ID, [committedTwin('unrelated-local')]);

        await fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => queuedRowResponse(LOCAL_ID),
        });

        expect(publishedPendingLocalIds()).toEqual([LOCAL_ID]);
    });
});
