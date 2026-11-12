import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';

import { ICON_SIZE } from '@/components/ui/icons/Icon';
import { COMPACT_SEARCH_FIELD_CLOSE_BUTTON_SIZE_PX } from '@/components/ui/forms/CompactSearchField';
import type { HeaderControlMetrics } from '@/components/ui/icons/iconButtonGlyphSize';

/** The Sessions header and group rhythm, shared by its paint and column width budget. */
export const SESSION_LIST_COLUMN_METRICS = Object.freeze({
    titleRowHeightPx: HAPPIER_COLLECTION_LIST_METRICS.titleRowHeight,
    iconButtonSizePx: 30,
    iconButtonGapPx: HAPPIER_COLLECTION_LIST_METRICS.headerActionGap,
    /** The narrowest the list title gets before the Projects/Recent segment yields (the shared column floor). */
    titleFloorPx: HAPPIER_COLLECTION_LIST_METRICS.titleFloor,
    fieldCloseButtonSizePx: COMPACT_SEARCH_FIELD_CLOSE_BUTTON_SIZE_PX,
    fieldGapPx: HAPPIER_COLLECTION_LIST_METRICS.headerGap,
    groupLabelPaddingTopPx: HAPPIER_COLLECTION_LIST_METRICS.groupLabelPaddingTop,
    groupLabelPaddingBottomPx: HAPPIER_COLLECTION_LIST_METRICS.groupLabelPaddingBottom,
});

/** The header's controls under a precise pointer (Search, ⋯): the touch size comes from `useHeaderControlMetrics`. */
export const SESSION_LIST_HEADER_CONTROL: HeaderControlMetrics = Object.freeze({
    sizePx: SESSION_LIST_COLUMN_METRICS.iconButtonSizePx,
    glyphPx: ICON_SIZE.sm,
});
