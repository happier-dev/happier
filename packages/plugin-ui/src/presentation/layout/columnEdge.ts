import { createContext, useContext } from 'react';

/**
 * How much of the page's edge the enclosing column already draws, in px.
 *
 * A page's anatomy insets itself from the column's edge: a sheet by `sheetInsetPx`, a title or section title by
 * `pageTextInsetPx`. A column that owns an edge of its own (a detail's body, so its prose lines up with the
 * detail's title) pads its content by that measure and provides it here; the self-insetting anatomy inside
 * subtracts it, so a sheet still sits on the sheet edge and a heading on the text edge instead of twice inset.
 * Absent (every page), nothing is drawn yet: `0`. A host that mounts public sections inside a page whose own
 * sections already sit on that edge (Happier's core page column) provides the edge here.
 */
export const HappierColumnEdgeContext = createContext(0);

/** @internal The rest of `insetPx` the anatomy draws itself inside a column that already draws part of the edge. */
export function useHappierColumnEdgeRemainder(insetPx: number): number {
  return Math.max(0, insetPx - useContext(HappierColumnEdgeContext));
}

/** @internal */
export function useHappierColumnEdgePx(): number {
  return useContext(HappierColumnEdgeContext);
}

/**
 * A body that already stands its content on its own edge (a widget frame's body, a preview pane): a line
 * inside it (an empty note, a failure line) starts on that edge, beside the body's titles and text, instead
 * of adding a collection row's inset of its own.
 */
export const HappierBodyEdgeContext = createContext(false);
