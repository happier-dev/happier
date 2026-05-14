import * as React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ToolCall } from '@/sync/domains/messages/messageTypes';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { resolveToolStatusIndicatorKind } from '@/components/tools/shell/presentation/resolveToolStatusIndicatorKind';
import type { UnistylesThemes } from 'react-native-unistyles';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
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

type Theme = UnistylesThemes[keyof UnistylesThemes];

function StatusIndicator({ tool, theme }: { tool: ToolCall; theme: Theme }) {
    const kind = resolveToolStatusIndicatorKind(tool);
    switch (kind) {
        case 'permission_pending':
            return <Ionicons name="lock-closed-outline" size={22} color={theme.colors.state.neutral.foreground} />;
        case 'permission_blocked':
            return <Ionicons name="remove-circle-outline" size={22} color={theme.colors.text.secondary} />;
        case 'running':
            return <ActivitySpinner size="small" color={theme.colors.text.secondary} />;
        case 'completed':
            return <Ionicons name="checkmark-circle" size={22} color={theme.colors.state.success.foreground} />;
        case 'error':
            return <Ionicons name="close-circle" size={22} color={theme.colors.state.danger.foreground} />;
        case 'none':
        default:
            return null;
    }
}

const styles = StyleSheet.create(() => ({
    container: {
        width: 22,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
