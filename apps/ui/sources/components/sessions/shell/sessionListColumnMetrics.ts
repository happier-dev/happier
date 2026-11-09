import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';

/** The Sessions header and group rhythm, shared by its paint and column width budget. */
export const SESSION_LIST_COLUMN_METRICS = Object.freeze({
    titleRowHeightPx: HAPPIER_COLLECTION_LIST_METRICS.titleRowHeight,
    iconButtonSizePx: 30,
    iconButtonGapPx: 2,
    /** The narrowest the list title gets before the Projects/Recent segment yields (the shared column floor). */
    titleFloorPx: HAPPIER_COLLECTION_LIST_METRICS.titleFloor,
    fieldCloseButtonSizePx: 20,
    fieldGapPx: 4,
    groupLabelPaddingTopPx: HAPPIER_COLLECTION_LIST_METRICS.groupLabelPaddingTop,
    groupLabelPaddingBottomPx: HAPPIER_COLLECTION_LIST_METRICS.groupLabelPaddingBottom,
});
