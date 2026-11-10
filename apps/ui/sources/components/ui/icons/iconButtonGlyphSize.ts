import { Platform } from 'react-native';
import { useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';

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

/**
 * A header action's glyph (a list's Search and ⋯, a column's search toggle): the size its header draws under a
 * precise pointer, and `lg` where the primary pointer is a finger, whose hit area is already 44 (phone-system
 * lab D1). The touch decision is the shared pointer owner's.
 */
export function useHeaderActionGlyphSize(pointerPx: number): number {
    return useHappierTouchPrimaryPointer(Platform.OS) ? ICON_SIZE.lg : pointerPx;
}
