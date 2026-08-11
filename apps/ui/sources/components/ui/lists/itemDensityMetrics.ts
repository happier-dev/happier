import { Platform } from 'react-native';

import { ICON_SIZE } from '@/components/ui/icons/Icon';
import type { ResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';

function selectValue<T>(values: { ios?: T; default: T }): T {
    if (typeof Platform.select === 'function') {
        return Platform.select(values) ?? values.default;
    }
    return Platform.OS === 'ios' && values.ios !== undefined ? values.ios : values.default;
}

export const ITEM_TITLE_TEXT_METRICS: Record<ResolvedItemDensity, Readonly<{
    fontSize: number;
    lineHeight: number;
    letterSpacing: number;
}>> = {
    comfortable: {
        fontSize: selectValue({ ios: 17, default: 16 }),
        lineHeight: selectValue({ ios: 22, default: 24 }),
        letterSpacing: selectValue({ ios: -0.41, default: 0.15 }),
    },
    cozy: {
        fontSize: selectValue({ ios: 15, default: 14 }),
        lineHeight: selectValue({ ios: 20, default: 20 }),
        letterSpacing: selectValue({ ios: -0.3, default: 0.12 }),
    },
    compact: {
        fontSize: selectValue({ ios: 14, default: 13 }),
        lineHeight: selectValue({ ios: 18, default: 18 }),
        letterSpacing: selectValue({ ios: -0.24, default: 0.1 }),
    },
    tight: {
        fontSize: selectValue({ ios: 12, default: 12 }),
        lineHeight: selectValue({ ios: 18, default: 16 }),
        letterSpacing: selectValue({ ios: -0.24, default: 0.1 }),
    },
};

export const ITEM_SUBTITLE_TEXT_METRICS: Record<ResolvedItemDensity, Readonly<{
    fontSize: number;
    lineHeight: number;
    letterSpacing: number;
}>> = {
    comfortable: {
        fontSize: selectValue({ ios: 15, default: 14 }),
        lineHeight: 20,
        letterSpacing: selectValue({ ios: -0.24, default: 0.1 }),
    },
    cozy: {
        fontSize: selectValue({ ios: 13, default: 12 }),
        lineHeight: 18,
        letterSpacing: selectValue({ ios: -0.24, default: 0.1 }),
    },
    compact: {
        fontSize: selectValue({ ios: 13, default: 12 }),
        lineHeight: 16,
        letterSpacing: selectValue({ ios: -0.24, default: 0.1 }),
    },
    tight: {
        fontSize: selectValue({ ios: 11, default: 11 }),
        lineHeight: 14,
        letterSpacing: selectValue({ ios: -0.24, default: 0.1 }),
    },
};

/**
 * The horizontal padding an item row reserves inside its own bounds, per density.
 *
 * Exported because a host that embeds rows inside an already-padded container (a transcript tool
 * card, a popover panel) has to cancel it with a negative margin, or every row's leading glyph sits
 * indented from the header above it. The alternative — each host hardcoding `-12` — is how one of
 * these two numbers eventually stops matching the other.
 */
export const ITEM_ROW_PADDING_HORIZONTAL: Record<ResolvedItemDensity, number> = {
    comfortable: 16,
    cozy: 14,
    compact: 12,
    tight: 10,
};

export const ITEM_ICON_BOX_SIZE: Record<ResolvedItemDensity, number> = {
    comfortable: selectValue({ ios: 32, default: 32 }),
    cozy: selectValue({ ios: 22, default: 24 }),
    compact: selectValue({ ios: 18, default: 20 }),
    tight: selectValue({ ios: 18, default: 18 }),
};


/**
 * The glyph size for an item row and for every menu row that shares this scale.
 *
 * On the shared icon scale, one step per density. This was briefly derived from the row's own type
 * metrics — cap height of the title down to the baseline of the subtitle — which is defensible on
 * paper and looked wrong: the icons read as oversized badges beside their text, and because iOS and
 * web use different line heights the two platforms diverged, so native dropdowns came out visibly
 * bigger than the web ones. A scale step is coarser and better here, and it is the same number
 * everywhere.
 */
export const ITEM_ICON_GLYPH_SIZE: Record<ResolvedItemDensity, number> = {
    comfortable: ICON_SIZE.xl,
    cozy: ICON_SIZE.lg,
    compact: ICON_SIZE.md,
    tight: ICON_SIZE.sm,
};

/**
 * Everything that sizes a MENU row — a dropdown, a picker, an action list.
 *
 * Flat, and that is the point. Menu rows and settings rows share `Item`/`SelectableRow`, so a menu
 * row used to inherit the whole item scale: at the default density a 20px glyph in a 24px box on a
 * 44px row, while the menu rows that happened to render through `SelectableRow` sat at 16 on 36. One
 * concept, two sizes, chosen by which component the call site reached for.
 *
 * Density is a LIST setting — how much of a settings screen or a file tree fits on screen. A menu is
 * transient and self-contained: nothing about a user preferring dense file trees says their dropdowns
 * should be 8px taller. Letting the preference through gave one menu four possible heights decided
 * somewhere else entirely, which is why these numbers are constants and not another table.
 *
 * The values are the canonical menu row's, the one `SelectableRow` has always drawn: a 16px glyph, a
 * 12px gap, and 8px above and below a 20px line — 36px in total.
 */
export const MENU_ROW_METRICS = {
    iconGlyphSizePx: ICON_SIZE.sm,
    /** No reserved box beyond the glyph: a menu row has one column of icons, all the same size. */
    iconBoxSizePx: ICON_SIZE.sm,
    iconMarginRightPx: 12,
    minHeightPx: 36,
    paddingVerticalPx: 8,
} as const;

export const ITEM_ICON_MARGIN_RIGHT: Record<ResolvedItemDensity, number> = {
    comfortable: 12,
    cozy: 14,
    compact: 10,
    tight: 8,
};

export const ITEM_CHEVRON_SIZE: Record<ResolvedItemDensity, number> = {
    comfortable: 18,
    cozy: 17,
    compact: 15,
    tight: 14,
};
