import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { Icon, ICON_SIZE, type IconName } from '@/components/ui/icons/Icon';
import type { KeyboardCommandId } from '@/keyboard/types';

import {
  MESSAGE_ACTION_BUTTON_PX,
  resolveMessageActionNeighbourGapPx,
} from './messageActionNeighbourGap';

/**
 * The one glyph control of a message's action row (owner 04): every action, the pin, Select and the ⋯ draw the same
 * square, the same glyph step and the same secondary ink, through the shared icon button and its disabled state.
 * Only a state colours a glyph (a copied check, a pinned or selected message). The row's sideways gap is this
 * control's trailing margin, `s6`, or `s2` in the inverted layout; the hit area reaches half of it.
 */
export function MessageActionIconButton(
  props: Readonly<{
    testID: string;
    icon: IconName;
    accessibilityLabel: string;
    accessibilityHint?: string;
    invertedActionsLayout: boolean;
    onPress: () => void | Promise<void>;
    /** A state's ink (copied, pinned, selected); otherwise the row's secondary ink. */
    stateColor?: string;
    selected?: boolean;
    accessibilityRole?: React.ComponentProps<
      typeof IconButton
    >['accessibilityRole'];
    checked?: boolean;
    expanded?: boolean;
    hasPopup?: React.ComponentProps<typeof IconButton>['hasPopup'];
    disabled?: boolean;
    disabledReason?: string;
    onDisabledPress?: () => void;
    onFocusChange?: (focused: boolean) => void;
    /** Where a sheet opened from this control anchors. */
    anchorRef?: React.Ref<View>;
    /** The keyboard command that runs this action on the focused message; its key joins the tooltip. */
    shortcutCommandId?: KeyboardCommandId;
  }>,
) {
  const { theme } = useUnistyles();
  const gapPx = props.invertedActionsLayout ? theme.space.s2 : theme.space.s6;
  return (
    <View
      ref={props.anchorRef}
      collapsable={false}
      style={props.invertedActionsLayout ? styles.inverted : styles.button}
    >
      <IconButton
        testID={props.testID}
        size={MESSAGE_ACTION_BUTTON_PX}
        variant="plain"
        icon={
          <Icon
            name={props.icon}
            size={ICON_SIZE.xs}
            color={props.stateColor ?? theme.colors.text.secondary}
          />
        }
        accessibilityLabel={props.accessibilityLabel}
        accessibilityHint={props.accessibilityHint}
        accessibilityRole={props.accessibilityRole}
        checked={props.checked}
        expanded={props.expanded}
        hasPopup={props.hasPopup}
        selected={props.selected}
        tooltip={props.accessibilityLabel}
        shortcutCommandId={props.shortcutCommandId}
        disabled={props.disabled}
        disabledReason={props.disabledReason}
        onDisabledPress={props.onDisabledPress}
        interactiveTargetGapPx={gapPx}
        interactiveTargetVerticalGapPx={resolveMessageActionNeighbourGapPx(
          theme,
        )}
        onPress={props.onPress}
        onFocusChange={props.onFocusChange}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  button: { marginRight: theme.space.s6 },
  inverted: { marginRight: theme.space.s2 },
}));
