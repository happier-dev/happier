import {
  HAPPIER_COLLECTION_LIST_METRICS,
  HAPPIER_PAGE_METRICS,
} from '@happier-dev/plugin-ui/presentation';
import * as React from 'react';
import { Pressable } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * The action a list row reveals when it is swiped (owner 2026-11-11, phone 04): one quiet rounded control in the
 * row's gutter, its glyph before a short label (“Archive”, “Mark as read”), on the row's ink selection fill. It is
 * not a coloured slab: a reversible step does not speak in a state colour. Every swipeable row draws this one.
 */
export function RowSwipeAction(
  props: Readonly<{
    testID?: string;
    icon: IconName;
    label: string;
    onPress: () => void;
    disabled?: boolean;
    /** The action is in flight: a ring replaces the glyph. */
    busy?: boolean;
    accessibilityHint?: string;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  return (
    <Pressable
      testID={props.testID}
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityHint={props.accessibilityHint}
      accessibilityState={{
        disabled: props.disabled === true,
        busy: props.busy === true,
      }}
      disabled={props.disabled}
      onPress={props.onPress}
      style={({ pressed }) => [
        styles.action,
        pressed ? styles.pressed : null,
        props.disabled ? styles.disabled : null,
      ]}
    >
      {props.busy ? (
        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
      ) : (
        <Icon
          name={props.icon}
          size={HAPPIER_ROW_SWIPE_ACTION_GLYPH_PX}
          color={theme.colors.text.secondary}
        />
      )}
      <Text style={styles.label} numberOfLines={1}>
        {props.label}
      </Text>
    </Pressable>
  );
}

/** The rows' own glyph size, so the action's glyph reads as one of theirs. */
const HAPPIER_ROW_SWIPE_ACTION_GLYPH_PX = 16;

const styles = StyleSheet.create((theme) => ({
  // Inset from the row's top and bottom and ending on the list's gutter, rounded like a row's selection chip.
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s6,
    marginVertical: theme.space.s4,
    marginLeft: theme.space.s8,
    marginRight: HAPPIER_COLLECTION_LIST_METRICS.rowInset,
    paddingHorizontal: HAPPIER_PAGE_METRICS.rowPaddingHorizontalPx,
    borderRadius: HAPPIER_COLLECTION_LIST_METRICS.rowRadius,
    backgroundColor: theme.colors.surface.selected,
  },
  pressed: {
    opacity: motionTokens.press.opacity,
  },
  disabled: {
    opacity: 0.56,
  },
  label: {
    ...Typography.variant('label', 'medium'),
    color: theme.colors.text.primary,
  },
}));
