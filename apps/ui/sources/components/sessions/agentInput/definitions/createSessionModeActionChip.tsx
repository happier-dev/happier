import * as React from 'react';
import { Pressable, type View } from 'react-native';

import { Text } from '@/components/ui/text/Text';
import { ICON_SIZE, Icon, type IconName } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE } from './agentInputChipIconMetrics';

export function createSessionModeActionChip(params: Readonly<{
    anchorRef: React.RefObject<View | null>;
    tint: string;
    showLabel: boolean;
    label: string;
    labelTestID?: string;
    accessibilityLabel: string;
    chipStyle: (pressed: boolean) => any;
    textStyle: any;
    iconName?: IconName;
    onPress: () => void;
}>): React.ReactNode {
    const testID = 'agent-input-session-mode-chip';
    return (
        <Pressable
            ref={params.anchorRef}
            testID={testID}
            key="mode"
            onPress={params.onPress}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            style={(state) => params.chipStyle(state.pressed)}
            accessibilityRole="button"
            accessibilityLabel={params.accessibilityLabel}
        >
            <Icon name={params.iconName ?? 'list'} size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={params.tint} style={AGENT_INPUT_CHIP_ICON_STYLE} />
            {params.showLabel ? (
                <Text testID={params.labelTestID} style={params.textStyle}>{params.label}</Text>
            ) : null}
        </Pressable>
    );
}
