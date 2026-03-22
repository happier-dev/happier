import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, type View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { t } from '@/text';

function truncateWithEllipsis(value: string, maxChars: number) {
    if (value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}…`;
}

export function createMachineActionChip(params: Readonly<{
    anchorRef: React.RefObject<View | null>;
    machineName?: string | null;
    tint: string;
    showLabel: boolean;
    chipStyle: (pressed: boolean) => any;
    textStyle: any;
    onPress: () => void;
}>): React.ReactNode {
    return (
        <Pressable
            ref={params.anchorRef}
            key="machine"
            testID="agent-input-machine-chip"
            onPress={params.onPress}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            style={(state) => params.chipStyle(state.pressed)}
        >
            {normalizeNodeForView(<Ionicons name="desktop-outline" size={18} color={params.tint} />)}
            {params.showLabel ? (
                <Text style={params.textStyle}>
                    {params.machineName === null
                        ? t('agentInput.noMachinesAvailable')
                        : (typeof params.machineName === 'string'
                            ? truncateWithEllipsis(params.machineName, 12)
                            : t('newSession.selectMachineTitle'))}
                </Text>
            ) : null}
        </Pressable>
    );
}
