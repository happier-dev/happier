import { useMemo } from 'react';

import { useOptionalHappierUiLocalization, useOptionalHappierUiTypography } from '../../environment/context.js';
import type { HappierUiTheme } from '../../environment/types.js';
import { resolveHappierTextStepStyle } from '../layout/pageText.js';
import type { HappierPortableStyle } from '../portableTypes.js';
import { resolveHappierTypeRoleStyle } from '../text/typeRole.js';

import { HAPPIER_DATA_METRICS } from './dataMetrics.js';

export { HAPPIER_DATA_METRICS };

/**
 * How a live meter moves (lab `rv`): a new value eases from where the fill is drawn (strong ease-out, so a sample
 * reads as arriving, never as lagging), and a tone change cross-fades on the shared slow step. Reduced motion jumps.
 */
export const HAPPIER_DATA_MOTION = Object.freeze({
  valueMs: 600,
  valueBezier: Object.freeze([0.23, 1, 0.32, 1] as const),
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
    const body = resolveHappierTypeRoleStyle('meta', theme, typography);
    const caption = resolveHappierTypeRoleStyle('micro', theme, typography);
    // A column header sits at the cell's size with the label's weight: it names the column without
    // outweighing the widget title above it or the cells below it.
    const header = resolveHappierTypeRoleStyle('meta', theme, typography, 'medium');
    const semiBold = (role: HappierPortableStyle) => ({ ...role, ...resolveHappierTextStepStyle({ weight: 'semiBold',
      fontSize: role.fontSize ?? theme.typography.body.fontSize, lineHeight: role.lineHeight ?? theme.typography.body.lineHeight }, typography) });
    return {
      metric: { ...resolveHappierTextStepStyle(HAPPIER_DATA_METRICS.metricValue, typography), color: theme.colors.text },
      body: { ...body, color: theme.colors.text },
      strong: { ...semiBold(body), color: theme.colors.text },
      caption: { ...caption, color: theme.colors.mutedText },
      captionStrong: { ...semiBold(caption), color: theme.colors.text },
      header: { ...header, color: theme.colors.secondaryText },
      locale: localization?.locale,
    };
  }, [localization?.locale, theme, typography]);
}
