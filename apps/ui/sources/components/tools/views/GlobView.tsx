import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolSectionView } from '../ToolSectionView';
import type { ToolViewProps } from './_registry';
import { coerceToolResultRecord } from '../legacy/coerceToolResultRecord';

function getMatches(result: unknown): string[] {
    const record = coerceToolResultRecord(result);
    const matches = record?.matches;
    if (!Array.isArray(matches)) return [];
    return matches.filter((m): m is string => typeof m === 'string');
}

export const GlobView = React.memo<ToolViewProps>(({ tool, detailLevel }) => {
    const { theme } = useUnistyles();
    if (tool.state !== 'completed') return null;

    const matches = getMatches(tool.result);
    if (matches.length === 0) return null;

    const isFullView = detailLevel === 'full';
    const max = isFullView ? 40 : 8;
    const shown = matches.slice(0, max);
    const more = matches.length - shown.length;

    return (
        <ToolSectionView fullWidth={isFullView}>
            <View style={styles.container}>
                {shown.map((path, idx) => (
                    <Text key={`${idx}-${path}`} style={styles.path} numberOfLines={isFullView ? 2 : 1}>
                        {path}
                    </Text>
                ))}
                {more > 0 && (
                    <Text style={[styles.path, { color: theme.colors.textSecondary }]}>
                        +{more} more
                    </Text>
                )}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surfaceHigh,
        gap: 6,
    },
    path: {
        fontSize: 13,
        color: theme.colors.text,
        fontFamily: 'Menlo',
    },
}));
