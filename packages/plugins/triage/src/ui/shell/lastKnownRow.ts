import type { TriageListRowV1 } from '../../projection/listWindow.js';
import { sameTriageEntryRefV1, type TriageSurfaceSelectionV1 } from '../state/surface.js';

/**
 * The last row the window published for the selection the reader is holding.
 *
 * `ui/state/surface.ts` keeps the selection when its entry leaves the window,
 * because the reader chose it and the window did not — but the window is where
 * every fact about that entry lives, so the detail region was left with the
 * cause and no subject: the title, state, scope, attention and observing
 * connection of the entry the reader was reading all disappeared with the row.
 *
 * This is that one row, and deliberately nothing more:
 *
 * - **One selection's worth.** A selection that moves to another entry or
 *   another connection drops what was held, and clearing the selection drops it
 *   outright. There is no set, no eviction policy and nothing to page.
 * - **Presentation only.** It is derived per render from the selection and the
 *   window, so it neither persists, survives the mount, nor answers anybody but
 *   the detail header. It is not a second corpus and cannot be read as one.
 * - **Never current.** What it holds was true when the window last published
 *   it. The header says so; nothing here upgrades a retained fact into a live
 *   one, and no source detail is read from it.
 *
 * The section a selection was made in is deliberately not part of its identity.
 * A row that is regrouped keeps being the same entry read through the same
 * connection, and resetting on it would throw the header away because a heading
 * moved.
 */

export type TriageLastKnownRowV1 = Readonly<{
  selection: TriageSurfaceSelectionV1;
  row: TriageListRowV1;
}>;

function sameSelectedEntry(
  held: TriageSurfaceSelectionV1,
  selection: TriageSurfaceSelectionV1,
): boolean {
  return held.sourceInstanceId === selection.sourceInstanceId
    && sameTriageEntryRefV1(held.entryRef, selection.entryRef);
}

/**
 * What to hold after this render, given what was held before, what is selected
 * now, and the row the current window lists for it.
 *
 * It returns the value it was given whenever nothing changed, so the header
 * projected from it keeps its identity across renders the window did not cause.
 */
export function retainTriageLastKnownRowV1(
  held: TriageLastKnownRowV1 | null,
  selection: TriageSurfaceSelectionV1 | null,
  listed: TriageListRowV1 | null,
): TriageLastKnownRowV1 | null {
  if (selection === null) return null;
  const matches = held !== null && sameSelectedEntry(held.selection, selection);
  if (listed === null) return matches ? held : null;
  return matches && held.row === listed ? held : Object.freeze({ selection, row: listed });
}
