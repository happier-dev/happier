import type { ReactElement } from 'react';

import { HappierPressable, type HappierPressableProps } from '../interaction/Pressable.js';
import { HAPPIER_FILTER_CHIP_METRICS } from './filterChipMetrics.js';

export type HappierFilterChipProps = HappierPressableProps & Readonly<{ gap: number }>;

/** The compact filter-chip shell; adapters supply content, semantic state and theme inks. */
export function HappierFilterChip({ gap, style, ...props }: HappierFilterChipProps): ReactElement {
  return <HappierPressable {...props} style={(state) => [
    {
      flexDirection: 'row', alignItems: 'center', gap,
      minHeight: HAPPIER_FILTER_CHIP_METRICS.minHeightPx,
      maxWidth: '100%', flexShrink: 1,
      paddingHorizontal: HAPPIER_FILTER_CHIP_METRICS.paddingHorizontalPx,
      borderRadius: HAPPIER_FILTER_CHIP_METRICS.radiusPx,
      borderWidth: 1,
    },
    typeof style === 'function' ? style(state) : style,
  ]} />;
}
