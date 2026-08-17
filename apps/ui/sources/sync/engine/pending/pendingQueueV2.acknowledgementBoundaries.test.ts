import { beforeEach, describe, expect, it } from 'vitest';

import { Encryption } from '@/sync/encryption/encryption';
import { storage } from '@/sync/domains/state/storage';
import { setActiveServerId, upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { PendingMessage } from '@/sync/domains/state/storageTypes';

import * as pendingQueueV2Module from './pendingQueueV2';
import {
    deletePendingMessageV2,
    enqueuePendingMessageV2,
    fetchAndApplyPendingMessagesV2,
    retryPendingOutboxOperationV2,
    sendPendingDeliveryAsNewV2,
    updatePendingMessageV2,
    updatePendingRequestedActionV2,
} from './pendingQueueV2';
import {
    buildSession,
    currentPendingEnqueueAck,
    resetPendingQueueState,
} from './pendingQueueV2.testHelpers';

/**
 * THE INVARIANT
 *
 * A pending snapshot response may not delete a row the server has already told this client it
 * holds. `apiSocket.request` de-dupes in-flight GETs, so a refresh registered AFTER an
 * acknowledgement can be ANSWERED by a GET issued before it; the accepted-localId fence exists so
 * that such a response is skipped rather than applied. The fence only works if EVERY point at which
 * this client learns the server took custody of a localId records it into the live refresh token.
 *
 * That recording is a call-site opt-in — acknowledgement is a property of the HTTP RESPONSE, while
 * every store-mutation choke point in `pendingQueueV2` is shared with anti-acknowledgement
 * retirements (cancel, discard, delivery-handled, delete, definitive rejection), so no single
 * existing owner can discriminate. Recording at a retiring boundary would demand a row the server
 * has stopped listing and make the guard refuse snapshots for the rest of the in-flight chain.
 *
 * Four separate defects on this one shape were found and fixed one at a time. This file is the
 * mechanism that stops the fifth: every exported entry point of the module must DECLARE its
 * acknowledgement direction, and every entry point declared as taking new server custody is DRIVEN
 * through the losing ordering and must keep its localId.
 *
 * Honest limit: this catches a new EXPORTED boundary. It cannot catch a new internal branch, which
 * is the second reason the recording belongs at the successful response rather than inside a
 * downstream custody-retirement conditional.
 */

const SESSION_ID = 'ack-boundary-session';
/** A row the server already held when the shared pre-acknowledgement read was taken. */
const SEED_LOCAL_ID = 'ack-boundary-seed-local';
/** The utterance whose custody the driven boundary is the SOLE proof of. */
const ACKNOWLEDGED_LOCAL_ID = 'ack-boundary-acknowledged-local';
/**
 * A canonical server row with no durable custody, used as the witness for the CONVERSE direction: it
 * survives only while the fence is refusing snapshots, so its removal proves nothing was recorded.
 */
const WITNESS_LOCAL_ID = 'ack-boundary-witness-local';
/** The session tail this client had already loaded before any request below was issued. */
const LOADED_HEAD_SEQ = 6;

type AcknowledgementBoundaryContext = Readonly<{
    sessionId: string;
    localId: string;
    scope: ServerAccountScope;
    encryption: Encryption;
}>;

type PendingExportContract =
    /**
     * The call learns the server has taken NEW custody of a localId that no older read can list.
     * It must record, and is driven below.
     */
    | Readonly<{ kind: 'acknowledges-new-custody'; drive: (context: AcknowledgementBoundaryContext) => Promise<void> }>
    /**
     * The call makes the server STOP listing the row as pending. Recording here would demand a row
     * the server will never return and wedge the guard for the rest of the in-flight chain.
     */
    | Readonly<{ kind: 'retires-custody'; why: string }>
    /**
     * The row already existed on the server before the call, so every read older than the call
     * already lists it and the call teaches the fence nothing new.
     */
    | Readonly<{ kind: 'no-new-custody'; why: string }>
    /**
     * The call DOES take new server custody of a localId no older read can list, but the shared
     * driver below cannot reach it: this boundary owns its own trailing
     * `fetchAndApplyPendingMessagesV2`, which registers a refresh token and then CLEARS it in its
     * `finally`, so the successor the driver depends on inherits nothing. Such a boundary must
     * record at its response whenever the response NAMES the new localId, and is pinned by its own
     * case instead of by the loop. Choosing this kind is a claim about the SERVER, so the `why`
     * must cite the server source that creates the row.
     */
    | Readonly<{ kind: 'acknowledges-new-custody-outside-the-shared-driver'; why: string }>
    /** Not a per-localId server mutation at all. */
    | Readonly<{ kind: 'not-a-server-mutation'; why: string }>;

/**
 * The enqueue POST fails on THIS client while the server creates the row anyway — the state in
 * which a later boundary is the only acknowledgement this client ever receives.
 */
async function enqueueWithoutClientAcknowledgement(context: AcknowledgementBoundaryContext): Promise<void> {
    await enqueuePendingMessageV2({
        sessionId: context.sessionId,
        localId: context.localId,
        text: 'sent while the snapshot read was outstanding',
        encryption: context.encryption,
        outboxScope: context.scope,
        serverWireMode: 'pending_input_v1',
        request: async () => { throw new Error('network down'); },
    }).catch(() => undefined);
}

const PENDING_EXPORT_CONTRACT: Readonly<Record<string, PendingExportContract>> = {
    enqueuePendingMessageV2: {
        kind: 'acknowledges-new-custody',
        drive: async (context) => {
            await enqueuePendingMessageV2({
                sessionId: context.sessionId,
                localId: context.localId,
                text: 'accepted while the snapshot read was outstanding',
                encryption: context.encryption,
                outboxScope: context.scope,
                serverWireMode: 'pending_input_v1',
                request: async (_path, init) => currentPendingEnqueueAck(init),
            });
        },
    },
    retryPendingOutboxOperationV2: {
        kind: 'acknowledges-new-custody',
        drive: async (context) => {
            await enqueueWithoutClientAcknowledgement(context);
            await retryPendingOutboxOperationV2({
                sessionId: context.sessionId,
                localId: context.localId,
                outboxScope: context.scope,
                serverWireMode: 'pending_input_v1',
                request: async (_path, init) => currentPendingEnqueueAck(init),
            });
        },
    },
    updatePendingMessageV2: {
        kind: 'acknowledges-new-custody',
        drive: async (context) => {
            await enqueueWithoutClientAcknowledgement(context);
            await updatePendingMessageV2({
                sessionId: context.sessionId,
                pendingId: context.localId,
                text: 'edited while the pre-PATCH read was outstanding',
                encryption: context.encryption,
                outboxScope: context.scope,
                request: async () => new Response('{}', { status: 200 }),
            });
        },
    },
    updatePendingRequestedActionV2: {
        kind: 'acknowledges-new-custody',
        drive: async (context) => {
            await enqueueWithoutClientAcknowledgement(context);
            await updatePendingRequestedActionV2({
                sessionId: context.sessionId,
                localId: context.localId,
                requestedAction: { v: 1, kind: 'steer_now' },
                outboxScope: context.scope,
                request: async () => Response.json({ didUpdate: true }),
            });
        },
    },
    deletePendingMessageV2: {
        kind: 'retires-custody',
        why: 'DELETE: the server stops listing the row, and the call tombstones the localId.',
    },
    discardPendingMessageV2: {
        kind: 'retires-custody',
        why: 'The row leaves the pending bucket for the discarded bucket.',
    },
    markPendingDeliveryHandledV2: {
        kind: 'retires-custody',
        why: 'The delivery is handled and the server stops listing the row as pending; a pre-call '
            + 'read that still lists it re-publishes it, which the next refresh corrects. Recording '
            + 'here would demand a row the server will never return again.',
    },
    deleteDiscardedPendingMessageV2: {
        kind: 'retires-custody',
        why: 'DELETE against a discarded row; the call tombstones the localId.',
    },
    blockPendingDeliveryV2: {
        kind: 'no-new-custody',
        why: 'Changes delivery state on a row the server already held; every older read lists it.',
    },
    dismissPendingDeliveryV2: {
        kind: 'no-new-custody',
        why: 'Changes delivery state on a row the server already held; every older read lists it.',
    },
    sendPendingDeliveryAsNewV2: {
        kind: 'acknowledges-new-custody-outside-the-shared-driver',
        why: 'It DOES create a localId no older read can list, and this entry used to claim the '
            + 'opposite. Server truth: `derivePendingSendAsNewLocalId` returns '
            + '`send-as-new-<sha256(sessionId, localId)>` '
            + '(apps/server/sources/app/session/pending/pendingMessageService.ts:1263-1268, computed '
            + ':1282); the transaction CREATES a queued row under it (:1345-1352) and discards the '
            + 'ORIGINAL as `resent_as_new`, and every ok result — including the idempotent '
            + '`didWrite: false` replay at :1319 — has proven that queued replacement row exists. The '
            + 'reply NAMES it as `newLocalId` '
            + '(apps/server/sources/app/api/routes/session/pendingRoutes.ts:753), so this call records '
            + 'it at its response like every other acknowledging boundary. Pinned by '
            + '`sendPendingDeliveryAsNewV2 refuses a pre-POST read that omits the replacement the '
            + 'server named` rather than by the shared driver above.',
    },
    restoreDiscardedPendingMessageV2: {
        kind: 'no-new-custody',
        why: 'The row already existed as discarded; restore changes which bucket it is listed in, '
            + 'not whether the server holds it.',
    },
    reorderPendingMessagesV2: {
        kind: 'no-new-custody',
        why: 'Reorders rows the server already held.',
    },
    fetchAndApplyPendingMessagesV2: {
        kind: 'not-a-server-mutation',
        why: 'The reader that OWNS the refresh token; membership is decided against its own response.',
    },
    setPendingMessageSendState: {
        kind: 'not-a-server-mutation',
        why: 'Local send-state write; no server exchange.',
    },
    replayPersistedPendingOutboxForSession: {
        kind: 'not-a-server-mutation',
        why: 'Re-hydrates durable outbox rows locally on session open; no server exchange.',
    },
    assertValidPendingMessageId: {
        kind: 'not-a-server-mutation',
        why: 'Pure id validation; no server exchange.',
    },
    assertPendingMessageProjectionTransportableV2: {
        kind: 'not-a-server-mutation',
        why: 'Pre-request guard; it runs before any response and cannot know success.',
    },
    resolvePendingMessageProjectionLocalIdV2: {
        kind: 'not-a-server-mutation',
        why: 'Pure projection-identity resolution; no server exchange.',
    },
    serializePendingEnqueueBodyForServerWire: {
        kind: 'not-a-server-mutation',
        why: 'Pure wire serialization; no server exchange.',
    },
    isReleasedServerV021PendingEnqueueResponse: {
        kind: 'not-a-server-mutation',
        why: 'Pure response-shape predicate; the enqueue path owns the acknowledgement.',
    },
};

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

function queuedRowsResponse(localIds: ReadonlyArray<string>): Response {
    return new Response(JSON.stringify({
        pending: localIds.map((localId, index) => ({
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
            position: index,
            createdAt: 1_000,
            updatedAt: 1_100,
            discardedAt: null,
            discardedReason: null,
        })),
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

/**
 * Every callable this module hands to the rest of the app, whatever container it is exported in.
 *
 * A bare `typeof value === 'function'` filter reads only the top level, so an acknowledging boundary
 * exported as an OBJECT OF METHODS — `export const pendingCustodyApi = { async accept() { …POST… } }`
 * — passes the completeness gate in silence (MEASURED: adding exactly that export left the suite
 * green, while the same boundary written as a bare exported function was caught). Object-valued
 * exports are walked so a namespace cannot hide a new POST/PATCH.
 *
 * Honest limit: own enumerable properties only. A method living on an exported class INSTANCE's
 * prototype is not reached; an exported class itself is a function and is caught at the top level.
 */
function collectExportedCallableNames(): string[] {
    const names: string[] = [];
    const visited = new Set<unknown>();
    const walk = (value: unknown, path: string): void => {
        if (typeof value === 'function') {
            names.push(path);
            return;
        }
        if (!value || typeof value !== 'object' || Array.isArray(value) || visited.has(value)) return;
        visited.add(value);
        for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
            walk(nested, `${path}.${key}`);
        }
    };
    for (const [exportName, exported] of Object.entries(pendingQueueV2Module)) {
        walk(exported, exportName);
    }
    return names.sort();
}

function publishedLocalIds(): string[] {
    return (storage.getState().sessionPending[SESSION_ID]?.messages ?? [])
        .map((message: PendingMessage) => message.localId ?? message.id);
}

function armSession(): ServerAccountScope {
    const server = upsertServerProfile({ serverUrl: 'https://ack-boundary.example.test', name: 'AckBoundary' });
    storage.getState().applySessions([{
        ...buildSession({ sessionId: SESSION_ID }),
        encryptionMode: 'plain',
        seq: LOADED_HEAD_SEQ,
    }]);
    storage.getState().applyMessages(SESSION_ID, [committedTwin('ack-boundary-loaded-tail', LOADED_HEAD_SEQ)]);
    storage.getState().applyMessagesLoaded(SESSION_ID);
    setActiveServerId(server.id, { scope: 'tab' });
    return { serverId: server.id, accountId: 'account' } as const;
}

describe('pending acknowledgement boundaries', () => {
    beforeEach(() => resetPendingQueueState());

    /**
     * The completeness gate. Adding an export without declaring its direction fails here, which is
     * what forces the next boundary to be considered instead of silently reopening the hole.
     */
    it('declares an acknowledgement direction for every exported entry point', () => {
        expect(Object.keys(PENDING_EXPORT_CONTRACT).sort()).toEqual(collectExportedCallableNames());
    });

    for (const [exportName, contract] of Object.entries(PENDING_EXPORT_CONTRACT)) {
        if (contract.kind !== 'acknowledges-new-custody') continue;

        /**
         * The losing ordering, driven per boundary: one GET is issued BEFORE the boundary and lists
         * only the seed row; the boundary is the SOLE proof the server holds `ACKNOWLEDGED_LOCAL_ID`;
         * a successor refresh registered after it is answered by that same pre-boundary GET. If the
         * boundary did not record, the successor's accepted set is empty, the fence passes trivially,
         * and the response deletes a message the server owns.
         */
        it(`${exportName} keeps the localId it acknowledged when a pre-boundary read answers a successor`, async () => {
            const scope = armSession();
            const encryption = await Encryption.create(new Uint8Array(32).fill(6));

            let release!: () => void;
            const gate = new Promise<void>((resolve) => { release = resolve; });
            const sharedRead = (async () => { await gate; return queuedRowsResponse([SEED_LOCAL_ID]); })();
            const dedupedRequest = async () => (await sharedRead).clone();

            const first = fetchAndApplyPendingMessagesV2({
                sessionId: SESSION_ID,
                encryption,
                outboxScope: scope,
                isOutboxScopeCurrent: () => true,
                request: dedupedRequest,
            });

            await contract.drive({
                sessionId: SESSION_ID,
                localId: ACKNOWLEDGED_LOCAL_ID,
                scope,
                encryption,
            });
            expect(publishedLocalIds()).toContain(ACKNOWLEDGED_LOCAL_ID);

            const second = fetchAndApplyPendingMessagesV2({
                sessionId: SESSION_ID,
                encryption,
                outboxScope: scope,
                isOutboxScopeCurrent: () => true,
                request: dedupedRequest,
            });
            release();
            await Promise.all([first, second]);

            expect(publishedLocalIds()).toContain(ACKNOWLEDGED_LOCAL_ID);
        });
    }

    /**
     * The same losing ordering with NO durable enqueue custody — a row another device created, which
     * this client only ever saw through a snapshot.
     *
     * Every driver above reaches its boundary through `enqueueWithoutClientAcknowledgement`, which
     * throws after the POST may have committed and therefore ALWAYS leaves a durable `enqueue` outbox
     * row behind. That left the PATCH's recording placement unpinned: moving it inside the
     * `operation === 'enqueue'` custody-retirement branch below it — the placement the enumeration
     * rejected on reach grounds — kept the whole suite green, because no case ever PATCHed a purely
     * canonical row. This is that case, and it is the one the branch cannot serve.
     */
    it('updatePendingMessageV2 keeps a canonical server row it acknowledged with no durable outbox custody', async () => {
        const scope = armSession();
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));

        // The row reaches this client the only way a foreign device's row can: a completed snapshot.
        // It leaves no outbox custody, so the retirement branch below the PATCH cannot fire.
        await fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => queuedRowsResponse([SEED_LOCAL_ID, ACKNOWLEDGED_LOCAL_ID]),
        });
        expect(publishedLocalIds()).toContain(ACKNOWLEDGED_LOCAL_ID);

        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const sharedRead = (async () => { await gate; return queuedRowsResponse([SEED_LOCAL_ID]); })();
        const dedupedRequest = async () => (await sharedRead).clone();

        const first = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: dedupedRequest,
        });

        await updatePendingMessageV2({
            sessionId: SESSION_ID,
            pendingId: ACKNOWLEDGED_LOCAL_ID,
            text: 'edited a canonical row while the pre-PATCH read was outstanding',
            encryption,
            outboxScope: scope,
            request: async () => new Response('{}', { status: 200 }),
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

        expect(publishedLocalIds()).toContain(ACKNOWLEDGED_LOCAL_ID);
    });

    /**
     * The converse of every case above, and the hazard that makes the recording placement delicate:
     * a localId the server NEVER acknowledged must not be recorded. Recording one would make
     * `pendingSnapshotContainsEveryAcceptedLocalIdAfterCapture` demand a row no snapshot can ever
     * carry, so the whole in-flight refresh chain would stop applying — a wedged queue rather than a
     * lost message.
     *
     * Driven through the failed enqueue: the POST never returns a response, so nothing downstream of
     * `assertPendingResponseOk` and the wire acknowledgement runs. The witness row is the detector —
     * it has no durable custody, so a snapshot that APPLIES must drop it. If the failed enqueue had
     * recorded, the successor would skip and the witness would survive.
     */
    it('does not record a localId the server never acknowledged', async () => {
        const scope = armSession();
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));

        await fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => queuedRowsResponse([SEED_LOCAL_ID, WITNESS_LOCAL_ID]),
        });
        expect(publishedLocalIds()).toContain(WITNESS_LOCAL_ID);

        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const sharedRead = (async () => { await gate; return queuedRowsResponse([SEED_LOCAL_ID]); })();
        const dedupedRequest = async () => (await sharedRead).clone();

        const first = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: dedupedRequest,
        });

        await enqueueWithoutClientAcknowledgement({
            sessionId: SESSION_ID,
            localId: ACKNOWLEDGED_LOCAL_ID,
            scope,
            encryption,
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

        expect(publishedLocalIds()).not.toContain(WITNESS_LOCAL_ID);
    });

    /**
     * The fifth acknowledging boundary, which the contract map used to declare `no-new-custody`.
     *
     * `send-as-new` creates a queued row under a localId the server derives and discards the
     * original in the same transaction, so a read taken before the POST can list neither the
     * replacement nor the original's new state. The call then runs its OWN refresh, which
     * `apiSocket.request` can answer from exactly that older read — republishing the DISCARDED
     * original and omitting the replacement.
     *
     * It cannot join the driver loop above: this boundary's trailing refresh registers a token and
     * clears it in its `finally`, so a successor registered afterwards inherits nothing. The
     * ordering here therefore keeps BOTH consumers of the accepted set in flight — the outstanding
     * predecessor and the boundary's own trailing refresh — and the witness row is the detector, as
     * elsewhere in this file: it survives only while a snapshot is being refused.
     */
    it('sendPendingDeliveryAsNewV2 refuses a pre-POST read that omits the replacement the server named', async () => {
        const scope = armSession();
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));
        const REPLACEMENT_LOCAL_ID = 'send-as-new-ack-boundary-replacement';

        await fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => queuedRowsResponse([SEED_LOCAL_ID, ACKNOWLEDGED_LOCAL_ID, WITNESS_LOCAL_ID]),
        });
        expect(publishedLocalIds()).toContain(WITNESS_LOCAL_ID);

        // The pre-POST read: the original is still queued, the replacement does not exist yet.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const sharedRead = (async () => {
            await gate;
            return queuedRowsResponse([SEED_LOCAL_ID, ACKNOWLEDGED_LOCAL_ID]);
        })();
        let trailingGetIssued!: () => void;
        const trailingGetIssuedGate = new Promise<void>((resolve) => { trailingGetIssued = resolve; });
        let issuedGets = 0;
        const dedupedRequest = async () => {
            issuedGets += 1;
            if (issuedGets === 2) trailingGetIssued();
            return (await sharedRead).clone();
        };

        const first = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: dedupedRequest,
        });

        const sendAsNew = sendPendingDeliveryAsNewV2({
            sessionId: SESSION_ID,
            pendingId: ACKNOWLEDGED_LOCAL_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async (path, init) => (init?.method === 'POST' && path.endsWith('/delivery/send-as-new')
                ? Response.json({ ok: true, newLocalId: REPLACEMENT_LOCAL_ID })
                : dedupedRequest()),
        });
        await trailingGetIssuedGate;
        release();
        await expect(Promise.all([first, sendAsNew])).resolves.toBeDefined();

        expect(publishedLocalIds()).toContain(WITNESS_LOCAL_ID);

        // …and the refusal is bounded: the accepted set dies with the in-flight chain, so the next
        // refresh — which does list the replacement — applies.
        await fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => queuedRowsResponse([SEED_LOCAL_ID, REPLACEMENT_LOCAL_ID]),
        });
        expect(publishedLocalIds()).toEqual([SEED_LOCAL_ID, REPLACEMENT_LOCAL_ID]);
    });

    /**
     * WHERE the enqueue POST records, not merely THAT it records.
     *
     * Deleting the record is loud — several suites go red. MOVING it back below the branches that
     * read local custody was silent: every other case in this file reaches the acknowledgement on a
     * path that falls through to the bottom of the enqueue body, so the record ran either way.
     *
     * This is the ordering that separates the two placements. The POST is acknowledged — the server
     * has stated it holds the row — and the user's cancellation, requested while the POST was in
     * flight, completes before the response is processed, so the body leaves through
     * `cancellationCompleted` and never reaches the bottom. With the record at the response the
     * pre-acknowledgement read is refused; with it below the early returns that read applies.
     *
     * The bounded cost of recording an acknowledgement whose row is then cancelled is deliberate and
     * already held by `does not skip forever when the server stops listing a localId a PATCH
     * acknowledged` below: the accepted set dies with the in-flight chain.
     */
    it('records the enqueue acknowledgement above the branches that retire local custody', async () => {
        const scope = armSession();
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));

        await fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => queuedRowsResponse([SEED_LOCAL_ID, WITNESS_LOCAL_ID]),
        });
        expect(publishedLocalIds()).toContain(WITNESS_LOCAL_ID);

        // One GET, issued BEFORE the enqueue POST and still outstanding when it is acknowledged.
        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const sharedRead = (async () => { await gate; return queuedRowsResponse([SEED_LOCAL_ID]); })();
        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => (await sharedRead).clone(),
        });

        let postStarted!: () => void;
        const postStartedGate = new Promise<void>((resolve) => { postStarted = resolve; });
        let releasePost!: () => void;
        const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
        const enqueueRequest = async (_path: string, init?: RequestInit) => {
            if (init?.method !== 'POST') return new Response(null, { status: 200 });
            postStarted();
            await postGate;
            return currentPendingEnqueueAck(init);
        };

        const enqueue = enqueuePendingMessageV2({
            sessionId: SESSION_ID,
            localId: ACKNOWLEDGED_LOCAL_ID,
            text: 'acknowledged, then cancelled before the response was processed',
            encryption,
            outboxScope: scope,
            serverWireMode: 'pending_input_v1',
            request: enqueueRequest,
        });
        await postStartedGate;
        const cancellation = deletePendingMessageV2({
            sessionId: SESSION_ID,
            pendingId: ACKNOWLEDGED_LOCAL_ID,
            outboxScope: scope,
            request: enqueueRequest,
        });
        releasePost();
        await Promise.all([enqueue, cancellation]);

        release();
        await refresh;

        expect(publishedLocalIds()).toContain(WITNESS_LOCAL_ID);

        // Bounded: with no predecessor left registered, the next refresh applies normally.
        await fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => queuedRowsResponse([SEED_LOCAL_ID]),
        });
        expect(publishedLocalIds()).toEqual([SEED_LOCAL_ID]);
    });

    /** The same ordering against the OTHER moved line: the replay POST's own acknowledgement. */
    it('records the replay acknowledgement above the branches that retire local custody', async () => {
        const scope = armSession();
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));

        await fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => queuedRowsResponse([SEED_LOCAL_ID, WITNESS_LOCAL_ID]),
        });
        await enqueueWithoutClientAcknowledgement({
            sessionId: SESSION_ID,
            localId: ACKNOWLEDGED_LOCAL_ID,
            scope,
            encryption,
        });
        expect(publishedLocalIds()).toContain(WITNESS_LOCAL_ID);

        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const sharedRead = (async () => { await gate; return queuedRowsResponse([SEED_LOCAL_ID]); })();
        const refresh = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => (await sharedRead).clone(),
        });

        let postStarted!: () => void;
        const postStartedGate = new Promise<void>((resolve) => { postStarted = resolve; });
        let releasePost!: () => void;
        const postGate = new Promise<void>((resolve) => { releasePost = resolve; });
        const replayRequest = async (_path: string, init?: RequestInit) => {
            if (init?.method !== 'POST') return new Response(null, { status: 200 });
            postStarted();
            await postGate;
            return currentPendingEnqueueAck(init);
        };

        const replay = retryPendingOutboxOperationV2({
            sessionId: SESSION_ID,
            localId: ACKNOWLEDGED_LOCAL_ID,
            outboxScope: scope,
            serverWireMode: 'pending_input_v1',
            request: replayRequest,
        });
        await postStartedGate;
        const cancellation = deletePendingMessageV2({
            sessionId: SESSION_ID,
            pendingId: ACKNOWLEDGED_LOCAL_ID,
            outboxScope: scope,
            request: replayRequest,
        });
        releasePost();
        await Promise.all([replay, cancellation]);

        release();
        await refresh;

        expect(publishedLocalIds()).toContain(WITNESS_LOCAL_ID);

        // Bounded: with no predecessor left registered, the next refresh applies normally.
        await fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => queuedRowsResponse([SEED_LOCAL_ID]),
        });
        expect(publishedLocalIds()).toEqual([SEED_LOCAL_ID]);
    });

    /**
     * The mirror-image hazard of recording: a localId the server acknowledges and then STOPS
     * listing — settled, cancelled, discarded — must not wedge the queue. The accepted set lives on
     * the token, and a token is only inherited while its predecessor is still registered, so the
     * chain has to self-clear as soon as no predecessor is in flight.
     */
    it('does not skip forever when the server stops listing a localId a PATCH acknowledged', async () => {
        const scope = armSession();
        const encryption = await Encryption.create(new Uint8Array(32).fill(6));

        let release!: () => void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        const sharedRead = (async () => { await gate; return queuedRowsResponse([SEED_LOCAL_ID]); })();
        const dedupedRequest = async () => (await sharedRead).clone();

        const first = fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: dedupedRequest,
        });

        await enqueueWithoutClientAcknowledgement({
            sessionId: SESSION_ID,
            localId: ACKNOWLEDGED_LOCAL_ID,
            scope,
            encryption,
        });
        await updatePendingMessageV2({
            sessionId: SESSION_ID,
            pendingId: ACKNOWLEDGED_LOCAL_ID,
            text: 'edited, then settled server-side',
            encryption,
            outboxScope: scope,
            request: async () => new Response('{}', { status: 200 }),
        });

        // Four overlapping successors, all adopting the same pre-PATCH read.
        const chain = [1, 2, 3, 4].map(() => fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: dedupedRequest,
        }));
        release();
        await Promise.all([first, ...chain]);
        expect(publishedLocalIds()).toContain(ACKNOWLEDGED_LOCAL_ID);

        // The server has since settled the row and lists only the seed, forever.
        await fetchAndApplyPendingMessagesV2({
            sessionId: SESSION_ID,
            encryption,
            outboxScope: scope,
            isOutboxScopeCurrent: () => true,
            request: async () => queuedRowsResponse([SEED_LOCAL_ID]),
        });
        expect(publishedLocalIds()).toEqual([SEED_LOCAL_ID]);
    });
});
