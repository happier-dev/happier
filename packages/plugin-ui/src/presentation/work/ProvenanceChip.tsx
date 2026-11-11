import type { ReactNode } from 'react';

import { useOptionalHappierUiTheme } from '../../environment/context.js';
import { useHappierMaterialColorResolver } from '../layout/Surface.js';
import { HAPPIER_BADGE_CAPSULE_RADIUS_PX, HappierBadge } from '../content/Foundation.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { HAPPIER_PRESS_FEEDBACK_V1 } from '../interaction/pressFeedback.js';
import type { HappierStyleProp } from '../portableTypes.js';

export type HappierProvenanceChipProps = Readonly<{
  /** Qualified display label. This component never looks up or interprets its source. */
  label: string;
  labelContent?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  accessibilityLabel?: string;
  testID?: string;
  onPress?: () => void;
  colors?: Readonly<{ foreground: string; background: string; border?: string; focus: string }>;
  /** Incumbent host geometry, where a source already has a documented chip shape. */
  badgeStyle?: HappierStyleProp;
  style?: HappierStyleProp;
}>;

/**
 * Badge-based provenance with an optional caller-owned destination.
 *
 * The chip owns its shape (a capsule, because a linked chip is a control) and its quiet ring; the
 * host owns where it sits. Linked and static chips never set their own cross-axis alignment, so a
 * transcript can hang one above a right-aligned message and a column can start it on its text edge.
 */
export function HappierProvenanceChip(props: HappierProvenanceChipProps) {
  const theme = useOptionalHappierUiTheme();
  const resolveMaterialColor = useHappierMaterialColorResolver();
  const colors = props.colors ?? (theme ? {
    foreground: theme.colors.secondaryText, background: theme.colors.canvas,
    border: theme.colors.divider, focus: theme.colors.focus,
  } : null);
  if (!colors) throw new Error('ProvenanceChip requires a mounted theme or explicit colors.');
  const materialColors = {
    ...colors,
    background: resolveMaterialColor(colors.background, theme?.colors.divider ?? 'transparent'),
    border: colors.border === undefined ? undefined : resolveMaterialColor(colors.border, theme?.colors.divider ?? 'transparent'),
  };
  const content = <HappierBadge shape="capsule" color={materialColors.foreground} backgroundColor={materialColors.background}
    borderColor={materialColors.border} leading={props.leading} trailing={props.trailing} style={props.badgeStyle}>
    {props.labelContent ?? props.label}
  </HappierBadge>;
  if (!props.onPress) return <HappierBadge shape="capsule" testID={props.testID} accessibilityLabel={props.accessibilityLabel ?? props.label}
    color={materialColors.foreground} backgroundColor={materialColors.background} borderColor={materialColors.border}
    leading={props.leading} trailing={props.trailing} style={[{ maxWidth: '100%' }, props.badgeStyle, props.style]}>
    {props.labelContent ?? props.label}
  </HappierBadge>;
  return <HappierPressable testID={props.testID} accessibilityRole="link"
    accessibilityLabel={props.accessibilityLabel ?? props.label} onPress={props.onPress}
    style={({ pressed, focused }) => [
      { maxWidth: '100%', borderRadius: HAPPIER_BADGE_CAPSULE_RADIUS_PX }, props.style,
      happierFocusRingStyle({ visible: focused, color: materialColors.focus }),
      pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
    ]}>{content}</HappierPressable>;
}
