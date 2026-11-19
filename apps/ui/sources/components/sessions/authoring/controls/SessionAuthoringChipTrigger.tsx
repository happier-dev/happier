import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { SelectionListFilterChip } from '@/components/ui/selectionList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/** Half the chip row's 8 px gap on every side: wrapped chips' hit areas meet, never overlap. */
export const SESSION_AUTHORING_CHIP_HIT_REACH = 4;

/**
 * The `chips` presentation's chip, in the roomier authoring context (the composer bar keeps its own denser variant),
 * from the same theme tokens. Shared with the row's composer-chip render context and its reset chip.
 */
export const sessionAuthoringChipStyles = StyleSheet.create((theme) => ({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: Platform.select({ default: 16, android: 20 }),
    paddingHorizontal: theme.space.s10,
    paddingVertical: theme.space.s6,
    justifyContent: 'center',
    gap: theme.space.s6,
    // Reserved, so the focus ring never moves a neighbour.
    borderWidth: 1,
    borderColor: 'transparent',
  },
  chipPressed: {
    opacity: motionTokens.press.opacity,
  },
  chipText: {
    ...Typography.variant('body', 'semiBold'),
    color: theme.colors.composer.chipTint,
  },
  /** Sized to its value but never past its column: a long value truncates inside the chip (C24). */
  chipAnchor: {
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
}));

/**
 * The one trigger of a Session field in the `chips` presentation: quiet while the subject inherits the value, and the
 * canonical bordered chip naming its field ("Permissions: Read-only") once the subject sets it, so the row reads as
 * one set (lab E1; WF-ACCEPT-1119 item 7). Option fields and the approval profile both draw it; the chooser stays the
 * field's own.
 */
export function SessionAuthoringChipTrigger(
  props: Readonly<{
    anchorRef?: React.RefObject<React.ComponentRef<typeof View> | null>;
    /** The field's name: the accessible name's first half, and the changed chip's label. */
    title: string;
    label: string;
    leading?: React.ReactNode;
    /** Set for this subject rather than inherited: the chip is bordered and names its field. */
    changed?: boolean;
    /** Says what the chip's state means ("Changed for this step"); hosts pass it for a changed value. */
    accessibilityHint?: string;
    open: boolean;
    disabled?: boolean;
    onPress: () => void;
    testID: string;
  }>,
): React.ReactElement {
  const { theme } = useUnistyles();
  const styles = sessionAuthoringChipStyles;
  if (props.changed === true) {
    return (
      <View ref={props.anchorRef} collapsable={false} style={styles.chipAnchor}>
        <SelectionListFilterChip
          filter={{
            id: props.testID,
            testID: props.testID,
            label: props.title,
            valueLabel: props.label,
            // A changed value names its field ("Permissions: Read-only"), so it reads without its row.
            showLabel: true,
            ...(props.leading === undefined ? {} : { icon: props.leading }),
            ...(props.accessibilityHint === undefined
              ? {}
              : { accessibilityHint: props.accessibilityHint }),
            disabled: props.disabled === true,
            // The chip only asks to open; the field's own chooser is the menu.
            open: false,
            onOpenChange: (next) => {
              if (next) props.onPress();
            },
            renderPopoverContent: () => null,
          }}
        />
      </View>
    );
  }
  return (
    <View ref={props.anchorRef} collapsable={false} style={styles.chipAnchor}>
      <HappierPressable
        testID={props.testID}
        accessibilityRole="button"
        // A chip that names its own field (nothing chosen yet) says it once, not "Approval profile: Approval profile".
        accessibilityLabel={props.label === props.title ? props.title : `${props.title}: ${props.label}`}
        {...(props.accessibilityHint === undefined
          ? {}
          : { accessibilityHint: props.accessibilityHint })}
        disabled={props.disabled === true}
        expanded={props.open}
        hasPopup="menu"
        hitReach={SESSION_AUTHORING_CHIP_HIT_REACH}
        onPress={props.onPress}
        style={(state) => [
          styles.chip,
          state.pressed ? styles.chipPressed : null,
          focusRingStyle({
            focused: state.focused,
            color: theme.colors.border.focus,
          }),
        ]}
      >
        {/* The value's identity mark leads the chip, as in every other presentation (lab dpRev `add`). */}
        {props.leading ?? null}
        <Text numberOfLines={1} style={styles.chipText}>
          {props.label}
        </Text>
      </HappierPressable>
    </View>
  );
}
