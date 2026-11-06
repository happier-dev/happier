import * as React from 'react';
import { View } from 'react-native';
import type { HappierUiTheme } from '../../environment/types.js';
import { HappierSkeletonRows } from '../feedback/Skeleton.js';
import { HAPPIER_PAGE_METRICS } from './pageMetrics.js';

export type HappierPageLoadingRowsProps = Readonly<{
  testID: string;
  loadingLabel: string;
  theme: HappierUiTheme;
  header?: React.ReactNode;
  color?: string;
  reducedMotion?: boolean;
  columnMaxWidthPx?: number;
  /** The host's existing column frame; it binds width and column context only. */
  renderFrame?: (input: Readonly<{ testID: string; children: React.ReactNode }>) => React.ReactNode;
}>;

/** Hold a page's column and known row shape while its content is loading. */
export const HappierPageLoadingRows = React.memo(function HappierPageLoadingRows(props: HappierPageLoadingRowsProps) {
  const rows = <View style={{ paddingHorizontal: HAPPIER_PAGE_METRICS.pageTextInsetPx - props.theme.spacing.medium }}>
    <HappierSkeletonRows testID={`${props.testID}-skeleton`} rows={4} theme={props.theme}
      color={props.color} reducedMotion={props.reducedMotion} />
  </View>;
  const frame = { testID: `${props.testID}-rows`, children: rows };
  return <View testID={props.testID} style={{ flex: 1 }} accessible role="status"
    accessibilityLabel={props.loadingLabel} accessibilityLiveRegion="polite">
    {props.header}
    {props.renderFrame ? props.renderFrame(frame) : <View {...frame}
      style={{ width: '100%', alignSelf: 'center', maxWidth: props.columnMaxWidthPx }} />}
  </View>;
});
