import { readTriageWindowLensV1 } from '../shell/lens.js';
import type { TriageSurfaceStateV1 } from '../state/surface.js';

/**
 * What counts as "the same list" for a bulk selection.
 *
 * The shared selection owner clears a set when its SCOPE changes, so this
 * function decides the one thing that rule depends on. It is the window lens
 * and the grouping MINUS the query: everything that decides which rows exist,
 * except the transient text the reader is typing.
 *
 * That exception is the whole point. A query narrows which of this scope's rows
 * are SHOWN; it does not change what the reader is looking at. Including it
 * made every keystroke a new scope, so a reader who chose six entries and then
 * typed to find a seventh lost all six — while the code beside it claimed the
 * opposite ("a reader who narrows the query keeps the rows they already
 * chose"). The code and the comment disagreed, and the comment was right about
 * the intent.
 *
 * Changing the ORDER, a facet, the Smart policy or the grouping IS a different
 * list, and carrying a set across one would act on entries the reader can no
 * longer see.
 *
 * The query is dropped by destructuring rather than by naming the members to
 * keep, so a lens that gains a member joins the scope automatically instead of
 * silently falling out of it.
 */
export function readTriageBulkSelectionScopeKeyV1(state: TriageSurfaceStateV1): string {
    const { query: _narrowingText, ...scopedLens } = readTriageWindowLensV1(state);
    return JSON.stringify({ lens: scopedLens, grouping: state.grouping });
}
