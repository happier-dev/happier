import * as React from 'react';
import { Pressable } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';
import { Icon } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE } from './agentInputChipIconMetrics';

/**
 * New Session's Automation entry.
 *
 * It is navigation, not a second settings editor: pressing it transfers the
 * composed draft to the one shared Automation editor, where triggers, prompt
 * and settings are authored by the same controls every other Automation uses.
 * The source draft stays intact until that destination owns the handoff, so
 * Back or cancel loses nothing.
 */
export function createAutomationEditorActionChip(params: Readonly<{
    label: string;
    onPress: () => void;
}>): AgentInputExtraActionChip {
    return {
        key: 'new-session-automate',
        controlId: 'automation',
        placement: { id: 'automation', title: params.label, icon: 'lightning', defaultPlacement: 'overflow' },
        render: ({ chipStyle, iconColor, showLabel, textStyle, chipAnchorRef }) => (
            <Pressable
                ref={chipAnchorRef}
                testID="new-session-automation-chip"
                accessibilityRole="button"
                accessibilityLabel={params.label}
                onPress={params.onPress}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={({ pressed }) => chipStyle(pressed)}
            >
                {normalizeNodeForView(
                    <Icon
                        name="lightning"
                        size={AGENT_INPUT_CHIP_ICON_SIZE_PX}
                        color={iconColor}
                        style={AGENT_INPUT_CHIP_ICON_STYLE}
                    />,
                )}
                {showLabel ? (
                    <Text numberOfLines={1} style={textStyle}>
                        {params.label}
                    </Text>
                ) : null}
            </Pressable>
        ),
    };
}
