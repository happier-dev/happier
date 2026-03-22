import React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';

type ShortcutChipLayout = 'inline' | 'row';

export function createAgentInputActionShortcutChip(params: Readonly<{
    key: string;
    label: string;
    onPress: () => void;
    layout?: ShortcutChipLayout;
}>): AgentInputExtraActionChip {
    const layout = params.layout ?? 'inline';

    return {
        key: params.key,
        controlId: 'shortcuts',
        collapsedAction: ({ dismiss }) => ({
            id: params.key,
            label: params.label,
            icon: null,
            onPress: () => {
                dismiss();
                params.onPress();
            },
        }),
        render: ({ chipStyle, iconColor, showLabel, textStyle }) => {
            const iconNode = normalizeNodeForView(<Ionicons name="flash-outline" size={16} color={iconColor} />);
            const labelNode = showLabel ? (
                <Text numberOfLines={1} style={textStyle}>
                    {params.label}
                </Text>
            ) : null;

            return (
                <Pressable
                    onPress={params.onPress}
                    hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
                    style={(pressableState) => chipStyle(pressableState.pressed)}
                >
                    {layout === 'row' ? (
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                            {iconNode}
                            {labelNode}
                        </View>
                    ) : (
                        <>
                            {iconNode}
                            {labelNode}
                        </>
                    )}
                </Pressable>
            );
        },
    };
}
