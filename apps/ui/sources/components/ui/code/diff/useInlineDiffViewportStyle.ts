import type { ViewStyle } from 'react-native';

import { useInlineDiffSharesEnclosingScroller } from './inlineDiffScrollOwner';
import { resolveInlineDiffVirtualizedViewportStyle } from './resolveInlineDiffVirtualizedViewportStyle';

/**
 * The capped viewport a large (virtualized) inline code diff draws, or none when the list it sits in is its one
 * vertical scroller and the diff windows its lines against that (QB-81). Every caller that caps a virtualized
 * `DiffViewer` asks here, so a diff and its frame never disagree about who scrolls.
 */
export function useInlineDiffViewportStyle(virtualized: boolean, maxHeight: number): ViewStyle | null {
    const sharesScroller = useInlineDiffSharesEnclosingScroller();
    return virtualized && !sharesScroller ? resolveInlineDiffVirtualizedViewportStyle(maxHeight) : null;
}
