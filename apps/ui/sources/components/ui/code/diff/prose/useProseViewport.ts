import * as React from 'react';
import { useWindowDimensions, type ViewStyle } from 'react-native';

import { resolveInlineDiffVirtualization } from '../resolveInlineDiffVirtualization';
import { resolveInlineDiffVirtualizedMaxHeight } from '../resolveInlineDiffVirtualizedMaxHeight';
import { resolveInlineDiffVirtualizedViewportStyle } from '../resolveInlineDiffVirtualizedViewportStyle';
import { useInlineDiffVirtualizationThresholds } from '../useInlineDiffVirtualizationThresholds';

/**
 * The prose face's use of the inline diff virtualization policy (the one `ToolDiffView` applies to code):
 * rows that outgrow the line/byte thresholds are read inside the bounded viewport, smaller ones are in flow.
 * The decision is made on the rows actually shown, so a small edit in a long document stays in flow.
 */
export function useProseViewport(rows: readonly Readonly<{ text: string }>[]): ViewStyle | null {
  const { lineThreshold, byteThreshold } = useInlineDiffVirtualizationThresholds();
  const { height: windowHeight } = useWindowDimensions();
  const virtualized = React.useMemo(
    () =>
      resolveInlineDiffVirtualization({
        unifiedDiff: rows.map((row) => row.text).join('\n'),
        oldText: null,
        newText: null,
        lineThreshold,
        byteThreshold,
      }),
    [byteThreshold, lineThreshold, rows],
  );
  return virtualized
    ? resolveInlineDiffVirtualizedViewportStyle(resolveInlineDiffVirtualizedMaxHeight(windowHeight))
    : null;
}
