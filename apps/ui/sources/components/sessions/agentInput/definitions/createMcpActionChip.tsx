import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputChipLabel } from '@/components/sessions/agentInput/components/AgentInputChipLabel';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';

export function createMcpActionChip(params: Readonly<{
    label: string;
    selectedCount: number;
    onPress: () => void;
}>): AgentInputExtraActionChip {
    return {
        key: 'new-session-mcp',
        controlId: 'mcp',
        collapsedAction: ({ dismiss }) => ({
            id: 'new-session-mcp',
            label: params.label,
            icon: null,
            onPress: () => {
                dismiss();
                params.onPress();
            },
        }),
        render: ({ chipStyle, iconColor, showLabel, textStyle, countTextStyle }) => (
            <Pressable
                testID="new-session-mcp-chip"
                onPress={params.onPress}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={(pressed) => chipStyle(pressed.pressed)}
            >
                {normalizeNodeForView(<Ionicons name="server-outline" size={16} color={iconColor} />)}
                {showLabel ? (
                    <AgentInputChipLabel
                        label={params.label}
                        count={params.selectedCount}
                        textStyle={textStyle}
                        countTextStyle={countTextStyle}
                    />
                ) : null}
            </Pressable>
        ),
    };
}
