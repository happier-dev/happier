import type { ViewStyle } from 'react-native';

export function resolvePopoverHeightStyle(maxHeight: number | undefined): ViewStyle | null {
    if (maxHeight === undefined) return null;
    return { maxHeight };
}

/**
 * The height a left/right popover may take. A start-aligned one (a submenu beside its row) opens at its
 * anchor and runs down to the boundary's foot, so it stays beside the row it came from and scrolls
 * inside; only when the anchor sits too low to leave the room the popover usually needs
 * (`preferredMinHeight`) may it use the whole boundary and move up. Centred and end-aligned side
 * popovers keep the whole boundary.
 */
export function resolvePopoverSideMaxHeight(input: Readonly<{
    anchorY: number;
    anchorAlignVertical: 'start' | 'center' | 'end';
    boundaryY: number;
    boundaryHeight: number;
    gap: number;
    preferredMinHeight: number;
}>): number {
    const wholeBoundary = input.boundaryHeight - input.gap * 2;
    if (input.anchorAlignVertical !== 'start') return wholeBoundary;
    const roomFromAnchor = input.boundaryY + input.boundaryHeight - input.anchorY - input.gap;
    return roomFromAnchor >= input.preferredMinHeight ? roomFromAnchor : wholeBoundary;
}
