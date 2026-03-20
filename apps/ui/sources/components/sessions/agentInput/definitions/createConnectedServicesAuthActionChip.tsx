import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { AgentInputChipLabel } from '@/components/sessions/agentInput/components/AgentInputChipLabel';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';

export function createConnectedServicesAuthActionChip(params: Readonly<{
    label: string;
    connectedCount: number;
    onPress: () => void;
}>): AgentInputExtraActionChip {
    return {
        key: 'new-session-connected-services-auth',
        controlId: 'connectedServices',
        collapsedAction: ({ tint, dismiss }) => ({
            id: 'connected-services',
            label: params.label,
            icon: normalizeNodeForView(<Ionicons name="key-outline" size={16} color={tint} />),
            onPress: () => {
                dismiss();
                params.onPress();
            },
        }),
        render: ({ chipStyle, iconColor, showLabel, textStyle, countTextStyle }) => (
            <Pressable
                onPress={params.onPress}
                hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                style={(pressed) => chipStyle(pressed.pressed)}
            >
                {normalizeNodeForView(<Ionicons name="key-outline" size={16} color={iconColor} />)}
                {showLabel ? (
                    <AgentInputChipLabel
                        label={params.label}
                        count={params.connectedCount}
                        textStyle={textStyle}
                        countTextStyle={countTextStyle}
                    />
                ) : null}
            </Pressable>
        ),
    };
}
