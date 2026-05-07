import type { ViewStyle } from 'react-native';

import type { ScrollEdgeVisibility } from './useScrollEdgeFades';

type WebMaskStyle = ViewStyle & Readonly<{
    maskImage: string;
    WebkitMaskImage: string;
}>;

type ResolveVerticalScrollEdgeMaskStyleOptions = Readonly<{
    fadeSize?: number;
}>;

const DEFAULT_VERTICAL_SCROLL_EDGE_MASK_SIZE = 18;

export function resolveVerticalScrollEdgeMaskStyle(
    visibility: ScrollEdgeVisibility,
    options: ResolveVerticalScrollEdgeMaskStyleOptions = {},
): WebMaskStyle | null {
    if (!visibility.top && !visibility.bottom) {
        return null;
    }

    const fadeSize = Math.max(0, options.fadeSize ?? DEFAULT_VERTICAL_SCROLL_EDGE_MASK_SIZE);
    const topStart = visibility.top ? 'transparent 0px' : 'black 0px';
    const topEnd = visibility.top ? `black ${fadeSize}px` : 'black 0px';
    const bottomStart = visibility.bottom ? `black calc(100% - ${fadeSize}px)` : 'black 100%';
    const bottomEnd = visibility.bottom ? 'transparent 100%' : 'black 100%';
    const maskImage = `linear-gradient(to bottom, ${topStart}, ${topEnd}, ${bottomStart}, ${bottomEnd})`;

    return {
        maskImage,
        WebkitMaskImage: maskImage,
    };
}
