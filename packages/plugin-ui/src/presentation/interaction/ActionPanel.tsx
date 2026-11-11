import type { ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierStyleProp } from '../portableTypes.js';
import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';

export type HappierActionPanelProps = Readonly<{
  /** Names the related action set for assistive technology. */
  title?: string;
  children?: ReactNode;
  testID?: string;
  style?: HappierStyleProp;
}>;

export type HappierActionPanelSectionProps = Readonly<{
  /** Names a subset within one action panel without creating a nested toolbar. */
  title?: string;
  children?: ReactNode;
  testID?: string;
  style?: HappierStyleProp;
}>;

/**
 * The structural and accessibility owner for one bounded set of actions.
 * Dispatch, ordering and availability remain with the caller's Action owner.
 */
export function HappierActionPanel({ title, children, testID, style }: HappierActionPanelProps) {
  return (
    <View
      role="toolbar"
      aria-label={title}
      accessibilityLabel={title}
      testID={testID}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: HAPPIER_PAGE_METRICS.actionGapPx,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}

/** A named subgroup inside one toolbar; it deliberately remains a group. */
export function HappierActionPanelSection({ title, children, testID, style }: HappierActionPanelSectionProps) {
  return (
    <View
      role="group"
      aria-label={title}
      accessibilityLabel={title}
      testID={testID}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          // A section wraps inside its panel rather than running past a narrow pane.
          flexWrap: 'wrap',
          flexShrink: 1,
          maxWidth: '100%',
          gap: HAPPIER_PAGE_METRICS.actionCompactGapPx,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
