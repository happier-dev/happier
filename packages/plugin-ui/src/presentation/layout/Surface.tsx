import type { ReactNode } from 'react';
import { View } from 'react-native';

import type { HappierStyleProp } from '../portableTypes.js';
import { HappierPressable } from '../interaction/Pressable.js';

/**
 * Shared structural surface behavior.
 *
 * The app owns its private palette, elevation and material decisions; plugin
 * adapters own their projected semantic chrome. This owner keeps the common
 * native host selection and optional press lifecycle so neither side keeps a
 * second card/action wrapper.
 */
export type HappierSurfaceProps = Readonly<{
  children?: ReactNode;
  testID?: string;
  onPress?: () => unknown;
  disabled?: boolean;
  accessibilityLabel?: string;
  /** Resolved chrome supplied by the core or plugin adapter. */
  style?: HappierStyleProp;
  /** Hit area/chrome outside the card body for an actionable surface. */
  pressableStyle?: HappierStyleProp;
  /** Applied only while the shared press lifecycle reports a real press. */
  pressedStyle?: HappierStyleProp;
}>;

export function HappierSurface({
  children,
  testID,
  onPress,
  disabled,
  accessibilityLabel,
  style,
  pressableStyle,
  pressedStyle,
}: HappierSurfaceProps) {
  const content = <View style={style}>{children}</View>;

  if (!onPress) {
    return <View testID={testID}>{content}</View>;
  }

  return (
    <HappierPressable
      testID={testID}
      accessibilityLabel={accessibilityLabel}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [pressableStyle, pressed ? pressedStyle : undefined]}
    >
      {content}
    </HappierPressable>
  );
}
