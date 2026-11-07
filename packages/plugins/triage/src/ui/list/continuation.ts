import type { TriageListWindowV1 } from '../../projection/listWindow.js';
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

/**
 * The window-honesty line under the list (COLLECTION.md §2, DESIGN-SPEC §2.4): how many rows are loaded, and
 * whether that is everything — "12 loaded · complete", or which connections may have more — then anything the
 * reader's pins have to say. The line reads the window's own coverage claim and its lanes; it never computes
 * "N of M". A failed or unresumable read says so in the words its continuation copy already owns. Before a window
 * exists it says nothing about entries, except that the first read is still under way: a cold first read can take
 * a minute, and skeleton rows alone never say why nothing is there yet.
 */
export function readTriageWindowStatementV1(input: Readonly<{
  loadedCount: number;
  window: Pick<TriageListWindowV1, 'coverage' | 'lanes'> | null;
  configuredSources: readonly Readonly<{
    sourceInstanceId: string;
    source?: Readonly<{ pluginId: string; localId: string }>;
    displayLabel?: string;
  }>[];
  /** The source's own name ("GitHub"), from its mounted descriptor: a connection is said by it, not by its login. */
  readSourceName?: (source: Readonly<{ pluginId: string; localId: string }>) => string | undefined;
  entries: TriageListContinuationCopyV1;
  /** The pins' own continuation copy, while there are more pins or reading them failed; otherwise `null`. */
  pins?: TriageListContinuationCopyV1 | null;
  /** The first read has not answered yet (the page holds its skeleton rows). */
  firstRead?: boolean;
  text: (key: string, fallback?: string, values?: Readonly<Record<string, string | number>>) => string;
}>): readonly string[] | undefined {
  const { window, text } = input;
  const parts: string[] = [];
  // With nothing loaded the body's own state (a failure, an empty or quiet list) is the whole answer, so the
  // line adds nothing about entries beneath it.
  if (window === null && input.firstRead === true) {
    parts.push(text('plugins.triage.surface.window.reading', 'Reading your sources…'));
  }
  if (window !== null && input.loadedCount > 0) {
    parts.push(text('plugins.triage.surface.window.loaded', '{count} loaded', { count: input.loadedCount }));
    if (input.entries.tone === 'warning') {
      // A connection that stopped short because it failed is said once, by the page's failure line.
      const saidByPage = input.entries.actionLabel === undefined && window.lanes.some((lane) =>
        lane.health.kind === 'failed' || lane.health.kind === 'unavailable');
      if (!saidByPage) parts.push(input.entries.title);
    } else if (window.coverage === 'complete') {
      parts.push(text('plugins.triage.surface.window.complete', 'complete'));
    } else {
      const names: string[] = [];
      for (const lane of window.lanes) {
        // Only a connection that answered can "have more": one the pass could not read, or whose read failed,
        // told us nothing, and its failure is said once by the page.
        if (lane.exhausted || lane.health.kind === 'failed' || lane.health.kind === 'unavailable') continue;
        const name = connectionName(input, lane.sourceInstanceId);
        if (name !== undefined && !names.includes(name)) names.push(name);
      }
      parts.push(names.length === 0
        ? input.entries.title
        : text('plugins.triage.surface.window.more', '{names} may have more', { names: names.join(', ') }));
    }
  }
  if (input.pins != null) parts.push(input.pins.title);
  return parts.length === 0 ? undefined : parts;
}

/**
 * The source's declared name ("GitHub"), deduplicated by the footer across its connections.
 * A source without a declared name keeps its connection label.
 */
function connectionName(
  input: Pick<Parameters<typeof readTriageWindowStatementV1>[0], 'configuredSources' | 'readSourceName'>,
  sourceInstanceId: string,
): string | undefined {
  const connection = input.configuredSources.find((candidate) => candidate.sourceInstanceId === sourceInstanceId);
  if (connection === undefined) return undefined;
  const sourceName = connection.source === undefined ? undefined : input.readSourceName?.(connection.source);
  if (sourceName === undefined || sourceName.length === 0) return connection.displayLabel;
  return sourceName;
}
