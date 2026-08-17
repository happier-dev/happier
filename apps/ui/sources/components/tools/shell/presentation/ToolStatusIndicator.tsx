import * as React from 'react';
import { View } from 'react-native';
import { ToolCall } from '@/sync/domains/messages/messageTypes';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { resolveToolStatusIndicatorKind } from '@/components/tools/shell/presentation/resolveToolStatusIndicatorKind';
import type { UnistylesThemes } from 'react-native-unistyles';
import { ActivitySpinner, iconMatchedSpinnerSize } from '@/components/ui/feedback/ActivitySpinner';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
// Matches the tool row's own glyphs (16). It was 22, so every tool row rendered its type icon and
// its status icon at two different sizes.
const TOOL_STATUS_ICON_SIZE_PX = ICON_SIZE.sm;

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
            return <Icon name="lock" size={TOOL_STATUS_ICON_SIZE_PX} color={theme.colors.state.neutral.foreground} />;
        case 'permission_blocked':
            return <Icon name="minus-circle" size={TOOL_STATUS_ICON_SIZE_PX} color={theme.colors.text.secondary} />;
        case 'running':
            return <ActivitySpinner size={iconMatchedSpinnerSize(TOOL_STATUS_ICON_SIZE_PX)} color={theme.colors.text.secondary} />;
        case 'completed':
            return <Icon name="check-circle" size={TOOL_STATUS_ICON_SIZE_PX} color={theme.colors.state.success.foreground} />;
        case 'error':
            return <Icon name="x-circle" size={TOOL_STATUS_ICON_SIZE_PX} color={theme.colors.state.danger.foreground} />;
        case 'none':
        default:
            return null;
    }
}

const styles = StyleSheet.create(() => ({
    container: {
        width: TOOL_STATUS_ICON_SIZE_PX,
        alignItems: 'center',
        justifyContent: 'center',
    },
}));
