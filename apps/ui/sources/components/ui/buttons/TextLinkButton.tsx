import {
  HAPPIER_PRESS_FEEDBACK_V1,
  HappierPressable,
  happierFocusRingStyle,
  happierPageTextMetrics,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/** The link's own line: its visible height. The hit area grows around it, never the layout. */
const LINE_HEIGHT_PX = happierPageTextMetrics('rowDescription').lineHeight;
/** A precise pointer needs only a little slack around the words. */
const PRECISE_POINTER_HIT_SLOP_PX = 6;

function resolveHitSlopPx(): number {
  const floor = resolveTouchTargetFloorPx();
  return floor === null
    ? PRECISE_POINTER_HIT_SLOP_PX
    : Math.ceil((floor - LINE_HEIGHT_PX) / 2);
}

/**
 * An operation written as words inside or beside a sentence: a tertiary choice ("Don't show again"),
 * a disclosure ("More" / "Less"), the one contextual recovery ending a status line ("Ask Happier").
 *
 * It is a button, not navigation: semibold ink (secondary, or primary for `strong`) that underlines on hover, the
 * shared press dip, and the keyboard focus ring. The text keeps its line height, so it sits on the
 * baseline of the sentence it ends; the press target reaches the platform minimum through hit slop.
 */
export const TextLinkButton = React.memo(function TextLinkButton(
  props: Readonly<{
    label: string;
    onPress: () => unknown;
    /** `quiet` reads as part of the sentence; `strong` is the sentence's one recovery. */
    tone?: 'quiet' | 'strong';
    accessibilityLabel?: string;
    /** A disclosure says whether what it controls is open. */
    expanded?: boolean;
    disabled?: boolean;
    testID?: string;
  }>,
) {
  const { theme } = useUnistyles();
  const strong = props.tone === 'strong';
  return (
    <HappierPressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      expanded={props.expanded}
      disabled={props.disabled}
      hitSlop={resolveHitSlopPx()}
      onPress={props.onPress}
      style={(state) => ({
        alignSelf: 'flex-start',
        borderRadius: 4,
        opacity: state.disabled
          ? 0.4
          : state.pressed
            ? HAPPIER_PRESS_FEEDBACK_V1.opacity
            : 1,
        ...happierFocusRingStyle({
          visible: state.focused,
          color: theme.colors.border.focus,
        }),
      })}
    >
      {(state) => (
        <Text
          numberOfLines={1}
          style={[
            stylesheet.label,
            strong ? stylesheet.strong : null,
            state.hovered ? stylesheet.hovered : null,
          ]}
        >
          {props.label}
        </Text>
      )}
    </HappierPressable>
  );
});

const stylesheet = StyleSheet.create((theme) => ({
  label: {
    ...Typography.default('semiBold'),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
  },
  strong: {
    color: theme.colors.text.primary,
  },
  hovered: {
    color: theme.colors.text.primary,
    textDecorationLine: 'underline',
  },
}));
