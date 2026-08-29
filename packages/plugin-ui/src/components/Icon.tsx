import type { ReactElement } from 'react';
import { View } from 'react-native';

import { useOptionalPluginUiPresentationHost } from '../presentationHost/context.js';
import {
  resolveHappierIconSize,
  type HappierIconName,
  type HappierIconSize,
} from '../presentation/content/Icon.js';
import { HAPPIER_TONE_COLOR_TOKEN, type HappierTone } from '../presentation/semantics.js';
import { usePluginTheme } from './PluginUiProvider.js';

/** Closed portable concepts. The app privately maps them to its incumbent pack. */
export type IconName = HappierIconName;

export type IconProps = Readonly<{
  name: IconName;
  size?: HappierIconSize;
  tone?: HappierTone;
  accessibilityLabel?: string;
  testID?: string;
}>;

export function Icon({ name, size = 'medium', tone = 'neutral', accessibilityLabel, testID }: IconProps): ReactElement {
  const host = useOptionalPluginUiPresentationHost();
  const theme = usePluginTheme();
  const color = theme.colors[HAPPIER_TONE_COLOR_TOKEN[tone]];
  const pixels = resolveHappierIconSize(size);
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
