import type { SurfaceFilterSelectionV1 } from '../../projection/listWindow.js';
import type { CorpusSavedViewV1 } from '../../settings/savedViews.js';
import { sameTriageFilterValueV1, type TriageFilterFacetValueV1 } from '../state/surface.js';
import type { TriageSavedViewLensV1 } from './savedViewsCommand.js';

/**
 * The ONE answer to "is the reader looking at the view they selected".
 *
 * `core/SURFACE.md` §6.5 makes this a product statement rather than a detail:
 * editing filters, the query, Order or the Smart policy after selecting a view
 * marks the lens **modified without an Account KV write**, and **Update** is the
 * separate explicit operation. So a surface has to be able to say which of the
 * two it is showing, and it must say it from the same comparison the Update
 * button would write — otherwise the reader is told "modified" over a view that
 * already matches, or told nothing over one that does not.
 *
 * It is deliberately NOT `ui/state/narrowing.ts`. That module answers "is the
 * reader's own lens hiding rows from them", and its own contract says in
 * writing that `order`, `grouping` and `smartPolicy` do not count there because
 * they can never remove a row — while a surface asking "have you customised
 * this view" is asking a different question and must not borrow that answer.
 * This is that different question, with its own owner.
 *
 * **The query counts, and it is never equal to a stored view.** A saved view
 * carries no query text at all (`core/CORPUS.md` §6.3), so any settled query is
 * a constraint the saved view does not describe. Saying so is the honest
 * statement; the alternative — ignoring it — would show a reader a list narrowed
 * by their own search under the unqualified name of a saved view.
 */

export type TriageSavedViewLensStatusV1 =
  /** No saved view is selected; the lens is the reader's own unsaved one. */
  | 'unsaved'
  /** The selected view describes exactly what is on screen. */
  | 'saved'
  /** A selected view exists and the lens has moved off it. */
  | 'modified';

function sameFacet(
  facet: TriageFilterFacetValueV1['facet'],
  left: readonly TriageFilterFacetValueV1['value'][],
  right: readonly TriageFilterFacetValueV1['value'][],
): boolean {
  // Set equality, not sequence equality: two selections that differ only in the
  // order the reader pressed them are one constraint, and calling that
  // "modified" would leave an Update button the only way to silence a
  // difference that does not exist. Equal length plus containment is sufficient
  // because the reducer and the one CAS owner both reject a duplicate value.
  if (left.length !== right.length) return false;
  return left.every((value) => right.some((candidate) => sameTriageFilterValueV1(
    { facet, value } as TriageFilterFacetValueV1,
    { facet, value: candidate } as TriageFilterFacetValueV1,
  )));
}

export function sameTriageFilterSelectionV1(
  left: SurfaceFilterSelectionV1,
  right: SurfaceFilterSelectionV1,
): boolean {
  return sameFacet('sources', left.sources, right.sources)
    && sameFacet('types', left.types, right.types)
    && sameFacet('scopes', left.scopes, right.scopes)
    && sameFacet('states', left.states, right.states)
    && sameFacet('attention', left.attention, right.attention);
}

/**
 * Whether two lenses are the same saved lens.
 *
 * The Smart policy is compared whatever the order is, because a view retains it
 * across a non-Smart order switch: a reader who changed the ladder and then
 * looked at the list by date has still changed the view.
 */
export function sameTriageSavedViewLensV1(
  left: TriageSavedViewLensV1,
  right: TriageSavedViewLensV1,
): boolean {
  return left.order === right.order
    && left.smartPolicy.precedence[0] === right.smartPolicy.precedence[0]
    && sameTriageFilterSelectionV1(left.filters, right.filters);
}

export function readTriageSavedViewLensStatusV1(input: Readonly<{
  /** The stored view the reducer's `selectedViewId` names, or `null`. */
  selected: CorpusSavedViewV1 | null;
  lens: TriageSavedViewLensV1;
  /** The settled query. IME-intermediate text reaches neither this nor the window. */
  query: string;
}>): TriageSavedViewLensStatusV1 {
  if (input.selected === null) return 'unsaved';
  if (input.query.length > 0) return 'modified';
  return sameTriageSavedViewLensV1(input.selected, input.lens) ? 'saved' : 'modified';
}
