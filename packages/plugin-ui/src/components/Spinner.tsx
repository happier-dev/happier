import type { ReactElement } from 'react';

import { HappierSpinner } from '../presentation/feedback/Spinner.js';
import { HAPPIER_TONE_COLOR_TOKEN } from '../presentation/semantics.js';
import { usePluginSurfaceActivity } from '../hostApi/context.js';
import { useOptionalHappierTabPanelActivityInternal } from '../presentation/navigation/Tabs.js';
import { usePluginTheme } from './PluginUiProvider.js';
import type { TextTone } from './Text.js';

export type SpinnerSize = 'small' | 'large' | number;

export type SpinnerProps = Readonly<{
  size?: SpinnerSize;
  /** Semantic colour role, resolved from the host theme. Defaults to secondary. */
  tone?: TextTone;
  /**
   * What is being waited for. A spinner with no label announces only
   * "progressbar", which tells a screen-reader user nothing about which part of
   * the surface is busy.
   */
  accessibilityLabel?: string;
  testID?: string;
}>;

/**
 * Happier's activity spinner for plugin surfaces.
 *
 * A thin adapter: the platform behaviour, stepped web timing and reduced-motion
 * handling all live in the shared presentation owner Happier core renders too
 * (UI-T27). This adapter only projects the semantic tone onto a theme colour.
 */
export function Spinner({ size, tone, accessibilityLabel, testID }: SpinnerProps): ReactElement {
  const theme = usePluginTheme();
  const surfaceActivity = usePluginSurfaceActivity();
  const tabPanelActivity = useOptionalHappierTabPanelActivityInternal();

  return (
    <HappierSpinner
      size={size}
      color={theme.colors[HAPPIER_TONE_COLOR_TOKEN[tone ?? 'secondary']]}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      animationEnabled={surfaceActivity.active && (tabPanelActivity?.active ?? true)}
    />
  );
}
