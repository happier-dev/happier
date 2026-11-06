import { getMentionActionChipPlacement } from './agentInputActionChipPlacements';
import * as React from 'react';
import { Pressable } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputChipLabel } from '@/components/sessions/agentInput/components/AgentInputChipLabel';
import { Icon } from '@/components/ui/icons/Icon';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';

import {
  AGENT_INPUT_CHIP_ICON_SIZE_PX,
  AGENT_INPUT_CHIP_ICON_STYLE,
  AGENT_INPUT_MENU_ICON_SIZE_PX,
} from './agentInputChipIconMetrics';

/**
 * `@` as a control (lab T2-A composer): the same mention the person can type, offered to someone who
 * doesn't know the trigger. The host writes the trigger into its document and focuses the field; the
 * composer's own suggestions take it from there.
 */
export function createMentionActionChip(
  params: Readonly<{
    label: string;
    disabled: boolean;
    onMention: () => void;
  }>,
): AgentInputExtraActionChip {
  const { label, disabled, onMention } = params;
  return {
    key: 'mention',
    controlId: 'shortcuts',
    placement: getMentionActionChipPlacement(),
    labelPolicy: 'auto-hide',
    stabilityKey: disabled,
    collapsedAction: ({ tint, dismiss }) => ({
      id: 'mention',
      label,
      disabled,
      icon: normalizeNodeForView(
        <Icon name="at" size={AGENT_INPUT_MENU_ICON_SIZE_PX} color={tint} />,
      ),
      onPress: () => {
        if (disabled) return;
        dismiss();
        onMention();
      },
    }),
    render: ({
      chipStyle,
      iconColor,
      showLabel,
      textStyle,
      countTextStyle,
      chipAnchorRef,
    }) => (
      <Pressable
        ref={chipAnchorRef}
        testID="agent-input-mention-chip"
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={disabled}
        onPress={disabled ? undefined : onMention}
        hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
        style={({ pressed }) => chipStyle(Boolean(pressed))}
      >
        {normalizeNodeForView(
          <Icon
            name="at"
            size={AGENT_INPUT_CHIP_ICON_SIZE_PX}
            color={iconColor}
            style={AGENT_INPUT_CHIP_ICON_STYLE}
          />,
        )}
        {showLabel ? (
          <AgentInputChipLabel
            label={label}
            textStyle={textStyle}
            countTextStyle={countTextStyle}
          />
        ) : null}
      </Pressable>
    ),
  };
}
