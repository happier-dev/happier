/**
 * Constants for the SelectionList primitive. These are domain-AGNOSTIC; any
 * domain-specific threshold (e.g. worktree staleness) must live in the owning
 * domain's `_constants.ts` (per Decisions Log "Stale-threshold ownership").
 */

/** Default debounce window for dynamic sections (Phase 2). Listed here for
 * cross-file visibility; consumed by `useSelectionListDynamicSections`. */
export const SELECTION_LIST_DEFAULT_DYNAMIC_DEBOUNCE_MS = 120;

/** Default skeleton row count while a dynamic section loads (Phase 2). */
export const SELECTION_LIST_DEFAULT_LOADING_SKELETON_ROWS = 3;

/**
 * Above this row count per section, `SelectionListVirtualizedSection` switches
 * to FlashList (via the repo `flashListCompat` wrapper). Below it, sections
 * render as plain mapped `Item` rows under `ItemGroup` for simplicity.
 *
 * Verified via Phase 0.5 audit: `ItemList` is `ScrollView`-based and renders
 * all children up-front, so > 50 rows per section becomes a real perf concern
 * for path browse + branch lists.
 */
export const SELECTION_LIST_VIRTUALIZATION_THRESHOLD = 50;

/** Estimated row height passed to FlashList for the virtualized path. */
export const SELECTION_LIST_VIRTUALIZED_ROW_ESTIMATED_HEIGHT_PX = 56;

/**
 * Comfort margin for keyboard-driven scroll-into-view in non-virtualized
 * selection lists. Roughly half of a compact row keeps the active option from
 * grazing the popover edge without recentering the list on every arrow move.
 */
export const SELECTION_LIST_KEYBOARD_SCROLL_MARGIN_PX = 32;

/**
 * R13 (Fix 5): the fixed outer height a single `SelectionListSkeletonRow`
 * reserves while a dynamic section is loading. MUST match the comfortable-
 * density Item row geometry the resolver will eventually paint, so the
 * loading→ready transition does not shift the popover layout.
 *
 * Aligned with `SELECTION_LIST_VIRTUALIZED_ROW_ESTIMATED_HEIGHT_PX` (56) so
 * non-virtualized and virtualized loading rows share the same vertical
 * footprint.
 */
export const SELECTION_LIST_SKELETON_ROW_HEIGHT_PX = 56;

/** Default testID prefix used by SelectionList sub-components. */
export const SELECTION_LIST_DEFAULT_TEST_ID = 'selection-list';
