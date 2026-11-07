import * as React from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { useHappierTouchPrimaryPointer } from '@happier-dev/plugin-ui/environment';
import { resolveScmChangeCompactRowHeight } from '@/components/workspaces/scm/changes/ScmChangeRow';

// Existing comparison geometry, shared by every host rather than decided in each adapter.
const COMPARISON_RAIL_MIN_WIDTH_PX = 860;
const COMPARISON_STACKED_MAX_WIDTH_PX = 560;

/**
 * A comparison review's layout from its measured width: stacked (phone header, file control), a file rail
 * beside the stream, or the file list in the stream. Every review host reads it here.
 */
export function useScmComparisonLayout() {
  const [width, setWidth] = React.useState<number | null>(null);
  const [height, setHeight] = React.useState<number | null>(null);
  const touchPrimaryPointer = useHappierTouchPrimaryPointer(Platform.OS);
  const onLayout = React.useCallback(
    (event: { nativeEvent: { layout: { width: number; height?: number } } }) => {
      const next = Math.round(event.nativeEvent.layout.width);
      setWidth((previous) => (previous === next ? previous : next));
      const measuredHeight = event.nativeEvent.layout.height;
      if (typeof measuredHeight === 'number' && measuredHeight > 0) setHeight(measuredHeight);
    },
    [],
  );
  // Before the body is measured, a window narrower than the stacked bound already decides it: the body
  // can't be wider than its window, so a phone opens (and reopens after Retry) in its phone layout.
  const windowWidth = useWindowDimensions().width;
  // After it, the window still bounds the measure: a resize reaches the window before the body's own layout event, and
  // a body is never wider than its window, so a stale wide measure cannot keep the rail beside a phone.
  const knownWidth =
    width !== null
      ? windowWidth > 0
        ? Math.min(width, windowWidth)
        : width
      : windowWidth > 0 && windowWidth < COMPARISON_STACKED_MAX_WIDTH_PX
        ? windowWidth
        : null;
  const stacked =
    knownWidth !== null && knownWidth < COMPARISON_STACKED_MAX_WIDTH_PX;
  const rail =
    knownWidth !== null && knownWidth >= COMPARISON_RAIL_MIN_WIDTH_PX;
  return {
    onLayout,
    stacked,
    rail,
    // The measured presented review bounds the summaries needed for one page;
    // compact row geometry stays with the same owner the index uses.
    visibleFileRowCount: height === null ? null : Math.ceil(height / resolveScmChangeCompactRowHeight(touchPrimaryPointer)),
    indexPlacement: stacked
      ? ('phone' as const)
      : rail
        ? ('rail' as const)
        : ('stream' as const),
  };
}
