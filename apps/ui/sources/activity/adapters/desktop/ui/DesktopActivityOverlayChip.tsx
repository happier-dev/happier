import * as React from 'react';
import { Pressable, type View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Text } from '@/components/ui/text/Text';

import { createDesktopActivityOverlayFocusRingStyle } from './DesktopActivityOverlayChrome';
import type { DesktopActivityOverlayPressableInteractionState } from './DesktopActivityOverlayPressableInteractionState';

/**
 * The island's one chip: a pill drawn as an ink hairline on the black, filled only on hover (lab
 * `.nt-phr`). A `choice` answers the question it sits under (the words read in primary ink, at the
 * small control height, with the strong edge so it reads as a button on the ask's tint); a `phrase` is a quiet canned reply (secondary ink, a step smaller).
 */
export function DesktopActivityOverlayChip(
  props: Readonly<{
    label: string;
    role: 'choice' | 'phrase';
    testID?: string;
    accessibilityLabel?: string | null;
    disabled?: boolean;
    controlRef?: React.Ref<View>;
    onPress: () => void;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const choice = props.role === 'choice';

  return (
    <Pressable
      ref={props.controlRef}
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      style={(state) => {
        const interaction =
          state as DesktopActivityOverlayPressableInteractionState;
        return [
          styles.chip,
          choice ? styles.choice : styles.phrase,
          interaction.hovered === true && !props.disabled
            ? styles.hovered
            : null,
          state.pressed ? { opacity: motionTokens.press.opacitySubtle } : null,
          props.disabled ? styles.disabled : null,
          createDesktopActivityOverlayFocusRingStyle(
            theme,
            interaction.focused,
          ),
        ];
      }}
    >
      <Text
        variant={choice ? 'body' : 'meta'}
        numberOfLines={1}
        style={choice ? styles.choiceText : styles.phraseText}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create((theme) => ({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    maxWidth: '100%',
    borderRadius: 9999,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.colors.border.default,
  },
  // An answer sits on the ask's tint, so its edge is the strong one: it must read as a button.
  choice: {
    height: PAGE_LIST_METRICS.smallControlHeightPx,
    paddingHorizontal: theme.space.s10,
    borderColor: theme.colors.border.strong,
  },
  phrase: {
    height: theme.space.s24,
    paddingHorizontal: theme.space.s10,
  },
  hovered: {
    backgroundColor: theme.colors.surface.hover,
  },
  disabled: {
    opacity: 0.45,
  },
  choiceText: {
    color: theme.colors.text.primary,
  },
  phraseText: {
    color: theme.colors.text.secondary,
  },
}));
