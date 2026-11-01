import type { ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierHitReach } from '../../environment/interactiveTarget.js';
import {
  useOptionalHappierUiAccessibility,
  useOptionalHappierUiTheme,
} from '../../environment/context.js';
import { HAPPIER_RADIUS_V1 } from '../../environment/radius.js';
import { HAPPIER_SPACE_STEPS } from '../../environment/spacing.js';
import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { HappierPressable } from '../interaction/Pressable.js';
import {
  happierDiscretePressStyle,
  happierPressTransitionStyle,
} from '../interaction/pressFeedback.js';
import { HappierText } from '../text/Text.js';
import { HAPPIER_TYPE_SCALE } from '../text/typeScale.js';

/**
 * The two sizes a disclosure caret takes: `row` ends a list row at the row chevron's size, `compact` sits
 * beside a meta label (an in-place "Details" or "Review output").
 */
export type HappierDisclosureCaretDensity = 'row' | 'compact';

export type HappierDisclosureToggleProps = Readonly<{
  /** Already translated; it names the button and is the drawn label. */
  label: string;
  /** The caller's one bit: the body it reveals appears in place, without an animated accordion. */
  open: boolean;
  onPress: () => void;
  /**
   * The decorative caret, already turned for `open` (the host's caret on the shared disclosure turn, or the drawn
   * chevron where there is no host), at its `compact` density.
   */
  caret: ReactNode;
  /** The edge the toggle stands on: a row's title edge, or a centred card's axis. */
  align?: 'start' | 'center';
  /**
   * The label in the host's quiet meta text. Absent, the environment's `meta` text in the secondary tone; a host
   * without a Happier UI theme in scope binds its own.
   */
  renderLabel?: (label: string) => ReactNode;
  /** Absent, the environment theme's focus ink. */
  focusColor?: string;
  /** How far the hit area may reach past the drawn line; `{ top: 0 }` under an action that owns the gap above. */
  hitReach?: HappierHitReach;
  testID?: string;
}>;

/**
 * The one in-place disclosure control ("Details", "Review output"): a caret and a quiet meta label in one button
 * that keeps the meta line's height, while the shared hit area reaches the touch target without taking layout.
 * The button owns the name and the expanded state; the caret stays decorative.
 */
export function HappierDisclosureToggle(props: HappierDisclosureToggleProps) {
  const reducedMotion =
    useOptionalHappierUiAccessibility()?.reducedMotion ?? true;
  const theme = useOptionalHappierUiTheme();
  const focusColor = props.focusColor ?? theme?.colors.focus;
  return (
    <HappierPressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      expanded={props.open}
      hitReach={props.hitReach}
      onPress={props.onPress}
      style={(state) => [
        {
          alignSelf: props.align === 'center' ? 'center' : 'flex-start',
          // The meta line's height, declared so the hit area reaches its target before layout measures the row.
          minHeight: HAPPIER_TYPE_SCALE.meta.lineHeight,
          justifyContent: 'center',
        },
        happierDiscretePressStyle(state.pressed, reducedMotion),
        happierPressTransitionStyle(
          state.pressed,
          ['transform', 'opacity'],
          reducedMotion,
        ),
      ]}
    >
      {(state) => (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: HAPPIER_SPACE_STEPS.s4,
            borderRadius: HAPPIER_RADIUS_V1.sm,
            ...(focusColor
              ? happierFocusRingStyle({
                  visible: state.focused,
                  color: focusColor,
                })
              : null),
          }}
        >
          {props.caret}
          {props.renderLabel?.(props.label) ?? (
            <HappierText accessible={false} variant="meta" tone="secondary">
              {props.label}
            </HappierText>
          )}
        </View>
      )}
    </HappierPressable>
  );
}
