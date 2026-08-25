import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import type { ActionHandler } from '@happier-dev/plugin-sdk/actions';

import { bindCorpusCollections } from '../corpus/collections/bindCorpusCollections.js';
import type { CorpusCollectionsV1 } from '../corpus/collections/bindCorpusCollections.js';
import { requireTriageAccountStorage } from '../requiredAccountStorage.js';
import { setPinned } from '../corpus/marks/setPinned.js';
import { readPinnedSection } from '../corpus/query/pinnedSection.js';
import type {
    TriageListPinnedEntriesInputV1,
    TriageListPinnedEntriesResultV1,
    TriageSetEntryPinnedInputV1,
    TriageSetEntryPinnedResultV1,
} from './userMarksProtocol.js';

/**
 * The two user-mark Actions: the surface's only path to the canonical
 * `user-marks` writer and reader.
 *
 * Neither of these is a second authority. `setPinned` still owns idempotency,
 * the mark's derived address, the conditional tombstone resurrection and the
 * conflict verdict; `readPinnedSection` still owns the section's cursor, order
 * and count. This module transports the caller's intent to them and projects
 * their answer back, discarding the storage tag on the way out.
 */

export type TriageUserMarksDepsV1 = Readonly<{
    /** The `user-marks` Collection. It is the only Collection these Actions touch. */
    collections: Pick<CorpusCollectionsV1, 'userMarks'>;
    nowMs: () => number;
    signal?: AbortSignal;
}>;

export async function setTriageEntryPinned(
    input: TriageSetEntryPinnedInputV1,
    deps: TriageUserMarksDepsV1,
): Promise<TriageSetEntryPinnedResultV1> {
    const common = {
        collections: deps.collections,
        // Passed through exactly as the caller's projection produced it. The
        // mark's address is derived from this reference alone, so a reference
        // this Action rebuilt or normalized could address a second row for one
        // entry — the duplicate pin a second device would then show.
        entryRef: input.entryRef,
        nowMs: deps.nowMs(),
        ...(deps.signal ? { signal: deps.signal } : {}),
    };
    const result = input.pinned
        ? await setPinned({ ...common, pinned: true, displayAtMark: input.displayAtMark })
        : await setPinned({ ...common, pinned: false });
    return { v: 1, status: result.status };
}

export async function listTriagePinnedEntries(
    input: TriageListPinnedEntriesInputV1,
    deps: TriageUserMarksDepsV1,
): Promise<TriageListPinnedEntriesResultV1> {
    // One bounded page and no per-row hydration: a mark already carries the
    // reference and the display values a row needs.
    const page = await readPinnedSection({
        collections: deps.collections,
        limit: input.limit,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(deps.signal ? { signal: deps.signal } : {}),
    });
    return {
        v: 1,
        pins: page.marks.map((mark) => ({
            entryRef: mark.entryRef,
            markedAtMs: mark.markedAtMs,
            displayAtMark: mark.displayAtMark,
        })),
        // Passed through exactly as the marks query produced it. Reducing it to
        // "there is more" is what left every pin after the first page
        // unreachable and, because Unpin is only offered on a row, unremovable.
        ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
    };
}

export function createTriageSetEntryPinnedActionHandler(): ActionHandler<
    TriageSetEntryPinnedInputV1,
    TriageSetEntryPinnedResultV1
> {
    return async (input, context: PluginInvocationContext) => await setTriageEntryPinned(input, {
        collections: bindCorpusCollections(requireTriageAccountStorage(context)),
        nowMs: () => Date.now(),
        signal: context.signal,
    });
}

export function createTriageListPinnedEntriesActionHandler(): ActionHandler<
    TriageListPinnedEntriesInputV1,
    TriageListPinnedEntriesResultV1
> {
    return async (input, context: PluginInvocationContext) => await listTriagePinnedEntries(input, {
        collections: bindCorpusCollections(requireTriageAccountStorage(context)),
        nowMs: () => Date.now(),
        signal: context.signal,
    });
}
