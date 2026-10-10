import { useMemo } from 'react';

import { useOptionalHappierUiLocalization, useOptionalHappierUiTypography } from '../../environment/context.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { resolveHappierTextStepStyle } from '../layout/pageText.js';
import type { HappierPortableStyle } from '../portableTypes.js';
import { resolveHappierTypeRoleStyle } from '../text/typeRole.js';

/** The data presentation's metrics (lab `dashboards` DP): one owner for every node. */
export const HAPPIER_DATA_METRICS = Object.freeze({
  /** The hero number of a metric. */
  metricValue: Object.freeze({ weight: 'bold' as const, fontSize: 30, lineHeight: 36, letterSpacing: -0.6 }),
  /** The one number a widget is about (a period's total), set larger and tighter. */
  heroValue: Object.freeze({ weight: 'bold' as const, fontSize: 44, lineHeight: 50, letterSpacing: -1.4 }),
  /** One of a row of labelled facts. */
  statValue: Object.freeze({ weight: 'semiBold' as const, fontSize: 22, lineHeight: 28, letterSpacing: -0.3 }),
  /** Space between a metric and a chart beneath it, and between stacked rows. */
  blockGapPx: 12,
  comparisonGapPx: 6,
  rowGapPx: 10,
  /** A proportion bar's track. */
  proportionHeightPx: 6,
  /** A table cell's vertical padding and the gap between its columns. */
  cellPaddingVerticalPx: 7,
  columnGapPx: 8,
  /** A text run's average advance, in ems, for sizing columns and axis labels before text lays out. */
  averageCharacterEm: 0.6,
  /** A chart's plot: bars sit on a hairline baseline with a 2 pt gap between them. */
  plotHeightPx: 64,
  barGapPx: 6,
  barRadiusPx: 3,
  /** A zero still reads as a point in the series. */
  barStubPx: 4,
  lineStrokePx: 2,
  /** The paper seam between stacked area series. */
  areaSeamPx: 1.5,
  barSeamPx: 1,
  axisGapPx: 4,
  /** Opacity of the text colour for resting bars, a proportion's track and its fill. */
  barRestOpacity: 0.16,
  trackOpacity: 0.08,
  proportionOpacity: 0.45,
});

export type HappierDataTextStyles = Readonly<{
  metric: HappierPortableStyle;
  body: HappierPortableStyle;
  strong: HappierPortableStyle;
  caption: HappierPortableStyle;
  captionStrong: HappierPortableStyle;
  header: HappierPortableStyle;
  /** The reader's locale, for number formatting. */
  locale: string | undefined;
}>;

/** The text styles every data node shares, from the host's real type roles when it installs them. */
export function useHappierDataTextStyles(theme: HappierUiTheme): HappierDataTextStyles {
  const typography = useOptionalHappierUiTypography();
  const localization = useOptionalHappierUiLocalization();
  return useMemo(() => {
    const body = resolveHappierTypeRoleStyle('body', theme, typography);
    const caption = resolveHappierTypeRoleStyle('caption', theme, typography);
    const label = resolveHappierTypeRoleStyle('label', theme, typography);
    const semiBold = (role: HappierPortableStyle) => ({ ...role, ...resolveHappierTextStepStyle({ weight: 'semiBold',
      fontSize: role.fontSize ?? theme.typography.body.fontSize, lineHeight: role.lineHeight ?? theme.typography.body.lineHeight }, typography) });
    return {
      metric: { ...resolveHappierTextStepStyle(HAPPIER_DATA_METRICS.metricValue, typography), color: theme.colors.text },
      body: { ...body, color: theme.colors.text },
      strong: { ...semiBold(body), color: theme.colors.text },
      caption: { ...caption, color: theme.colors.mutedText },
      captionStrong: { ...semiBold(caption), color: theme.colors.text },
      header: { ...label, color: theme.colors.mutedText },
      locale: localization?.locale,
    };
  }, [localization?.locale, theme, typography]);
}
