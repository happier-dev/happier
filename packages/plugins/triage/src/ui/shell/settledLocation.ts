import * as React from 'react';
import type { RenderContext } from '@happier-dev/plugin-sdk/ui';
import type { TriageEntryRefV1 } from '@happier-dev/triage-protocol/v1';

import type { TriageEntryDetailLaunchInputV1 } from '../../composer/entryDetailLaunchInput.js';
import type { CorpusExplicitOpenSelectionV1 } from '../../corpus/selection/selectObservationInstance.js';
import type { TriageListWindowSnapshotV1 } from '../../projection/listWindowStore.js';
import { triageEntryRowKey } from '../../projection/listWindow.js';
import type { TriageListDisplayRowV1 } from '../marks/pinnedRows.js';
import { buildTriageRouteSubPathV1, parseTriageRouteSubPathV1, readTriageRouteLensV1, type TriageRouteWriteQueueV1 } from '../navigation/location.js';
import { sameTriageEntryRefV1, type TriageSurfaceActionV1, type TriageSurfaceStateV1 } from '../state/surface.js';

/** The effective canonical spelling of a host-settled page location. */
export function canonicalTriageSubPathV1(subPath: string | undefined): string {
  return buildTriageRouteSubPathV1(parseTriageRouteSubPathV1(subPath));
}

export type TriageSettledRouteV1 = Readonly<{
  subPath: string;
  state: TriageSurfaceStateV1;
}>;

export type TriageRouteRowIndexV1 = ReadonlyMap<
  string,
  Readonly<{ sectionId: string; row: TriageListDisplayRowV1 }>
>;

/**
 * Apply the location the host actually settled to one optimistic candidate.
 *
 * The route carries the canonical entry ref but never the selected connection,
 * so qualification is retained only when that exact ref already belongs to
 * the candidate/base, or is supplied by the current mounted window. No other
 * connection is guessed.
 */
export function applyTriageSettledSubPathV1(input: Readonly<{
  candidate: TriageSurfaceStateV1;
  previous: TriageSurfaceStateV1;
  subPath: string;
  rowsByKey: TriageRouteRowIndexV1;
}>): TriageSurfaceStateV1 {
  const lens = parseTriageRouteSubPathV1(input.subPath);
  const located = lens.selection;
  let selection: TriageSurfaceStateV1['selection'] = null;
  if (located !== null) {
    if (input.candidate.selection !== null
      && sameTriageEntryRefV1(input.candidate.selection.entryRef, located)) {
      selection = input.candidate.selection;
    } else if (input.previous.selection !== null
      && sameTriageEntryRefV1(input.previous.selection.entryRef, located)) {
      selection = input.previous.selection;
    } else {
      for (const hit of input.rowsByKey.values()) {
        if (!sameTriageEntryRefV1(hit.row.entryRef, located)
          || hit.row.sourceInstanceId === null) continue;
        selection = {
          sectionId: hit.sectionId,
          entryRef: hit.row.entryRef,
          sourceInstanceId: hit.row.sourceInstanceId,
        };
        break;
      }
    }
  }
  return {
    ...input.candidate,
    order: lens.order,
    smartPolicy: lens.smartPolicy,
    // Own route settlement need not erase a client-local connection choice.
    // Copied/reloaded/external lenses still adopt their instance-free facets.
    filters: buildTriageRouteSubPathV1(readTriageRouteLensV1(input.candidate)) === input.subPath
      ? input.candidate.filters : lens.filters,
    selectedViewId: lens.selectedViewId,
    search: { query: lens.query, composing: null },
    selection,
  };
}

