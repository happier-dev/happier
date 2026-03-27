import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, type View } from 'react-native';

import { normalizeNodeForView } from '@/components/ui/rendering/normalizeNodeForView';
import { Text } from '@/components/ui/text/Text';

export function createPermissionActionChip(params: Readonly<{
    anchorRef: React.RefObject<View | null>;
    tint: string;
    showLabel: boolean;
    label: string | null;
    chipStyle: (pressed: boolean) => any;
    textStyle: any;
    onPress: () => void;
}>): React.ReactNode {
    const testID = 'agent-input-permission-chip';
    return (
        <Pressable
            ref={params.anchorRef}
            key="permission"
            testID={testID}
            onPress={params.onPress}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            style={(state) => params.chipStyle(state.pressed)}
        >
            {normalizeNodeForView(<Ionicons name="shield-checkmark-outline" size={18} color={params.tint} />)}
            {params.showLabel && params.label ? (
                <Text style={params.textStyle}>{params.label}</Text>
            ) : null}
        </Pressable>
    );
}
