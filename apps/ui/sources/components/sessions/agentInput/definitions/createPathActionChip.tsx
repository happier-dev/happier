import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export function createPathActionChip(params: Readonly<{
    currentPath?: string | null;
    tint: string;
    showLabel: boolean;
    chipStyle: (pressed: boolean) => any;
    textStyle: any;
    onPress: () => void;
}>): React.ReactNode {
    return (
        <Pressable
            key="path"
            testID="agent-input-path-chip"
            onPress={params.onPress}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            style={(state) => params.chipStyle(state.pressed)}
        >
            <Ionicons name="folder-outline" size={18} color={params.tint} />
            {params.showLabel ? (
                <Text style={params.textStyle}>
                    {typeof params.currentPath === 'string' && params.currentPath.length > 0
                        ? params.currentPath
                        : t('newSession.selectPathTitle')}
                </Text>
            ) : null}
        </Pressable>
    );
}
