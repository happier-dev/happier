import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { HappierHitReach } from '@happier-dev/plugin-ui/environment';

import { Typography } from '@/constants/Typography';

/** The strip's line: its instruments draw a 16 px glyph line centred in it. */
export const INSTRUMENT_STRIP_LINE_HEIGHT_PX = 28;
const INSTRUMENT_GLYPH_LINE_PX = 16;

/**
 * An instrument's hit area: half the cluster gap (`instrumentSpaced`) toward each neighbour, and above and below only the strip
 * line's own free band. Above the line is the transcript (a queued row's actions), below it the composer, so a
 * finger there belongs to them, not to the gauge or the quota ring.
 */
export function useInstrumentStripHitReach(): HappierHitReach {
    const { theme } = useUnistyles();
    const sideways = theme.space.s10 / 2;
    return React.useMemo(() => {
        const band = (INSTRUMENT_STRIP_LINE_HEIGHT_PX - INSTRUMENT_GLYPH_LINE_PX) / 2;
        return { left: sideways, right: sideways, top: band, bottom: band };
    }, [sideways]);
}

/**
 * Layout for the session instrument strip. One 28-high row: connection/working
 * status pinned left, a flexible spacer, then the right-aligned instrument
 * cluster (context gauge · quota ring · git ± · extension badges · permission)
 * and the host's trailing actions. When they do not fit on one line (a phone),
 * the row wraps instead of running past the edge: whatever no longer fits moves
 * to its own right-aligned line, so a status badge keeps its row whole.
 */
export const instrumentStripStyles = StyleSheet.create((theme) => ({
    root: {
        minHeight: INSTRUMENT_STRIP_LINE_HEIGHT_PX,
        flexDirection: 'row',
        flexWrap: 'wrap',
        justifyContent: 'flex-end',
        alignItems: 'center',
        rowGap: theme.space.s6,
        // The line starts on the card's content edge (0.2): its dot sits over the field's first
        // letter and the chips' first glyph, and the right cluster ends where the card's content does.
        paddingHorizontal: theme.space.s20,
    },
    rootCollapsed: {
        minHeight: 0,
    },
    // The status line takes the room the instruments leave and gives way first (owner 2026-11-10): from a zero
    // basis it can never push the trailing gauge onto a row of its own, so the strip stays one line on a phone.
    connectionGroup: {
        flexDirection: 'row',
        alignItems: 'center',
        flexGrow: 1,
        flexShrink: 1,
        flexBasis: 0,
        minWidth: 0,
        gap: theme.space.s6,
    },
    connectionDot: {
        marginRight: 0,
    },
    connectionText: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        flexShrink: 1,
        minWidth: 0,
    },
    /** The sentence of a line whose action is a name: the sentence keeps its width and the name gives way. */
    connectionTextKept: {
        flexShrink: 0,
    },
    /** A name-labelled action shrinks (its text ellipsizes) before the sentence does. */
    connectionActionHost: {
        flexShrink: 1,
        minWidth: 0,
    },
    /** The tooltip host around a line that carries a detail: it shrinks like the text it wraps. */
    connectionTextHost: {
        flexShrink: 1,
        minWidth: 0,
    },
    /** The guard's countdown inside the line: its own ink weight, tabular so the digits never shift. */
    connectionCountdown: {
        ...Typography.variant('meta', 'semiBold'),
        fontVariant: ['tabular-nums'],
    },
    spacer: {
        flexGrow: 1,
        flexShrink: 1,
        minWidth: 8,
    },
    /** Beside a status line the line itself takes the free room; a growing spacer would split it and crush the line. */
    spacerBesideLine: {
        flexGrow: 0,
    },
    cluster: {
        flexDirection: 'row',
        alignItems: 'center',
        // Only shrinks when it is alone on a line narrower than itself; a long badge then wraps its words.
        flexShrink: 1,
        minWidth: 0,
    },
    /**
     * The cluster's rhythm, carried by each instrument that has content rather than by a container gap: a plugin
     * region with nothing to show (a Session with no pull request) takes no gap, so the last visible instrument
     * ends on the composer's content edge (owner 2026-11-11).
     */
    instrumentSpaced: {
        marginLeft: theme.space.s10,
    },
    trailingActions: {
        flexDirection: 'row',
        alignItems: 'center',
        flexShrink: 0,
        marginLeft: theme.space.s10,
        // The host's actions (Look, the composer's close) are drawn apart by the strip's rhythm, so their
        // hit areas split a real gap instead of meeting at none.
        gap: theme.space.s10,
    },
    /** An instrument's entrance wrapper shrinks with the cluster, so a long badge label wraps or ellipsizes inside the row. */
    instrumentEntrance: {
        flexShrink: 1,
        minWidth: 0,
    },
    /**
     * Plain values, quiet notes and plugin items give way first. Flex shortfall is shared by
     * shrink factor times width; a factor this far above `instrumentEntrance` leaves a prominent
     * badge or gauge less than a hundredth of a pixel while any of these can still shrink, and
     * (unlike a fractional factor, which a browser caps) they share it fully once these reach zero.
     */
    instrumentEntranceYielding: {
        flexShrink: 10000,
        minWidth: 0,
    },
    instrumentSlot: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    /** The opt-in name beside a gauge ("Context", "5-hour"): smaller than the values. */
    instrumentLabelText: {
        ...Typography.variant('micro', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    instrumentValueText: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
    permissionChip: {
        flexShrink: 0,
    },
    permissionText: {
        fontSize: 12,
        fontVariant: ['tabular-nums'],
    },
    overflowChip: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 20,
        minWidth: 28,
        paddingHorizontal: theme.space.s6,
        borderRadius: 999,
    },
    overflowChipText: {
        fontSize: 13,
        lineHeight: 13,
        color: theme.colors.text.secondary,
    },
    overflowPopover: {
        paddingHorizontal: theme.space.s16,
        paddingVertical: 14,
        gap: 14,
        minWidth: 220,
    },
    overflowPopoverRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
    },
    overflowPopoverRowLabel: {
        fontSize: 13,
        color: theme.colors.text.primary,
        flexShrink: 1,
    },
}));
