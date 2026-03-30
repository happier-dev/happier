import * as React from 'react';
import { Octicons } from '@expo/vector-icons';
import { Pressable, type View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export function createActionMenuTriggerChip(params: Readonly<{
    anchorRef: React.RefObject<View | null>;
    tint: string;
    showLabel: boolean;
    chipStyle: (pressed: boolean) => any;
    textStyle: any;
    onPress: () => void;
}>): React.ReactNode {
    return (
        <Pressable
            ref={params.anchorRef}
            key="action-menu"
            testID="agent-input-action-menu-button"
            onPress={params.onPress}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            style={(state) => params.chipStyle(state.pressed)}
        >
            <Octicons name="gear" size={16} color={params.tint} />
            {params.showLabel ? (
                <Text style={params.textStyle}>{t('agentInput.actionMenu.title')}</Text>
            ) : null}
        </Pressable>
    );
}
