import type { ReactNode } from 'react';
import { View } from 'react-native';

import { useHappierNativeMinimumInteractiveTargetSize } from '../../environment/interactiveTarget.js';
import { HappierPressable } from '../interaction/Pressable.js';
import { HAPPIER_FIELD_BOX_METRICS, type HappierFieldBoxColors } from './FieldBox.js';

/** Numeric field anatomy shared by app settings and public plugin fields. The draft owner steps it. */
export function HappierFieldStepper(props: Readonly<{
  children: ReactNode;
  colors: HappierFieldBoxColors;
  decreaseLabel: string;
  increaseLabel: string;
  disabled?: boolean;
  canDecrement: boolean;
  canIncrement: boolean;
  onStep: (direction: -1 | 1) => void;
  renderSymbol: (symbol: string) => ReactNode;
  testID?: string;
}>) {
  const target = useHappierNativeMinimumInteractiveTargetSize();
  const size = Math.max(HAPPIER_FIELD_BOX_METRICS.minHeightPx, target ?? 0);
  return <View style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
    {([-1, 1] as const).map((direction) => {
      const disabled = props.disabled === true || !(direction === -1 ? props.canDecrement : props.canIncrement);
      const button = <HappierPressable key={direction} testID={props.testID ? `${props.testID}.${direction === -1 ? 'decrement' : 'increment'}` : undefined}
        accessibilityRole="button" accessibilityLabel={direction === -1 ? props.decreaseLabel : props.increaseLabel}
        disabled={disabled} onPress={() => props.onStep(direction)}
        style={({ focused, pressed }) => ({
          borderRadius: HAPPIER_FIELD_BOX_METRICS.radiusPx,
          borderWidth: HAPPIER_FIELD_BOX_METRICS.borderWidthPx,
          paddingLeft: 0, paddingRight: 0, minWidth: size, minHeight: size,
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: props.colors.backgroundColor,
          borderColor: focused ? props.colors.valueColor : props.colors.borderColor,
          opacity: disabled ? 0.4 : pressed ? 0.7 : 1,
        })}>{props.renderSymbol(direction === -1 ? '−' : '+')}</HappierPressable>;
      return direction === -1 ? button : <View key={direction} style={{ flexDirection: 'row', alignItems: 'center', flexShrink: 1 }}>
        {props.children}{button}
      </View>;
    })}
  </View>;
}
