import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import type { ToolViewProps } from '@/components/tools/renderers/core/_registry';
import { ToolSectionView } from '@/components/tools/shell/presentation/ToolSectionView';
import { CodeView } from '@/components/ui/media/CodeView';
import { Text } from '@/components/ui/text/Text';

function formatToolTitle(name: string): string {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) return 'Tool';
    return trimmed
        .replace(/_/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .replace(/\s+/g, ' ')
        .trim();
}

function toCode(value: unknown): string {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    if (typeof value === 'string') return value;
    try {
        return JSON.stringify(value, null, 2);
    } catch {
        try {
            return String(value);
        } catch {
            return '[unprintable]';
        }
    }
}

export const AgentTeamView = React.memo<ToolViewProps>(({ tool }) => {
    const hasInput = tool.input !== undefined && tool.input !== null;
    const hasResult = tool.result !== undefined && tool.result !== null;
    if (!hasInput && !hasResult) return null;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                <Text style={styles.title}>{formatToolTitle(tool.name)}</Text>
                {hasInput ? <CodeView code={toCode(tool.input)} /> : null}
                {hasResult ? <CodeView code={toCode(tool.result)} /> : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHigh,
        gap: 10,
    },
    title: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
    },
}));
