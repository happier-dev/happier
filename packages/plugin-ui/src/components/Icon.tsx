import { createContext, useContext, type ReactElement } from 'react';
import { View } from 'react-native';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import {
  resolveHappierIconSize,
  type HappierIconName,
  type HappierIconSize,
} from '../presentation/content/Icon.js';
import { HAPPIER_TONE_COLOR_TOKEN, type HappierTone } from '../presentation/semantics.js';
import { usePluginTheme } from './PluginUiProvider.js';
import { usePageHeaderMarkGlyphPx } from './pageHeaderMark.js';

/** Closed portable concepts. The app privately maps them to its incumbent pack. */
export type IconName = HappierIconName;

export type IconProps = Readonly<{
  name: IconName;
  size?: HappierIconSize;
  tone?: HappierTone;
  accessibilityLabel?: string;
  testID?: string;
}>;

/**
 * The ink of the control a glyph leads (a filled primary's on-accent foreground). A glyph with no tone of its
 * own takes it, so an icon beside a label is never a different colour from the label; an explicit tone wins.
 */
export const PluginUiLeadingGlyphInkContext = createContext<string | null>(null);

export function Icon({ name, size = 'medium', tone, accessibilityLabel, testID }: IconProps): ReactElement {
  // A glyph that is a page header's mark draws at the header's mark step, as a `BrandMark` there does: the header
  // owns its mark's footprint, so a page never picks a mark size of its own.
  const pageHeaderGlyphPx = usePageHeaderMarkGlyphPx();
  return <PluginUiIconGlyph name={name} size={pageHeaderGlyphPx ?? resolveHappierIconSize(size)} tone={tone} accessibilityLabel={accessibilityLabel} testID={testID} />;
}

/**
 * Package-private adapter for geometry stepped by a shared presentation owner. `color` is for a glyph
 * that stands in a control's own ink (a filled primary's on-accent foreground) rather than a tone.
 */
export function PluginUiIconGlyph({ name, size: pixels, tone, color: inkColor, accessibilityLabel, testID }: Omit<IconProps, 'size'> & Readonly<{ size: number; color?: string }>): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  const theme = usePluginTheme();
  const controlInk = useContext(PluginUiLeadingGlyphInkContext);
  const color = inkColor ?? (tone === undefined ? controlInk : null) ?? theme.colors[HAPPIER_TONE_COLOR_TOKEN[tone ?? 'neutral']];
  if (host) {
    return <>{host.renderIcon({ name, size: pixels, color, ...(accessibilityLabel ? { accessibilityLabel } : {}), ...(testID ? { testID } : {}) })}</>;
  }
  return (
    <View
      role={accessibilityLabel ? 'img' : undefined}
      aria-label={accessibilityLabel}
      aria-hidden={accessibilityLabel ? undefined : true}
      testID={testID}
      style={{ width: pixels, height: pixels }}
    />
  );
}
