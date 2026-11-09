import { Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
    ITEM_GROUP_CONTAINER_HORIZONTAL_PADDING_PX,
} from '@/components/ui/lists/itemGroupSpacing';
import { Typography } from '@/constants/Typography';
import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';
import { SESSION_LIST_COLUMN_METRICS } from './sessionListColumnMetrics';
export { SESSION_LIST_COLUMN_METRICS } from './sessionListColumnMetrics';

/**
 * The Sessions column's header and section rhythm, measured from the approved lab
 * (`.happier/design-lab/app-surfaces/sidebar-lab.css`, `.z-S1` inside `xrail-R1`): the title row
 * (`.z-ttl`) is 36 tall with 30px icon buttons (`.z-ib`) 2 apart; a group label (`.z-h`) sits 14 below
 * what precedes it and 6 above its sheet. One owner for the list's header, the Drafts group and every
 * project group, so the rhythm cannot drift between them.
 */
/** The column's text edge: the list title and every group label start here (the shared column frame). */
const SESSION_LIST_TEXT_INSET_PX = HAPPIER_COLLECTION_LIST_METRICS.contentInset;
/** The column's sheet edge: session rows, the Drafts sheet and the Browse row start here (the shared gutter). */
export const SESSION_LIST_SHEET_INSET_PX = HAPPIER_COLLECTION_LIST_METRICS.rowInset;
/**
 * The title row's trailing inset: the icon buttons' squares end just inside the sheet edge, so their
 * glyphs sit on the rows' trailing text edge (lab: glyph right edge on `R = W - 22`).
 */
const SESSION_LIST_HEADER_PADDING_RIGHT_PX = SESSION_LIST_SHEET_INSET_PX + 4;
/** The search field spans the sheets' width: outset from the header's text inset back to the sheet edge. */
const SESSION_LIST_FIELD_OUTSET_LEFT_PX = SESSION_LIST_SHEET_INSET_PX - SESSION_LIST_TEXT_INSET_PX;
const SESSION_LIST_FIELD_OUTSET_RIGHT_PX = SESSION_LIST_SHEET_INSET_PX - SESSION_LIST_HEADER_PADDING_RIGHT_PX;

/**
 * The list paints no plane of its own: it lies transparent over its host, which owns one background
 * (the app shell's column, the phone's main screen, a page's paper), so a column never shows two
 * colours. Only chips and marks inside rows paint.
 */
