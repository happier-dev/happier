import * as React from 'react';
import {
  Platform,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { HorizontalScrollEdgeMask } from './HorizontalScrollEdgeMask';
import { resolveHorizontalScrollEdgeMaskRamps, resolveHorizontalScrollEdgeMaskStyle } from './resolveScrollEdgeMaskStyle';
import { useScrollEdgeFades } from './useScrollEdgeFades';

export type HorizontalScrollEdgeMaskBinding = Readonly<{
  /** Replaces the scroller's own style: a wrapper that masks natively takes its place in the row. */
  scrollerStyle: StyleProp<ViewStyle>;
  wrapScroller: (scroller: React.ReactElement) => React.ReactElement;
  onScroll: (event: NativeSyntheticEvent<NativeScrollEvent>) => void;
  onViewportLayout: (event: LayoutChangeEvent) => void;
  onContentSizeChange: (width: number, height: number) => void;
}>;

const FADE_EDGES = { left: true, right: true } as const;

/**
 * A sideways-scrolling row's edge fade: the mask fades the row's own pixels at the edge that hides more, so a
 * cut-off item reads as more on every surface the row sits on (web: a CSS mask; native: `HorizontalScrollEdgeMask`).
 */
export function useHorizontalScrollEdgeMask(input: Readonly<{ fadePx: number; style?: StyleProp<ViewStyle> }>): HorizontalScrollEdgeMaskBinding {
  const { fadePx, style } = input;
  const fades = useScrollEdgeFades({ enabledEdges: FADE_EDGES, overflowThreshold: 4, edgeThreshold: 2 });
  const [nativeViewportWidth, setNativeViewportWidth] = React.useState(0);
  const webMask = React.useMemo(
    () => (Platform.OS === 'web' ? resolveHorizontalScrollEdgeMaskStyle(fades.visibility, { fadeSize: fadePx }) : null),
    [fades.visibility, fadePx],
  );
  const nativeRamps = React.useMemo(
    () => (Platform.OS === 'web' ? null : resolveHorizontalScrollEdgeMaskRamps(fades.visibility, { fadeSize: fadePx })),
    [fades.visibility, fadePx],
  );
  const { onScroll, onViewportLayout, onContentSizeChange } = fades;
  const handleViewportLayout = React.useCallback((event: LayoutChangeEvent) => {
    onViewportLayout(event);
    if (Platform.OS !== 'web') setNativeViewportWidth(event.nativeEvent.layout.width);
  }, [onViewportLayout]);
  const maskedNatively = Platform.OS !== 'web' && fades.canScrollX;
  return React.useMemo(() => ({
    scrollerStyle: maskedNatively ? null : [style, webMask],
    // Only an overflowing row has an edge to mask; the wrapper changes with overflow alone, never while scrolling.
    wrapScroller: (scroller: React.ReactElement) => (maskedNatively
      ? <HorizontalScrollEdgeMask ramps={nativeRamps} width={nativeViewportWidth} style={style}>{scroller}</HorizontalScrollEdgeMask>
      : scroller),
    onScroll,
    onViewportLayout: handleViewportLayout,
    onContentSizeChange,
  }), [handleViewportLayout, maskedNatively, nativeRamps, nativeViewportWidth, onContentSizeChange, onScroll, style, webMask]);
}
