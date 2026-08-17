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
 * to the canonical virtualized-list owner. Below it, sections
 * render as plain mapped `Item` rows under `ItemGroup` for simplicity.
 *
 * Verified via Phase 0.5 audit: `ItemList` is `ScrollView`-based and renders
 * all children up-front, so > 50 rows per section becomes a real perf concern
 * for path browse + branch lists.
 */
export const SELECTION_LIST_VIRTUALIZATION_THRESHOLD = 50;

/** Estimated row height passed to the virtualized backend. */
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

/**
 * Inset from a card's own edge to its absolute trailing-accessory overlay
 * (`optionPresentation: 'card'`). Deliberately tighter than the row's text
 * inset: `Item` owns the text inset privately and it varies 10–16px with the
 * user's density setting, whereas the accessory is corner-anchored art.
 */
export const SELECTION_LIST_CARD_INSET_PX = 7;

/**
 * Edge length of one glyph box inside the card's accessory overlay (the
 * selection mark and the favourite toggle are both this wide).
 *
 * Doubles as the width the row RESERVES for the overlay: the overlay itself is
 * absolutely positioned and therefore invisible to layout, so without a
 * reservation a long title would run underneath it. Reserving through `Item`'s
 * own right slot — rather than a hand-computed `paddingRight` — is what keeps
 * the clearance correct at every density instead of only at the shipped one.
 */
export const SELECTION_LIST_CARD_ACCESSORY_BOX_PX = 20;

/** Vertical gap between stacked glyphs in the card's accessory overlay. */
export const SELECTION_LIST_CARD_ACCESSORY_GAP_PX = 6;

/**
 * Inset from a card's edge to its own text and icons
 * (`optionPresentation: 'card'`), applied over whichever inset the row's
 * density would otherwise paint.
 *
 * A card is not a list row. A list row's inset separates it from the pane it
 * spans, so it grows with the user's density preference; a card already has an
 * edge, and repeating that clearance inside it makes a grid of small cards read
 * as one padded slab. This is the value the predecessor's `optionCard` shipped
 * and it deliberately matches {@link SELECTION_LIST_CARD_INSET_PX}, so the
 * corner accessory and the text that clears it share one right edge.
 *
 * Only the inset is overridden — the row keeps its density's `minHeight`, so
 * the card can grow tighter around its text without the press target dropping
 * below the touch floor.
 */
export const SELECTION_LIST_CARD_CONTENT_INSET_PX = 7;

/**
 * Gutter between adjacent cards in a columned card grid, and the vertical gap
 * between stacked card rows.
 *
 * Cards need to be separated from each other rather than merely divided, which
 * is the whole difference between this grid and an `ItemGroup`: flush rows
 * there are separated by a divider, and a gap would break it. So these apply
 * ONLY under `optionPresentation: 'card'`; a `row` grid keeps
 * `ITEM_GROUP_COLUMN_GAP_PX` and no vertical gap at all.
 *
 * The horizontal gutter exists only where there are columns to separate; the
 * vertical gap does not depend on the column count at all, and applies to a
 * single stacked column — a phone, a narrow pane, an unmeasured first frame —
 * exactly as it does to a grid. `resolveSelectionListCardRowGapPx` owns that
 * rule for both the column wrapper and the lone card that is its own row.
 *
 * The vertical gap is the larger of the two on purpose. Horizontal neighbours
 * are already separated by two card edges plus their insets, whereas vertically
 * stacked cards meet edge to edge, so an equal gap would read as a tighter one.
 * Both values are the predecessor's (`cardsGrid` gap 4 / `cardsColumn` gap 8).
 */
export const SELECTION_LIST_CARD_COLUMN_GAP_PX = 4;
export const SELECTION_LIST_CARD_ROW_GAP_PX = 8;
