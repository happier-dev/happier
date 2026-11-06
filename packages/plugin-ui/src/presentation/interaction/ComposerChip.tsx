import * as React from 'react';
import {
  Pressable,
  type AccessibilityState,
} from 'react-native';

import type { HappierHitReach } from '../../environment/interactiveTarget.js';
import type {
  HappierAccessibilityRole,
  HappierAccessibilityState,
  HappierGestureResponderEvent,
  HappierStyleProp,
} from '../portableTypes.js';
import type { HappierPressableProps } from './Pressable.js';
import { useHappierHitArea } from './hitArea.js';

type WebToggleProps = Readonly<{ 'aria-pressed'?: boolean }>;
const ComposerChipPressable = Pressable as React.ComponentType<
  React.ComponentPropsWithRef<typeof Pressable> & WebToggleProps
>;

export type HappierComposerChipProps = Readonly<{
  children?: React.ReactNode;
  onPress: (event: HappierGestureResponderEvent) => void;
  /** Web-only host attributes: the native tooltip and the `data-*` hooks a browser test reads. */
  webAttributes?: Readonly<{ title?: string; dataSet?: Readonly<Record<string, string>> }>;
  disabled?: boolean;
  selected?: boolean;
  expressesSelection?: boolean;
  testID?: string;
  accessibilityRole?: HappierAccessibilityRole;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  accessibilityState?: HappierAccessibilityState;
  hitSlop?: HappierPressableProps['hitSlop'];
  /** How far the chip's touch hit area may reach past it: half the rail gap ({@link HappierPressableProps.hitReach}). */
  hitReach?: HappierHitReach;
  style?: (pressed: boolean) => HappierStyleProp;
}>;

/**
 * The one compact Composer-rail chip shell used by Happier core and Plugin UI.
 * Callers supply semantic content and the rail's theme chrome; this owner keeps
 * press, disabled/selected semantics, and the touch hit area identical. The chip keeps the rail's
 * compact drawing; under a finger its hit area reaches the touch target past it.
 */
export const HappierComposerChip = React.forwardRef<unknown, HappierComposerChipProps>(
  function HappierComposerChip(props, ref) {
    const disabled = props.disabled === true || props.accessibilityState?.disabled === true;
    const accessibilityState = {
      ...props.accessibilityState,
      ...(disabled ? { disabled: true } : {}),
      ...(props.expressesSelection ? { selected: props.selected === true } : {}),
    } satisfies AccessibilityState;
    const hitArea = useHappierHitArea({
      restingStyle: () => props.style?.(false),
      hitReach: props.hitReach,
      hitSlop: props.hitSlop,
    });

    return (
      <ComposerChipPressable
        // The native renderer owns the instance; the public ref is deliberately opaque.
        ref={ref as React.ComponentProps<typeof ComposerChipPressable>['ref']}
        testID={props.testID}
        accessibilityRole={props.accessibilityRole ?? 'button'}
        accessibilityLabel={props.accessibilityLabel}
        accessibilityHint={props.accessibilityHint}
        accessibilityState={accessibilityState}
        {...(props.expressesSelection ? { 'aria-pressed': props.selected === true } : {})}
        disabled={disabled}
        hitSlop={hitArea.hitSlop}
        onLayout={hitArea.onLayout}
        onPress={props.onPress}
        {...props.webAttributes}
        style={({ pressed }) => props.style?.(pressed)}
      >
        {hitArea.frame}
        {props.children}
      </ComposerChipPressable>
    );
  },
);
