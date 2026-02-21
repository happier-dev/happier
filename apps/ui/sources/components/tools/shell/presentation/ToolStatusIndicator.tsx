import * as React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/domains/messages/messageTypes';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
interface ToolStatusIndicatorProps {
    tool: ToolCall;
}

export function ToolStatusIndicator({ tool }: ToolStatusIndicatorProps) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.container}>
            <StatusIndicator state={tool.state} theme={theme} />
        </View>
    );
}

function StatusIndicator({ state, theme }: { state: ToolCall['state']; theme: any }) {
    switch (state) {
        case 'running':
            return <ActivityIndicator size="small" color={theme.colors.accent.blue} />;
        case 'completed':
            return <Ionicons name="checkmark-circle" size={22} color={theme.colors.success} />;
        case 'error':
            return <Ionicons name="close-circle" size={22} color={theme.colors.warningCritical} />;
        default:
            return null;
    }
}

const styles = StyleSheet.create({
    container: {
        width: 22,
        alignItems: 'center',
        justifyContent: 'center',
    },
});
