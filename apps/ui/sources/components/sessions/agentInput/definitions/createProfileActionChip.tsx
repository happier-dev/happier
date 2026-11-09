import * as React from 'react';
import { type View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE } from './agentInputChipIconMetrics';
import { AgentInputRailChip } from '@/components/sessions/agentInput/definitions/agentInputChipRowReach';

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
        <AgentInputRailChip
            ref={params.anchorRef}
            testID={testID}
            key="profile"
            onPress={params.onPress}
            style={params.chipStyle}
        >
            <Icon name={params.profileIcon as never} size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={params.tint} style={AGENT_INPUT_CHIP_ICON_STYLE} />
            {params.showLabel ? (
                <Text style={params.textStyle}>
                    {params.profileLabel ?? t('profiles.noProfile')}
                </Text>
            ) : null}
        </AgentInputRailChip>
    );
}
