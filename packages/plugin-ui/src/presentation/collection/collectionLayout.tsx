import { createContext, useContext } from 'react';

import type { HappierListDetailLayoutState } from './listDetailGeometry.js';
import type { HappierCollectionComposition } from './collectionTable.js';

/**
 * How a Collection is currently composed: `split` puts the list beside the detail, `stacked` shows one
 * pane (a narrow screen), and `measuring` precedes the first measured layout.
 *
 * The split geometry is the only owner of this fact. It publishes the state in the same render that
 * measured it, so a detail page (an index route inside a nested stack, say) reads the current mode
 * directly instead of through a copy that an effect keeps in step one commit late.
 */
export type HappierCollectionLayoutMode = 'measuring' | HappierListDetailLayoutState['mode'];

/**
 * The mode and, for Collection, its actual list/table/board composition are published. Pane widths
 * stay inside the geometry; Collection keeps the value stable until either published fact changes.
 */
export type HappierCollectionLayoutState = Readonly<{
  mode: HappierCollectionLayoutMode;
  /** The current Collection composition, when provided by Collection rather than a standalone split layout. */
  composition?: HappierCollectionComposition;
  /**
   * A detail is open beside the list right now. `mode: 'split'` only says the window could hold both: a grid, or a
   * list with nothing open, is the whole page.
   */
  detailBeside?: boolean;
}>;

const HAPPIER_COLLECTION_LAYOUT_STATES: Readonly<Record<HappierCollectionLayoutMode, HappierCollectionLayoutState>> = Object.freeze({
  measuring: Object.freeze({ mode: 'measuring' }),
  split: Object.freeze({ mode: 'split' }),
  stacked: Object.freeze({ mode: 'stacked' }),
});
const HAPPIER_COLLECTION_DETAIL_BESIDE_STATE: HappierCollectionLayoutState = Object.freeze({ mode: 'split', detailBeside: true });

/** @internal Provided only by the split geometry (`HappierListDetailLayout`). */
export const HappierCollectionLayoutContext = createContext<HappierCollectionLayoutState | null>(null);

/** @internal The provider value before the first measurement. */
export function resolveHappierCollectionLayoutState(
  measured: HappierListDetailLayoutState | null,
  detailBeside = false,
): HappierCollectionLayoutState {
  return detailBeside && measured?.mode === 'split'
    ? HAPPIER_COLLECTION_DETAIL_BESIDE_STATE
    : HAPPIER_COLLECTION_LAYOUT_STATES[measured?.mode ?? 'measuring'];
}

/**
 * The detail pane's width in a `split` whose own pane holds the detail, so a page inside it decides what
 * depends on its own width (where its back control goes) on the first paint, not after its own
 * measurement. It is a context of its own: a resize that keeps the mode re-renders only its readers,
 * never the layout mode's.
 *
 * @internal Provided only by the split geometry owners (`HappierListDetailLayout`, `Collection`).
 */
export const HappierCollectionDetailWidthContext = createContext<number | null>(null);

/**
 * Host-provided: the host page owns the open item in its route, so the navigation's own Back (a phone's header)
 * already closes a pushed detail and returns to the list, and the pushed detail draws no Back of its own. The page's
 * selection (`model.openKey`) follows its route. A plugin page gets the same through its page chrome
 * (`navigationBackSpendsStep`); this is the same fact for a core page that is not a plugin surface.
 */
export const HappierCollectionNavigationBackClosesDetailContext = createContext(false);

/** @internal */
export function useHappierCollectionDetailWidth(): number | null {
  return useContext(HappierCollectionDetailWidthContext);
}

/**
 * The Collection's layout, or `null` outside a Collection (a page rendered on its own route, not as a
 * Collection's detail).
 */
export function useHappierCollectionLayout(): HappierCollectionLayoutState | null {
  return useContext(HappierCollectionLayoutContext);
}

/**
 * What a Collection's index route shows. Beside the list something is always open, so the index
 * `land`s on an item (and renders nothing of its own); where the list is not beside it — a narrow
 * screen, or outside a Collection — the index IS the list. Before the first measurement it shows
 * nothing, so neither choice flashes.
 */
export type HappierCollectionIndexView = 'pending' | 'land' | 'list';

export function resolveHappierCollectionIndexView(layout: HappierCollectionLayoutState | null): HappierCollectionIndexView {
  if (layout === null) return 'list';
  if (layout.mode === 'measuring') return 'pending';
  return layout.mode === 'split' ? 'land' : 'list';
}

export function useHappierCollectionIndexView(): HappierCollectionIndexView {
  return resolveHappierCollectionIndexView(useHappierCollectionLayout());
}
