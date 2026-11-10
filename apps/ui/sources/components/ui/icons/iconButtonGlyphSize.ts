import { Platform } from 'react-native';
import { useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';
import { HAPPIER_PAGE_METRICS } from '@happier-dev/plugin-ui/presentation';

import { ICON_SIZE } from '@/components/ui/icons/Icon';

/**
 * The glyph an icon-only button of `size` px draws: the largest step of {@link ICON_SIZE} that leaves at
 * least 4 px on each side (the default 28 px button draws `md`, like the plugin-ui IconButton beside it).
 * Very small and very large buttons keep the older proportional glyph, which no scale step fits.
 */
export function resolveIconButtonGlyphSize(size: number): number {
    if (size > 36) return size - 10;
    const fitted = [ICON_SIZE.lg, ICON_SIZE.md, ICON_SIZE.sm, ICON_SIZE.xs].find((step) => step <= size - 8);
    return fitted ?? Math.max(12, size - 10);
}

export type HeaderControlMetrics = Readonly<{ sizePx: number; glyphPx: number }>;

const TOUCH_HEADER_CONTROL: HeaderControlMetrics = Object.freeze({
    sizePx: HAPPIER_PAGE_METRICS.controlHeightPx,
    glyphPx: ICON_SIZE.lg,
});

/**
 * A list header's one control size (its icon buttons and its icon-only segmented choice): what the header draws
 * under a precise pointer, and on a finger one drawn box (the control height) with `lg` glyphs, whose hit area
 * reaches 44 invisibly (phone-system lab D1; owner 11-10: the segment matches the buttons). The touch decision is
 * the shared pointer owner's.
 */
export function useHeaderControlMetrics(pointer: HeaderControlMetrics): HeaderControlMetrics {
    return useHappierTouchPrimaryPointer(Platform.OS) ? TOUCH_HEADER_CONTROL : pointer;
}
