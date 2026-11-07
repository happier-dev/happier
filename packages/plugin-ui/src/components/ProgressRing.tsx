import type { ReactElement } from 'react';
import { View } from 'react-native';
import { Circle, Svg } from 'react-native-svg';

import {
  resolveHappierIconSize,
  type HappierIconSize,
} from '../presentation/content/Icon.js';
import { usePluginTheme } from './PluginUiProvider.js';

export type ProgressRingProps = Readonly<{
  /** How many of `total` are done; clamped to the ring. */
  completed: number;
  total: number;
  size?: HappierIconSize;
  /** Names the ring when nothing beside it says the count; otherwise it is hidden from assistive technology. */
  accessibilityLabel?: string;
  testID?: string;
}>;

/**
 * How much of a counted whole is done (sub-tasks finished, steps passed), as a ring that fills clockwise from the
 * top in the done green over a quiet track. Draw it beside the words that say the count ("3 of 5"); the ring is the
 * glance, the words are the fact. Only a count the source read: an unknown share draws no ring.
 */
export function ProgressRing({
  completed,
  total,
  size = 'small',
  accessibilityLabel,
  testID,
}: ProgressRingProps): ReactElement {
  const theme = usePluginTheme();
  const pixels = resolveHappierIconSize(size);
  const radius = 8;
  const circumference = 2 * Math.PI * radius;
  const share = total > 0 ? Math.min(1, Math.max(0, completed / total)) : 0;
  return (
    <View
      role={accessibilityLabel ? 'img' : undefined}
      aria-label={accessibilityLabel}
      aria-hidden={accessibilityLabel ? undefined : true}
      testID={testID}
      style={{ width: pixels, height: pixels }}
    >
      <Svg width={pixels} height={pixels} viewBox="0 0 24 24" fill="none">
        <Circle
          cx={12}
          cy={12}
          r={radius}
          stroke={theme.colors.divider}
          strokeWidth={2.6}
        />
        {share === 0 ? null : (
          <Circle
            cx={12}
            cy={12}
            r={radius}
            stroke={theme.colors.success}
            strokeWidth={2.6}
            strokeLinecap="round"
            strokeDasharray={`${share * circumference} ${circumference}`}
            transform="rotate(-90 12 12)"
          />
        )}
      </Svg>
    </View>
  );
}
