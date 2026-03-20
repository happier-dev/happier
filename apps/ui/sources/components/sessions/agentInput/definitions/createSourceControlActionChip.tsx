import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { AgentInputSourceControlStatusButton } from '../components/AgentInputSourceControlStatusButton';

export function createSourceControlActionChip(params: Readonly<{
    sessionId?: string;
    onPress?: () => void;
    compact: boolean;
    wrapperStyle: StyleProp<ViewStyle>;
}>): React.ReactNode {
    return (
        <View key="git" style={params.wrapperStyle}>
            <AgentInputSourceControlStatusButton
                sessionId={params.sessionId}
                onPress={params.onPress}
                compact={params.compact}
            />
        </View>
    );
}
