import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { Pressable, type View } from 'react-native';

import { AgentInputChipLabel } from '@/components/sessions/agentInput/components/AgentInputChipLabel';
import { t } from '@/text';

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
            <Ionicons name="list-outline" size={18} color={params.tint} />
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
