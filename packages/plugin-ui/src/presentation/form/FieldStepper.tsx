import type { ReactNode } from 'react';
import { View } from 'react-native';

import { happierFocusRingStyle } from '../interaction/focusVisible.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { happierRaisedEdgeStyle } from '../layout/raisedEdge.js';
import { useHappierMaterialColorResolver } from '../layout/Surface.js';
import { HAPPIER_FIELD_BOX_METRICS, HAPPIER_FIELD_BOX_SHAPE, type HappierFieldBoxColors } from './FieldBox.js';

const STEP_DOWN_HIT_REACH = Object.freeze({ right: 0 });
const STEP_UP_HIT_REACH = Object.freeze({ left: 0 });

/** Numeric field anatomy shared by app settings and public plugin fields. The draft owner steps it. */
export function HappierFieldStepper(props: Readonly<{
  children: ReactNode;
  colors: HappierFieldBoxColors;
  /** The keyboard focus ring around a step button (the host's focus colour). */
  focusColor: string;
  decreaseLabel: string;
  increaseLabel: string;
  disabled?: boolean;
  canDecrement: boolean;
  canIncrement: boolean;
  onStep: (direction: -1 | 1) => void;
  renderSymbol: (symbol: string) => ReactNode;
  testID?: string;
  /**
   * `compact`: one field box holding − value +, for a short count beside a label. The children are
   * the bare value (no box of their own); the default draws the value in its own box between two buttons.
   */
  compact?: boolean;
}>) {
  const paintColor = useHappierMaterialColorResolver();
  // The buttons keep the field's drawn size under every pointer; under a finger each reaches its target
  // outward and up and down, never over the value between them (DESIGN.md → touch targets are hit areas).
  const size = HAPPIER_FIELD_BOX_METRICS.minHeightPx;
  const compact = props.compact === true;
  // The compact box paints the shared field (ground, outline, edge) but never clips: it is shorter than
  // its buttons' hit areas, and a clipping box would cut their reach off (DESIGN.md → touch targets).
  return <View style={compact ? [
    HAPPIER_FIELD_BOX_SHAPE,
    { flexDirection: 'row', alignItems: 'center', paddingLeft: 0, paddingRight: 0, borderColor: props.colors.borderColor, backgroundColor: paintColor(props.colors.backgroundColor) },
    happierRaisedEdgeStyle(props.colors.edge),
  ] : { flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
    {([-1, 1] as const).map((direction) => {
      const disabled = props.disabled === true || !(direction === -1 ? props.canDecrement : props.canIncrement);
      const button = <HappierPressable key={direction} testID={props.testID ? `${props.testID}.${direction === -1 ? 'decrement' : 'increment'}` : undefined}
        accessibilityRole="button" accessibilityLabel={direction === -1 ? props.decreaseLabel : props.increaseLabel}
        disabled={disabled} onPress={() => props.onStep(direction)}
        hitReach={direction === -1 ? STEP_DOWN_HIT_REACH : STEP_UP_HIT_REACH}
        style={({ focused, pressed }) => ({
          // Inside the compact box the buttons share its edge; apart they are boxes of their own.
          borderRadius: HAPPIER_FIELD_BOX_METRICS.radiusPx,
          borderWidth: compact ? 0 : HAPPIER_FIELD_BOX_METRICS.borderWidthPx,
          paddingLeft: 0, paddingRight: 0, minWidth: size, minHeight: compact ? size - 2 * HAPPIER_FIELD_BOX_METRICS.borderWidthPx : size,
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: compact ? 'transparent' : props.colors.backgroundColor,
          borderColor: props.colors.borderColor,
          ...happierFocusRingStyle({ visible: focused, color: props.focusColor }),
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        })}>{props.renderSymbol(direction === -1 ? '−' : '+')}</HappierPressable>;
      return direction === -1 ? button : <View key={direction} style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
        {props.children}{button}
      </View>;
    })}
  </View>;
}
