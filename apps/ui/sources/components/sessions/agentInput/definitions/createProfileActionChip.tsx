import * as React from 'react';
import { Pressable, type View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE } from './agentInputChipIconMetrics';

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
            <Icon name={params.profileIcon as never} size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={params.tint} style={AGENT_INPUT_CHIP_ICON_STYLE} />
            {params.showLabel ? (
                <Text style={params.textStyle}>
                    {params.profileLabel ?? t('profiles.noProfile')}
                </Text>
            ) : null}
        </Pressable>
    );
}
