import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';

export function createServerActionChip(params: Readonly<{
    label: string;
    onPress: () => void;
}>): AgentInputExtraActionChip {
    return {
        key: 'new-session-target-server',
        controlId: 'server',
        collapsedAction: ({ tint, dismiss }) => ({
            id: 'new-session-target-server',
            label: params.label,
            icon: <Ionicons name="server-outline" size={16} color={tint} />,
            onPress: () => {
                dismiss();
                params.onPress();
            },
        }),
        render: ({ chipStyle, iconColor, showLabel, textStyle }) => (
            <Pressable
                onPress={params.onPress}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={(pressed) => chipStyle(pressed.pressed)}
            >
                {normalizeNodeForView(<Ionicons name="server-outline" size={16} color={iconColor} />)}
                {showLabel ? (
                    <Text numberOfLines={1} style={textStyle}>
                        {params.label}
                    </Text>
                ) : null}
            </Pressable>
        ),
    };
}
