import { parseTriageSearchQuery } from '../../projection/entrySearch.js';
import type { SurfaceFilterSelectionV1 } from '../../projection/listWindow.js';

/**
 * The ONE answer to "is the reader's own lens hiding rows from them right now".
 *
 * Three surfaces act on that one fact and they must not be able to disagree
 * about it: the empty slot refuses to claim "every configured source answered,
 * and none of them has an entry for you" while a lens is narrowing
 * (`ui/shell/emptyState.ts`), the rail decides whether **Clear filters** has
 * anything to clear (`ui/filters/rail.tsx`), and the mounted page's published
 * context tells a reading agent that the entries it can see are a narrowed set
 * rather than the whole list (`ui/currentContext.ts`). Each of those used to
 * ask the question in its own words inside the shell component, which is how a
 * badge and an empty state end up stating opposite things about one list.
 *
 * **What counts as narrowing is exactly "would removing it bring rows back".**
 *
 * - A selected facet value counts. The five facets compose by conjunction and
 *   the window applies them before it publishes a row, so any selection can
 *   only ever remove rows.
 * - A query counts **only when the one search owner reads a term out of it**.
 *   Measuring `query.length` instead is the drift this module exists to
 *   prevent: `projection/entrySearch.ts#parseTriageSearchQuery` folds, trims and
 *   splits on whitespace, so a query of spaces alone yields no term and
 *   `triageEntryMatchesSearch` keeps every row. A shell that called that
 *   "filtered" told a reader with an untouched list that nothing matched their
 *   filters and pointed them at a rail with nothing selected — while the
 *   Composer picker, which asks the search owner, called the same query no
 *   query at all. One owner, one answer.
 * - **`order`, `grouping` and `smartPolicy` deliberately do NOT count**, and
 *   this is a stated choice rather than an omission. They rearrange the rows
 *   the window already published and can never remove one, so a reader looking
 *   at a reordered complete list is looking at a complete list. A surface that
 *   wants to say "you have customised this view" is asking a different question
 *   and must not borrow this answer for it.
 * - **No facet has a non-empty default.** `TRIAGE_LIST_NO_FILTERS_V1` is empty
 *   in all five, so nothing here is excluded from the predicate as "the default
 *   that does not count". Should a facet ever gain a non-empty default — a
 *   `states: ['open']` that hides Done until the reader asks for it, say — that
 *   default hides rows and must either count as narrowing or be excluded here
 *   in writing, because an undeclared exclusion is exactly the invisible filter
 *   this module exists to make visible.
 */
export type TriageLensNarrowingV1 = Readonly<{
  /** Any facet value is selected. **Clear filters** clears exactly these. */
  facets: boolean;
  /** The query carries at least one term the window actually matched on. */
  search: boolean;
  /** Either of the two: rows are being withheld by the reader's own lens. */
  narrowed: boolean;
}>;

/**
 * Whether any of the five facets carries a value.
 *
 * It takes the facet selection rather than the whole surface state so the route
 * owner, the reducer and the rail can all ask it about the selection they hold,
 * without one of them having to assemble a state object to ask a question about
 * five arrays.
 */
export function hasSelectedTriageFacetV1(filters: SurfaceFilterSelectionV1): boolean {
  return filters.sources.length > 0
    || filters.types.length > 0
    || filters.scopes.length > 0
    || filters.states.length > 0
    || filters.attention.length > 0;
}

/**
 * Read one lens's narrowing, split by cause.
 *
 * The two causes stay separate all the way to the reader because the honest
 * next action differs: a query that matches nothing is cleared from the search
 * box, and a facet that matches nothing is cleared from the rail. Collapsing
 * them into one boolean is what makes an empty list tell somebody to adjust a
 * filter they never set.
 */
export function readTriageLensNarrowingV1(lens: Readonly<{
  filters: SurfaceFilterSelectionV1;
  query: string;
}>): TriageLensNarrowingV1 {
  const facets = hasSelectedTriageFacetV1(lens.filters);
  const search = parseTriageSearchQuery(lens.query).length > 0;
  return Object.freeze({ facets, search, narrowed: facets || search });
}
