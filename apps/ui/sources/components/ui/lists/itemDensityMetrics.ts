import { Platform } from 'react-native';
import { HAPPIER_COLLECTION_LIST_METRICS, resolveHappierTypeScale } from '@happier-dev/plugin-ui/presentation';

import { ICON_SIZE } from '@/components/ui/icons/Icon';
export { HAPPIER_MENU_ROW_METRICS as MENU_ROW_METRICS, HAPPIER_MENU_ROW_SHAPE as MENU_ROW_SHAPE, HAPPIER_MENU_ROW_TRAILING as MENU_ROW_TRAILING } from '@happier-dev/plugin-ui/presentation';
import type { ResolvedItemDensity } from '@/components/ui/lists/useResolvedItemDensity';

function selectValue<T>(values: { ios?: T; default: T }): T {
    if (typeof Platform.select === 'function') {
        return Platform.select(values) ?? values.default;
    }
    return Platform.OS === 'ios' && values.ios !== undefined ? values.ios : values.default;
}

function roleMetrics(role: Parameters<typeof resolveHappierTypeScale>[0]) {
    const { weight: _weight, ...metrics } = resolveHappierTypeScale(role, Platform.OS);
    return metrics;
}

export const ITEM_TITLE_TEXT_METRICS = {
    comfortable: roleMetrics('heading'),
    cozy: roleMetrics('label'),
    compact: roleMetrics('body'),
    tight: roleMetrics('meta'),
} satisfies Record<ResolvedItemDensity, ReturnType<typeof roleMetrics>>;

export const ITEM_SUBTITLE_TEXT_METRICS = {
    comfortable: roleMetrics('body'),
    cozy: roleMetrics('meta'),
    compact: roleMetrics('meta'),
    tight: roleMetrics('micro'),
} satisfies Record<ResolvedItemDensity, ReturnType<typeof roleMetrics>>;

/** Canonical horizontal inset for each Item density. */
export const ITEM_ROW_PADDING_HORIZONTAL: Record<ResolvedItemDensity, number> = {
    comfortable: 16,
    cozy: 14,
    compact: 12,
    tight: 10,
};

/**
 * A grouped row's vertical padding when it carries a subtitle. Content beside a group that must start
 * level with its first row's title (a preview caption) adds this to the group's own top inset.
 */
export const ITEM_ROW_WITH_SUBTITLE_PADDING_VERTICAL_PX: Record<ResolvedItemDensity, number> = {
    comfortable: selectValue({ ios: 11, default: 16 }),
    cozy: selectValue({ ios: 9, default: 10 }),
    compact: selectValue({ ios: 7, default: 6 }),
    tight: selectValue({ ios: 7, default: 2 }),
};

export const ITEM_ICON_BOX_SIZE: Record<ResolvedItemDensity, number> = {
    comfortable: selectValue({ ios: 32, default: 32 }),
    cozy: selectValue({ ios: 22, default: 24 }),
    // A compact row is a list column's row: its glyph column is the list's own.
    compact: HAPPIER_COLLECTION_LIST_METRICS.rowGlyphBox,
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

export const ITEM_ICON_MARGIN_RIGHT: Record<ResolvedItemDensity, number> = {
    comfortable: 12,
    cozy: 14,
    compact: HAPPIER_COLLECTION_LIST_METRICS.rowGlyphGap,
    tight: 8,
};

/**
 * Where a row's title starts, from the row's own leading edge: padding + icon box + gap. Content
 * that belongs to a row list but is not a row (a collapsed "2 others up to date" line, a progress
 * hairline) aligns to this, so it sits exactly on the titles' left edge.
 */
export function resolveItemTextColumnInset(density: ResolvedItemDensity, iconBoxSize: number = ITEM_ICON_BOX_SIZE[density]): number {
    return ITEM_ROW_PADDING_HORIZONTAL[density] + iconBoxSize + ITEM_ICON_MARGIN_RIGHT[density];
}

export const ITEM_CHEVRON_SIZE: Record<ResolvedItemDensity, number> = {
    comfortable: 18,
    cozy: 17,
    compact: 15,
    tight: 14,
};
