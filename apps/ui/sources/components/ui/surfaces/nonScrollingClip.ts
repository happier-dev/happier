import { Platform, type ViewStyle } from 'react-native';

/**
 * Clips content to its box without making the box a scroll container. On the web a `hidden` box can still
 * be scrolled, by focus or by `scrollIntoView`, when content reaches past it; the content then slides under
 * the box's edge and stays there. `clip` cannot scroll. Native clips with `hidden`, which never scrolls.
 * Owners: floating surfaces (a filter field focused inside a menu shifted its body, owner 11-15 A7) and the
 * desktop notch island (a focused control past the rest width carried the open panel off the island, Round 7).
 */
export function nonScrollingClipStyle(): ViewStyle {
    return (Platform.OS === 'web' ? { overflow: 'clip' } : { overflow: 'hidden' }) as ViewStyle;
}
