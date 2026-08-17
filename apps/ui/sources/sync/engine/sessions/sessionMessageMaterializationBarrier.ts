/**
 * Session messages this client has RECEIVED but has not finished applying to the transcript.
 *
 * The pending → committed handover is published by the server as a settlement it has ALREADY made
 * durable in one transaction: it deletes the pending row and writes the committed message together
 * (`apps/server/sources/app/session/pending/acceptedPendingSettlementCoordinator.ts`). Every notice
 * that the queue is now empty — the `pending-changed` socket body AND any pending snapshot captured
 * after that transaction — is therefore the RECEIPT for a committed message, not an instruction to
 * drop the utterance.
 *
 * A client that retires the pending row while the committed twin is still being read, decrypted or
 * held in the apply coalescer publishes a transcript frame carrying NEITHER row for that utterance:
 * the list renders one row shorter with its pre-send tail and the viewport moves by a whole row
 * mid-send (`.project/reviews/2026-08-01-send-transition/U2-app-data-revert.md`, 20/20 on iOS).
 *
 * This module owns that one question — "has everything this client already received for the session
 * been applied?" — for BOTH writers that retire pending rows, so they cannot answer it differently:
 *
 *   - `sync/engine/socket/socket.ts` (the `pending-changed` prune), and
 *   - `sync/engine/pending/pendingQueueV2.ts` (publishing a pending snapshot).
 *
 * It is causal, never timed: nothing here schedules, delays or polls by the clock. Callers wait on
 * the set captured at their own arrival, so a continuing message stream cannot starve them, and a
 * materialization that never settles skips the retirement rather than blocking it — leaving a
 * lingering pending row, which the next authoritative snapshot retires, instead of a void frame.
 */

const inFlightSessionMessageMaterializations = new Map<string, Set<Promise<unknown>>>();

/**
 * Applies session messages that have been received and queued but not yet handed to the transcript.
 * Registered by the socket engine, which owns the apply coalescer.
 */
let applyReceivedSessionMessages: ((sessionId: string) => void) | null = null;

function sessionKey(sessionId: string): string {
    return String(sessionId ?? '').trim();
}

export function setReceivedSessionMessageApplier(apply: (sessionId: string) => void): void {
    applyReceivedSessionMessages = apply;
}

/** Records an in-flight message materialization and returns it unchanged. */
export function trackSessionMessageMaterialization<T>(sessionId: string, materialization: Promise<T>): Promise<T> {
    const key = sessionKey(sessionId);
    if (!key) return materialization;
    const entries = inFlightSessionMessageMaterializations.get(key) ?? new Set<Promise<unknown>>();
    inFlightSessionMessageMaterializations.set(key, entries);
    entries.add(materialization);
    const release = () => {
        entries.delete(materialization);
        if (entries.size === 0 && inFlightSessionMessageMaterializations.get(key) === entries) {
            inFlightSessionMessageMaterializations.delete(key);
        }
    };
    materialization.then(release, release);
    return materialization;
}

/**
 * Settles every session message already received for `sessionId`: awaits the materializations in
 * flight at this call, then applies anything still queued in the coalescer. Call this before
 * retiring pending rows for the session.
 */
export async function settleReceivedSessionMessages(sessionId: string): Promise<void> {
    const key = sessionKey(sessionId);
    if (!key) return;
    const entries = inFlightSessionMessageMaterializations.get(key);
    if (entries && entries.size > 0) await Promise.allSettled([...entries]);
    applyReceivedSessionMessages?.(key);
}
