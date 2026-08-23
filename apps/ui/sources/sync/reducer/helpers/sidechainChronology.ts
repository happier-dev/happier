import type { ReducerMessage } from '../reducer';
import { isTranscriptRowStrictlyOlder } from '../../domains/messages/transcriptOrdering';

/**
 * Sidechain children are materialized incrementally into one array per sidechain, and that
 * array's order *is* the rendered order (`convertReducerMessageToMessage` emits it verbatim as
 * the owning tool-call's `children`; nothing downstream sorts it). A live sub-agent appends,
 * but transcript paging delivers the newest page first and older pages afterwards, so plain
 * appending assembles a historical sub-agent transcript backwards.
 *
 * Rows that are not older than the current tail belong at the end, so the live streaming path is
 * unchanged and rows the transcript cannot distinguish keep their arrival order.
 */
type TranscriptChronologyFields = Readonly<{ seq?: number | null; createdAt: number }>;

function resolveSidechainInsertIndex(
    chain: readonly ReducerMessage[],
    message: TranscriptChronologyFields,
): number {
    const tail = chain[chain.length - 1];
    if (!tail || !isTranscriptRowStrictlyOlder(message, tail)) {
        return chain.length;
    }

    let index = chain.length - 1;
    while (index > 0 && isTranscriptRowStrictlyOlder(message, chain[index - 1]!)) {
        index -= 1;
    }
    return index;
}

export function insertSidechainMessageInChronology(
    chain: ReducerMessage[],
    message: ReducerMessage,
): void {
    chain.splice(resolveSidechainInsertIndex(chain, message), 0, message);
}

/**
 * The block a streamed continuation may extend: the child that immediately precedes where the
 * incoming row belongs chronologically, which is the array tail for the live path and the
 * older page's own preceding row while a historical page is being assembled. Merging against the
 * raw tail instead would concatenate an older page's chunks onto the newest block; refusing to
 * merge at all would shred one streamed block into one child per delivered chunk.
 *
 * The returned block is never newer than `message`, so callers only have to check that it is the
 * right *kind* of block (role, thinking-ness, stream key) to extend.
 */
export function findSidechainMergeTarget(
    chain: readonly ReducerMessage[],
    message: TranscriptChronologyFields,
): ReducerMessage | null {
    const index = resolveSidechainInsertIndex(chain, message);
    return index > 0 ? chain[index - 1] ?? null : null;
}

/**
 * A streamed continuation may only extend a block that is not newer than the incoming row.
 * Used for the thinking merge *cursor*, which is an independent pointer rather than a block
 * derived from the incoming row's own chronology.
 */
export function canExtendSidechainMessage(
    candidate: TranscriptChronologyFields,
    target: TranscriptChronologyFields,
): boolean {
    return !isTranscriptRowStrictlyOlder(candidate, target);
}
