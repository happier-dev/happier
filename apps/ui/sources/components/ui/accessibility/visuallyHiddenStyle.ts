import type { CSSProperties } from 'react';
import { Platform } from 'react-native';

const baseVisuallyHiddenStyle = {
    position: 'absolute',
    width: 1,
    height: 1,
    padding: 0,
    margin: -1,
    overflow: 'hidden',
    borderWidth: 0,
} as const;

const webClipStyle = {
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap',
} as const;

/**
 * Canonical screen-reader-only recipe: out of layout flow (no reserved space,
 * no flex `gap` participation), clipped to nothing so no glyph leaks, and kept at
 * its parent's static position so it never scrolls the page. Web adds the
 * standard `clip` + `nowrap` sr-only pair (native has no `clip`; the 1x1
 * overflow box already hides it there, and it stays opaque so TalkBack keeps
 * treating it as live content).
 */
export const visuallyHiddenStyle = Platform.OS === 'web'
    ? { ...baseVisuallyHiddenStyle, ...webClipStyle }
    : baseVisuallyHiddenStyle;

/** The same recipe for raw DOM elements (web-only portals and `.web.tsx` hosts). */
export const visuallyHiddenDomStyle: CSSProperties = { ...baseVisuallyHiddenStyle, ...webClipStyle };
