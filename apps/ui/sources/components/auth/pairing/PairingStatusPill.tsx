import * as React from 'react';
import {
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';

/**
 * A pairing step's one status line (lab Approve and "Point at your computer"): a quiet capsule on the page with a
 * hairline edge and one line of body text. The requester code's wait and approval and the camera's search share it,
 * so the line reads the same wherever a device waits for another.
 */
export const PairingStatusPill = React.memo(function PairingStatusPill(
  props: Readonly<{
    testID?: string;
    style?: StyleProp<ViewStyle>;
    onLayout?: (event: LayoutChangeEvent) => void;
    children: React.ReactNode;
  }>,
) {
  return (
    <View
      testID={props.testID}
      accessibilityLiveRegion="polite"
      role="status"
      style={[pairingStatusStyles.pill, props.style]}
      onLayout={props.onLayout}
    >
      {props.children}
    </View>
  );
});

/** "Needs you": the wait is on the person's other device, so the dot takes the attention ink. */
export function PairingStatusWaitingDot() {
  const { theme } = useUnistyles();
  return (
    <View
      style={[
        pairingStatusStyles.waitingDot,
        { backgroundColor: theme.colors.state.attention.foreground },
      ]}
    />
  );
}

export const pairingStatusStyles = StyleSheet.create((theme) => ({
  pill: {
    minHeight: 32,
    paddingHorizontal: theme.space.s12,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: theme.colors.border.default,
    backgroundColor: theme.colors.surface.base,
    alignItems: 'center',
    justifyContent: 'center',
  },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
  },
  waitingDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  // A countdown changes every second, so its figures are tabular: "4:52" → "4:51" changes no width.
  text: {
    ...Typography.variant('body'),
    color: theme.colors.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  textSettled: {
    color: theme.colors.text.primary,
  },
}));
