import * as React from 'react';
import { View, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/domains/messages/messageTypes';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { resolveToolStatusIndicatorKind } from '@/components/tools/shell/presentation/resolveToolStatusIndicatorKind';
interface ToolStatusIndicatorProps {
    tool: ToolCall;
}

export function ToolStatusIndicator({ tool }: ToolStatusIndicatorProps) {
    const { theme } = useUnistyles();
    return (
        <View style={styles.container}>
            <StatusIndicator tool={tool} theme={theme} />
        </View>
    );
}

function StatusIndicator({ tool, theme }: { tool: ToolCall; theme: any }) {
    const kind = resolveToolStatusIndicatorKind(tool);
    switch (kind) {
        case 'permission_pending':
            return <Ionicons name="lock-closed-outline" size={22} color={theme.colors.warning} />;
        case 'permission_blocked':
            return <Ionicons name="remove-circle-outline" size={22} color={theme.colors.textSecondary} />;
        case 'running':
            return <ActivityIndicator size="small" color={theme.colors.accent.blue} />;
        case 'completed':
            return <Ionicons name="checkmark-circle" size={22} color={theme.colors.success} />;
        case 'error':
            return <Ionicons name="close-circle" size={22} color={theme.colors.warningCritical} />;
        case 'none':
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
