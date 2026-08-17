import * as React from 'react';
import { Pressable, type View } from 'react-native';

import { AgentInputChipLabel } from '@/components/sessions/agentInput/components/AgentInputChipLabel';
import { t } from '@/text';
import { Icon } from '@/components/ui/icons/Icon';
import { AGENT_INPUT_CHIP_ICON_SIZE_PX, AGENT_INPUT_CHIP_ICON_STYLE } from './agentInputChipIconMetrics';

export function createEnvVarsActionChip(params: Readonly<{
    anchorRef: React.RefObject<View | null>;
    tint: string;
    showLabel: boolean;
    count?: number;
    chipStyle: (pressed: boolean) => any;
    textStyle: any;
    countTextStyle: any;
    onPress: () => void;
}>): React.ReactNode {
    return (
        <Pressable
            ref={params.anchorRef}
            testID="agent-input-env-vars-chip"
            key="envVars"
            onPress={params.onPress}
            hitSlop={{ top: 5, bottom: 10, left: 0, right: 0 }}
            style={(state) => params.chipStyle(state.pressed)}
        >
            <Icon name="list" size={AGENT_INPUT_CHIP_ICON_SIZE_PX} color={params.tint} style={AGENT_INPUT_CHIP_ICON_STYLE} />
            {params.showLabel ? (
                <AgentInputChipLabel
                    label={t('agentInput.envVars.title')}
                    count={params.count}
                    textStyle={params.textStyle}
                    countTextStyle={params.countTextStyle}
                />
            ) : null}
        </Pressable>
    );
}
