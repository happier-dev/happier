import type { TriageListLoadMoreV1 } from '../../projection/listWindowStore.js';
import type { TriageTextResolverV1 } from '../shell/windowState.js';

/**
 * What a section's continuation row says, and whether it offers a press
 * (`core/SURFACE.md` §4.2).
 *
 * The row itself was written as a statement with no affordance, because at the
 * time there was nothing for it to invoke: **Refresh** re-read the same first
 * page at the same bound, so implying it could reach a further entry would have
 * made it a dead-end control. There is an operation now — the mount appends one
 * more bounded window, and the pinned section walks one more bounded page — and
 * this module is what turns the published state of that operation into the one
 * sentence and the at-most-one control the row carries.
 *
 * It is deliberately the whole mapping in one place. The two sections' states
 * come from different owners (the window store and the marks read) and their
 * copy differs, but "what is the reader told, and may they press it" is one
 * question; answering it at each row would let the pinned section and the lanes
 * drift into two vocabularies for the same five arms.
 *
 * Nothing here decides whether the row EXISTS. That stays with
 * `planTriageListSections`, which appends it exactly when the section is
 * unfinished — so `exhausted` cannot reach a rendered row, and the arm below is
 * an inert statement rather than a sixth kind of copy for a row that is absent.
 */

/** Which section's limit the row is closing. They page different things. */
export type TriageListContinuationSectionV1 = 'entries' | 'pins';

export type TriageListContinuationCopyV1 = Readonly<{
  title: string;
  description: string;
  tone: 'neutral' | 'warning';
  /**
   * The control's label, present exactly when pressing the row would read more.
   *
   * Absent is not a disabled control: `core/CORPUS.md` §4.2's rule is that a
   * press which does nothing must not be offered at all, so the ceiling and the
   * exhausted arms say why in words and carry no button.
   */
  actionLabel?: string;
  /** The read the control asked for is running. */
  busy: boolean;
}>;

export function planTriageListContinuationV1(input: Readonly<{
  section: TriageListContinuationSectionV1;
  /**
   * What the owner says pressing would do. `undefined` is the mounted window
   * before it has assembled one — it publishes no arm rather than claiming one,
   * so there is nothing here to offer either.
   */
  state: TriageListLoadMoreV1 | undefined;
  text: TriageTextResolverV1;
}>): TriageListContinuationCopyV1 {
  const { section, state, text } = input;
  const pins = section === 'pins';

  if (state?.kind === 'failed') {
    return {
      title: pins
        ? text('plugins.triage.surface.morePins.failed.title', 'More pins could not be loaded')
        : text('plugins.triage.surface.moreEntries.failed.title', 'More entries could not be loaded'),
      // The retention is stated, because it is the thing the reader cannot see
      // from the failure: the rows they already have are untouched.
      description: pins
        ? text('plugins.triage.surface.morePins.failed.description', 'The pins already in this list are still here. Try again to reach the rest.')
        : text('plugins.triage.surface.moreEntries.failed.description', 'The entries already in this list are still here. Try again to reach the rest.'),
      tone: 'warning',
      actionLabel: text('plugins.triage.surface.loadMore.retry', 'Try again'),
      busy: false,
    };
  }

  if (state?.kind === 'unresumable') {
    // The result is incomplete and there is nothing to continue from, so no
    // press is offered: `core/CORPUS.md` §4.2's rule is that a control which
    // would do nothing must not be there at all. **Refresh** is the control
    // that can change this answer, and it is already on the surface — a second
    // one here would be a duplicate owner of the same read.
    return {
      title: pins
        ? text('plugins.triage.surface.morePins.unresumable.title', 'Some pins could not be reached')
        : text('plugins.triage.surface.moreEntries.unresumable.title', 'Some entries could not be reached'),
      description: pins
        ? text('plugins.triage.surface.morePins.unresumable.description', 'The pins already in this list are still here. Refresh to read the rest again.')
        : text('plugins.triage.surface.moreEntries.unresumable.description', 'The entries already in this list are still here. Refresh to read the connections that stopped short.'),
      tone: 'warning',
      busy: false,
    };
  }

  if (state?.kind === 'atCeiling') {
    // Ours, not the source's — so it says the page is full rather than implying
    // the sources finished.
    return {
      title: text('plugins.triage.surface.moreEntries.full.title', 'This page holds as many entries as it can'),
      description: text('plugins.triage.surface.moreEntries.full.description', 'Narrow the filters or search to bring different entries into view.'),
      tone: 'neutral',
      busy: false,
    };
  }

  const title = pins
    ? text('plugins.triage.surface.morePins.title', 'More pinned entries exist')
    : text('plugins.triage.surface.moreEntries.title', 'More entries may exist');
  const description = pins
    ? text('plugins.triage.surface.morePins.description', 'This page shows your most recent pins; load more to reach the rest.')
    : text('plugins.triage.surface.moreEntries.description', 'This window is bounded; load more to reach the entries after these.');

  if (state?.kind === 'available' || state?.kind === 'loading') {
    return {
      title,
      description,
      tone: 'neutral',
      actionLabel: text('plugins.triage.surface.loadMore', 'Load more'),
      busy: state.kind === 'loading',
    };
  }

  // `exhausted`, or an owner that has published no state yet. The section owner
  // drops the row in both cases, so this is the statement it had before there
  // was anything to press — kept honest rather than offering a press the owner
  // has already said it would refuse.
  return { title, description, tone: 'neutral', busy: false };
}