export const sessionListStyles = StyleSheet.create((theme) => ({
    container: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'center',
        alignItems: 'stretch',
    },
    // `maxWidth` is composed at render time from `useLayoutMaxWidthStyle()`: this
    // factory evaluates once, so baking the content-width preference in here would
    // freeze it until the app reloads.
    contentContainer: {
        flex: 1,
    },
    listHeaderSection: {
    },
    groupHeaderSection: {
        paddingHorizontal: SESSION_LIST_TEXT_INSET_PX,
        paddingTop: SESSION_LIST_COLUMN_METRICS.groupLabelPaddingTopPx,
        paddingBottom: SESSION_LIST_COLUMN_METRICS.groupLabelPaddingBottomPx,
    },
    /**
     * An `ItemGroup` sheet in the column (Drafts, the Browse row) on the column's sheet edge: the group's own
     * container padding plus this margin land it where the session sheets start.
     */
    groupSheetInset: {
        marginHorizontal: SESSION_LIST_SHEET_INSET_PX - (Platform.select(ITEM_GROUP_CONTAINER_HORIZONTAL_PADDING_PX) ?? 0),
    },
    groupHeaderSubtitle: {
        ...Typography.variant('micro'),
        color: theme.colors.text.secondary,
        marginTop: theme.space.s2,
    },
    groupHeaderFavicon: {
        width: 16,
        height: 16,
        borderRadius: 4,
    },
    // A coloured project's dot sits on its mark's corner, so titles keep one edge across groups.
    groupHeaderMarkFrame: {
        position: 'relative' as const,
    },
    groupHeaderColorDot: {
        position: 'absolute' as const,
        right: -3,
        bottom: -2,
        width: 8,
        height: 8,
        borderRadius: 4,
        // The ink hairline keeps pale customs visible and separates the dot from the mark under it.
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    groupHeaderFaviconFrame: {
        width: 16,
        minWidth: 16,
        maxWidth: 16,
        height: 16,
        minHeight: 16,
        maxHeight: 16,
        flexShrink: 0,
        borderRadius: 4,
        overflow: 'hidden' as const,
    },
    /**
     * A section's quiet line at the rows' title edge (calm ruling 2026-11-01): an empty section's "Drag sessions
     * here", or the members this view does not draw (another space, archived). No outline at rest.
     */
    sectionQuietHint: {
        minHeight: HAPPIER_COLLECTION_LIST_METRICS.rowMinHeight,
        justifyContent: 'center' as const,
        paddingLeft: HAPPIER_COLLECTION_LIST_METRICS.contentInset
            + HAPPIER_COLLECTION_LIST_METRICS.rowGlyphBox + HAPPIER_COLLECTION_LIST_METRICS.rowGlyphGap,
        paddingRight: theme.space.s10,
    },
    sectionDropHintText: {
        color: theme.colors.text.tertiary,
    },
    groupHeaderActionButton: {
        width: 18,
        height: 14,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        borderRadius: 999,
        marginLeft: theme.space.s4,
    },
    headerRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        justifyContent: 'space-between' as const,
    },
    headerLabelRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: theme.space.s4,
        flex: 1,
        minWidth: 0,
    },
    searchChrome: {
        paddingLeft: SESSION_LIST_TEXT_INSET_PX,
        paddingRight: SESSION_LIST_HEADER_PADDING_RIGHT_PX,
        paddingTop: theme.space.s8,
    },
    searchChromeControlsRow: {
        minHeight: SESSION_LIST_COLUMN_METRICS.titleRowHeightPx,
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        justifyContent: 'flex-end' as const,
        gap: SESSION_LIST_COLUMN_METRICS.iconButtonGapPx,
    },
    /**
     * The shared `CompactSearchField` on its own row under the title. Its
     * edges line up with the sheets below, not with the title text.
     */
    searchChromeField: {
        marginTop: SESSION_LIST_COLUMN_METRICS.fieldGapPx,
        marginLeft: SESSION_LIST_FIELD_OUTSET_LEFT_PX,
        marginRight: SESSION_LIST_FIELD_OUTSET_RIGHT_PX,
        flexGrow: 1,
        flexShrink: 1,
    },
    /** A View menu row's current value and its submenu chevron (lab `clfilter:view`: values trail). */
    viewMenuValue: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: theme.space.s4,
    },
    viewMenuValueText: {
        color: theme.colors.text.tertiary,
        ...Typography.variant('meta'),
    },
    /** The list title (its scope menu) takes the row's leading edge; the search and view controls trail. */
    searchChromeTitleSlot: {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 0,
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        justifyContent: 'flex-start' as const,
    },
    /** The Projects/Recent segment hugs its two glyphs beside Find and View (lab `clviews`). */
    layoutSegment: {
        flexShrink: 0,
    },
    searchChromeStatusRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: theme.space.s8,
        minHeight: 28,
    },
    // On a phone tab the spaces strip takes its own line under the title.
    searchChromePhoneControls: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: theme.space.s4,
        paddingTop: theme.space.s8,
    },
    searchChromePhoneStrip: {
        flex: 1,
        minWidth: 0,
    },
    searchChromeChipRow: {
        flexDirection: 'row' as const,
        flexWrap: 'wrap' as const,
        alignItems: 'center' as const,
        gap: theme.space.s8,
        paddingTop: theme.space.s2,
        paddingBottom: theme.space.s4,
    },
    searchChromeScopeRow: {
        minHeight: 24,
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: theme.space.s6,
    },
    searchChromeScopeText: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text.tertiary,
        ...Typography.default(),
    },
    // The quiet meta line under the list's controls (its filter summary, a search's status): the row-meta role.
    searchChromeStatusText: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text.tertiary,
        ...Typography.variant('meta'),
    },
    searchChromeStatusRetry: {
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        paddingHorizontal: theme.space.s8,
    },
    searchChromeStatusRetryText: {
        color: theme.colors.accent.blue,
        ...Typography.default('semiBold'),
    },
    // Reset sits on that meta line as a quiet control in ink; blue is for links and focus.
    searchChromeStatusActionText: {
        color: theme.colors.text.secondary,
        ...Typography.variant('meta', 'semiBold'),
    },
    /** The Runs-only list has no title: its summary line, search and Reset share one compact row. */
    searchChromeSummaryRow: {
        minHeight: SESSION_LIST_COLUMN_METRICS.iconButtonSizePx,
    },
    searchChromeEscalationRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: theme.space.s6,
        paddingVertical: theme.space.s8,
    },
    searchChromeEscalationText: {
        flex: 1,
        minWidth: 0,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    headerSearchTrailingAccessory: {
        width: 18,
        minWidth: 18,
        height: 20,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
    },
}));
