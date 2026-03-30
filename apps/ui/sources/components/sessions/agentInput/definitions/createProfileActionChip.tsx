import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, type View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

export function createProfileActionChip(params: Readonly<{
    anchorRef: React.RefObject<View | null>;
    profileIcon: string;
    profileLabel: string | null;
    tint: string;
    showLabel: boolean;
    chipStyle: (pressed: boolean) => any;
    textStyle: any;
    onPress: () => void;
}>): React.ReactNode {
    const testID = 'agent-input-profile-chip';
    return (
        <Pressable
            ref={params.anchorRef}
            testID={testID}
            key="profile"
            onPress={params.onPress}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            style={(state) => params.chipStyle(state.pressed)}
        >
            <Ionicons name={params.profileIcon as never} size={18} color={params.tint} />
            {params.showLabel ? (
                <Text style={params.textStyle}>
                    {params.profileLabel ?? t('profiles.noProfile')}
                </Text>
            ) : null}
        </Pressable>
    );
}
