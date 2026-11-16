import { readSessionFollowProjectionOnlySinceCursorV1, readSessionMemoryInputsProjectionOnlySinceCursorV1, readSessionMemoryLocalityProjectionOnlySinceCursorV1, readSessionUsageAccountingProjectionOnlySinceCursorV1, SessionDeletedChangeHintV1Schema } from '@happier-dev/protocol/changes';
import type { Tx } from '@/storage/inTx';

function readDeletionHint(hint: unknown) {
    if (!hint || typeof hint !== 'object' || !('lifecycle' in hint) || hint.lifecycle !== 'deleted') return null;
    const deletion = SessionDeletedChangeHintV1Schema.safeParse(hint);
    return deletion.success ? deletion.data : null;
}

export function sessionChangeHint(hint: unknown): Record<string, unknown> {
    const deletion = readDeletionHint(hint);
    if (deletion) return deletion;
    const record = hint && typeof hint === 'object' && !Array.isArray(hint) ? hint as Record<string, unknown> : {};
    const result = { ...record, followReceiverAvailabilityChanged: record.followReceiverAvailabilityChanged === true };
    // Cursor-stamped facts are server-owned: only the coalescing merge below writes them.
    delete (result as Record<string, unknown>).followReceiverAvailabilityChangedAtCursor;
    delete (result as Record<string, unknown>).transcriptRevisedAtCursor;
    return result;
}

/**
 * Retain each coalesced event's original Account cursor, never the later coalescing cursor:
 * receiver availability, and a transcript row revision a later append hint replaces.
 */
export function mergeSessionCoalescedHint(current: unknown, hint: unknown, cursor: number): Record<string, unknown> {
    const next = sessionChangeHint(hint);
    // Physical deletion has a closed authority envelope, not an open row hint.
    if (readDeletionHint(next)) return next;
    const previous = current && typeof current === 'object' && !Array.isArray(current) ? current as Record<string, unknown> : {};
    const isCursor = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
    const revisedAt = typeof next.updatedMessageSeq === 'number' ? cursor
        : isCursor(previous.transcriptRevisedAtCursor) ? previous.transcriptRevisedAtCursor : undefined;
    const merged = revisedAt === undefined ? next : { ...next, transcriptRevisedAtCursor: revisedAt };
    if (next.followReceiverAvailabilityChanged === true) return { ...merged, followReceiverAvailabilityChangedAtCursor: cursor };
    if (previous.followReceiverAvailabilityChanged === true && isCursor(previous.followReceiverAvailabilityChangedAtCursor)) {
        return { ...merged, followReceiverAvailabilityChanged: true,
            followReceiverAvailabilityChangedAtCursor: previous.followReceiverAvailabilityChangedAtCursor };
    }
    return merged;
}

/** The PostgreSQL form of `mergeSessionCoalescedHint`, over trusted publication columns/parameters, not caller text. */
export function sessionCoalescedHintSql(existing: string, next: string, cursor: string): string {
    return `CASE WHEN ${next}->>'lifecycle' = 'deleted' THEN ${next}
        ELSE (CASE WHEN ${next}->>'followReceiverAvailabilityChanged' = 'true'
        THEN ${next} || jsonb_build_object('followReceiverAvailabilityChangedAtCursor', ${cursor})
        WHEN ${existing}->>'followReceiverAvailabilityChanged' = 'true'
            AND jsonb_typeof(${existing}->'followReceiverAvailabilityChangedAtCursor') = 'number'
        THEN ${next} || jsonb_build_object('followReceiverAvailabilityChanged', true,
            'followReceiverAvailabilityChangedAtCursor', ${existing}->'followReceiverAvailabilityChangedAtCursor')
        ELSE ${next} END) || (CASE WHEN jsonb_typeof(${next}->'updatedMessageSeq') = 'number'
        THEN jsonb_build_object('transcriptRevisedAtCursor', ${cursor})
        WHEN jsonb_typeof(${existing}->'transcriptRevisedAtCursor') = 'number'
        THEN jsonb_build_object('transcriptRevisedAtCursor', ${existing}->'transcriptRevisedAtCursor')
        ELSE '{}'::jsonb END) END`;
}

/** A generic source invalidation must withdraw a retained projection-only fact. */
export function retainSessionSourceChangeHint(hint: unknown): unknown {
    if (!hint || typeof hint !== 'object' || Array.isArray(hint)) return hint;
    const retained = { ...(hint as Record<string, unknown>) };
    delete retained.followSourceChanged;
    delete retained.followSourceUnchangedSinceCursor;
    delete retained.usageAccountingChanged;
    delete retained.usageAccountingUnchangedSinceCursor;
    delete retained.memoryInputsChanged;
    delete retained.memoryInputsUnchangedSinceCursor;
    delete retained.memoryLocalityChanged;
    delete retained.memoryLocalityUnchangedSinceCursor;
    return retained;
}

/** The existing Account publication fence protects this exact coalesced row. */
export async function coalesceSessionProjectionChangeHintInTx(
    tx: Tx, accountId: string, entityId: string, hint: unknown,
    cursor?: number,
): Promise<unknown> {
    const deletion = readDeletionHint(hint);
    if (deletion) return deletion;
    const projectionOnly = hint && typeof hint === 'object' && !Array.isArray(hint)
        && ((hint as Record<string, unknown>).followSourceChanged === false
            || (hint as Record<string, unknown>).usageAccountingChanged === false
            || (hint as Record<string, unknown>).memoryInputsChanged === false
            || (hint as Record<string, unknown>).memoryLocalityChanged === false);
    if (cursor === undefined && hint !== undefined && !projectionOnly) return sessionChangeHint(hint);
    const current = await tx.accountChange.findUnique({
        where: { accountId_kind_entityId: { accountId, kind: 'session', entityId } },
        select: { cursor: true, hint: true },
    });
    const merge = (next: unknown) => {
        const incoming = { ...sessionChangeHint(next),
            followReceiverAvailabilityChanged: sessionChangeHint(hint).followReceiverAvailabilityChanged };
        return cursor === undefined ? incoming : mergeSessionCoalescedHint(current?.hint, incoming, cursor);
    };
    if (!projectionOnly) return merge(hint === undefined ? retainSessionSourceChangeHint(current?.hint) : hint);
    const next = { ...(hint as Record<string, unknown>) };
    // One existing coalesced-row read owns both independent projection proofs.
    for (const [changed, unchangedSince, readSince] of [
        ['followSourceChanged', 'followSourceUnchangedSinceCursor', readSessionFollowProjectionOnlySinceCursorV1],
        ['usageAccountingChanged', 'usageAccountingUnchangedSinceCursor', readSessionUsageAccountingProjectionOnlySinceCursorV1],
        ['memoryInputsChanged', 'memoryInputsUnchangedSinceCursor', readSessionMemoryInputsProjectionOnlySinceCursorV1],
        ['memoryLocalityChanged', 'memoryLocalityUnchangedSinceCursor', readSessionMemoryLocalityProjectionOnlySinceCursorV1],
    ] as const) {
        if (next[changed] !== false) continue;
        const since = readSince(current?.hint);
        next[unchangedSince] = since !== null && current && since < current.cursor ? since : current?.cursor ?? 0;
    }
    return merge(next);
}