/**
 * Follow the entry this page was asked to show back into the reducer's
 * selection — whether the host settled it as a location or delivered it as a
 * launch argument.
 *
 * This is the other half of the route binding, and without it the shareable
 * location is write-only. Three things depend on it and all three are ordinary
 * product behavior rather than edge cases:
 *
 * - **Back closes the detail.** The route owner declares a page-internal Back
 *   step whose location has no selection. The host settles it, and the only
 *   thing that reaches this surface is a new `subPath` — so a mount that read
 *   its location once, at construction, left the reader on a detail screen the
 *   system Back button appeared to do nothing to.
 * - **A copied link opens the entry.** The reducer cannot seed a selection from
 *   a location alone, because a selection carries the qualified connection and
 *   the route deliberately never names one. Adoption waits for the window's
 *   source admission: a listed row supplies its connection, and an off-window
 *   entry uses the same configured-source selector as an explicit open. Both
 *   apply the same `rowActivated` the reader's own press produces here.
 * - **Composer View details opens the entry.** A launch names an entry the
 *   page's own location does not, so it takes precedence over the location for
 *   exactly as long as it is unadopted. Unlike a location it carries its OWN
 *   qualified connection, so it does not need the window to supply one — which
 *   is why it selects even when this page's lens does not list the entry. That
 *   ref is not a bounded-window edge case: a page left carrying a query or a
 *   facet is an ordinary reader state, and `core/SURFACE.md` §3.2 with
 *   `core/COMPOSER.md` §7 require it to select behind the honest
 *   not-yet-materialized header rather than to produce nothing at all.
 *
 * Every selection this hook makes goes through the shell's one `applyLensEdit`,
 * so the complete resulting route is measured BEFORE the reducer moves, exactly
 * as it is for a press. Two consequences are deliberate. An adoption whose route
 * would not fit is REFUSED and shown, rather than opening a detail the URL
 * cannot name; so the route owner writes the result of every adoption it
 * accepts, and there is no accepted selection it did not write. And an adoption
 * that is refused is not adopted, so the launch stays pending — the honest state
 * for an open that did not happen.
 *
 * It never writes a location of its own, and the rules are deliberately not
 * symmetric.
 *
 * Neither rule may read a **stale** location, and the prop is stale for exactly
 * as long as a write this mount asked for is in flight. Dismissal has always
 * required the incoming location to have actually **changed** for that reason:
 * a rule that read the stale value would clear the selection the reader just
 * made. Adoption needs the same guard and used to lack it, which was invisible
 * only while the location the mount was leaving named no OTHER entry. It does
 * as soon as one selection replaces another — a launch opening B over a page
 * standing on A, or the reader closing a deep-linked detail — and the stale
 * location would pull them straight back to the entry they left. So the
 * location is read as current only when the host has just handed it over, or
 * when this mount has produced no lens intent of its own yet.
 *
 * A launch is adopted at most once, and it outranks the location while it is
 * unadopted: it is the entry the page was OPENED at, and the location it is
 * standing on has already been asked to move. The host retires a delivered open
 * when the page's location moves, so the value normally disappears on its own
 * the moment that write settles — but the reader can close the detail before
 * that, and a launch re-read after they did would reopen it behind them.
 */
export function useTriageSettledLocation(input: Readonly<{
  subPath: string | undefined;
  launch: TriageEntryDetailLaunchInputV1 | undefined;
  pageLaunch: RenderContext['launch'];
  /** Admission can arrive after a settled window without changing its rows. */
  configuredSources: TriageListWindowSnapshotV1['configuredSources'];
  targetedContributions: RenderContext['surface']['targetedContributions'];
  readEntryActivation: (entryRef: TriageEntryRefV1) => Extract<TriageSurfaceActionV1, { kind: 'rowActivated' }>
    | Extract<CorpusExplicitOpenSelectionV1, { kind: 'none' }> | null;
  surface: TriageSurfaceStateV1;
  rowsByKey: ReadonlyMap<string, Readonly<{ sectionId: string; row: TriageListDisplayRowV1 }>>;
  /**
   * Whether a pass has answered for this mount. Before one has, an absent row
   * means "not read yet", not "this page's lens excludes it" — and only the
   * second is a launch this window will never materialize.
   */
  windowSettled: boolean;
  /** The shell's one preflighted lens-edit path; see `applyLensEdit`. */
  applyLensEdit: (action: TriageSurfaceActionV1, refusal: 'selection' | 'lens') => void;
  dispatch: React.Dispatch<TriageSurfaceActionV1>;
  readerChangedLens: React.RefObject<boolean>;
  settledRoute: React.RefObject<TriageSettledRouteV1>;
  latestRouteIntent: React.RefObject<TriageSettledRouteV1>;
  queue: TriageRouteWriteQueueV1;
  onRouteWriteFailure: (failure: 'unavailable' | 'rejected' | null) => void;
}>): void {
  const {
    applyLensEdit,
    dispatch,
    launch,
    pageLaunch,
    readEntryActivation,
    configuredSources,
    targetedContributions,
    latestRouteIntent,
    queue,
    readerChangedLens,
    rowsByKey,
    settledRoute,
    subPath,
    surface,
    windowSettled,
    onRouteWriteFailure,
  } = input;
  const selection = surface.selection;
  /** The last location the host actually handed this mount. */
  const observedSubPath = React.useRef(subPath);
  /** The delivered open this mount has already turned into a selection. */
  const adoptedLaunch = React.useRef<TriageEntryDetailLaunchInputV1 | RenderContext['launch']>(undefined);

  React.useEffect(() => {
    const changed = observedSubPath.current !== subPath;
    observedSubPath.current = subPath;

    const open = launch ?? pageLaunch;
    const pendingOpen = open !== undefined && adoptedLaunch.current !== open ? open : null;
    const pendingLaunch = pendingOpen !== null && 'entryRef' in pendingOpen ? pendingOpen : null;
    const canonicalSubPath = canonicalTriageSubPathV1(subPath);
    if (changed) {
      const previous = settledRoute.current;
      const state = applyTriageSettledSubPathV1({
        // Host location publication may precede the write acknowledgement.
        // A settle-before-commit operation has not rendered its selection yet.
        // Preserve its admitted connection only for the exact requested route;
        // a different host location must still qualify on its own authority.
        candidate: latestRouteIntent.current.subPath === canonicalSubPath
          ? latestRouteIntent.current.state : surface,
        previous: previous.state,
        subPath: canonicalSubPath,
        rowsByKey,
      });
      settledRoute.current = { subPath: canonicalSubPath, state };
      // The host can publish the issued A while B is waiting for A's ack.
      // Retain A as the rollback base, not as a new external reader intent.
      if (pendingOpen === null && queue.adoptHostLocation(canonicalSubPath)) return;
      latestRouteIntent.current = settledRoute.current;
      onRouteWriteFailure(null);
      // A delivered launch outranks the location it arrived over. The new
      // location is still the rollback base, but only an ordinary host move is
      // rendered immediately.
      if (pendingOpen === null) {
        dispatch({ kind: 'settledRouteApplied', state });
        return;
      }
    }
    // The location speaks for the host only while it is one the host has just
    // handed over, or while this mount has produced no intent of its own yet.
    // In between — a selection accepted and its replacement still in flight —
    // the prop names the location the mount is LEAVING, and reading it as
    // current would pull the reader back to the entry they left.
    if (pendingOpen === null
      && !changed
      && readerChangedLens.current
      && (canonicalSubPath !== settledRoute.current.subPath
        || canonicalSubPath !== latestRouteIntent.current.subPath)) return;
    const located = pendingLaunch === null
      ? parseTriageRouteSubPathV1(subPath).selection
      : pendingLaunch.entryRef;

    if (located === null) {
      if (selection === null || !changed) return;
      // The settled location no longer names an entry — the host walked its own
      // Back step — so the selection it named is gone with it.
      dispatch({
        kind: 'detailDismissed',
        visibleOrder: [...rowsByKey.values()].map((hit) => ({
          sectionId: hit.sectionId,
          entryRef: hit.row.entryRef,
        })),
      });
      return;
    }

    // A launch names ONE exact connection, and it is the connection every
    // branch below selects with. The launch-input parser already refused a pair
    // whose connection could not have observed the entry rather than
    // substituting one, and a page that reopened the entry under whichever
    // connection its own window happened to qualify would undo that refusal
    // after the fact — **View details** on the account the reader chose,
    // silently acting through another they also happen to have configured.
    const launchInstanceId = pendingLaunch === null
      ? null
      : pendingLaunch.sourceInstance.sourceInstanceId;

    if (selection !== null && sameTriageEntryRefV1(selection.entryRef, located)) {
      // The reducer is showing the named entry, so a pending launch has done
      // its whole job and is retired HERE rather than where it is dispatched:
      // this is the one place both routes into the selection converge, and it
      // is also the truthful condition — an open that named the entry already
      // on screen is just as consumed as one that had to change it.
      //
      // "The named entry" is the entry AND its connection. Entry identity alone
      // retires a launch that still has to move the selection off another
      // account, leaving the reader on a detail the launch did not ask for.
      if (launchInstanceId === null || selection.sourceInstanceId === launchInstanceId) {
        adoptedLaunch.current = open;
        // A later page can exclude the selected entry without answering its
        // existence. Re-enter the same admitted exact-open path below, keeping
        // the selected connection; a null section already owns that read.
        if (!windowSettled || selection.sectionId === null
          || rowsByKey.has(triageEntryRowKey(located))) return;
      }
    }
    for (const hit of rowsByKey.values()) {
      if (!sameTriageEntryRefV1(hit.row.entryRef, located)) continue;
      // A row the window could not qualify carries no connection, and opening
      // one anyway would read somebody else's. That is a rule about a LOCATION,
      // which names no connection at all: the entry stays unadopted until a
      // pass qualifies it. A launch is not in that position — it carries its
      // own qualified connection — so it selects on its own authority here for
      // the same reason it does below.
      const sourceInstanceId = launchInstanceId ?? hit.row.sourceInstanceId;
      if (sourceInstanceId === null) return;
      applyLensEdit({
        kind: 'rowActivated',
        sectionId: hit.sectionId,
        entryRef: hit.row.entryRef,
        sourceInstanceId,
      }, 'selection');
      return;
    }

    // A settled route names one exact entry. Qualify it through the same
    // configured-source admission as an explicit open; list coverage cannot
    // answer whether that entry is present, withdrawn or unreadable. The list's
    // visible Load more remains the only owner of continuation demand.
    if (pendingLaunch === null) {
      if (!windowSettled) return;
      const action = readEntryActivation(located);
      if (action?.kind === 'none') {
        // A settled admission refusal answers this route; absence from a
        // filtered/partial window does not. Keep every valid lens field and
        // retire only the entry no active configured connection can observe.
        if (action.reason === 'noActiveInstance') {
          applyLensEdit({ kind: 'settledRouteApplied', state: { ...surface, selection: null } }, 'selection');
        }
      } else if (action !== null) applyLensEdit(action, 'selection');
      return;
    }
    // A launch carries its own qualified connection, already checked against
    // the entry's source by the launch-input parser. Once a pass answers,
    // selecting without a section enters the same exact-read owner. Until
    // then, a listed row can still supply its ordinary qualification.
    if (!windowSettled) return;
    applyLensEdit({
      kind: 'rowActivated',
      sectionId: null,
      entryRef: pendingLaunch.entryRef,
      sourceInstanceId: pendingLaunch.sourceInstance.sourceInstanceId,
    }, 'selection');
  }, [
    applyLensEdit,
    dispatch,
    launch,
    pageLaunch,
    readEntryActivation,
    configuredSources,
    targetedContributions,
    latestRouteIntent,
    queue,
    readerChangedLens,
    rowsByKey,
    selection,
    settledRoute,
    subPath,
    windowSettled,
    onRouteWriteFailure,
  ]);
}
