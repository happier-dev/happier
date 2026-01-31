import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ToolViewProps } from './_registry';
import { ToolSectionView } from '../ToolSectionView';
import { maybeParseJson } from '../utils/parseJson';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function getEntries(result: unknown): string[] {
    const parsed = maybeParseJson(result);
    const record = asRecord(parsed);
    const entries = record?.entries;
    if (!Array.isArray(entries)) return [];
    return entries.filter((e): e is string => typeof e === 'string');
}

export const LSView = React.memo<ToolViewProps>(({ tool, detailLevel }) => {
    const { theme } = useUnistyles();
    if (tool.state !== 'completed') return null;
    const entries = getEntries(tool.result);
    if (entries.length === 0) return null;

    const isFullView = detailLevel === 'full';
    const max = isFullView ? 40 : 8;
    const shown = entries.slice(0, max);
    const more = entries.length - shown.length;

    return (
        <ToolSectionView fullWidth={isFullView}>
            <View style={styles.container}>
                {shown.map((entry, idx) => (
                    <Text key={`${idx}-${entry}`} style={styles.entry} numberOfLines={isFullView ? 2 : 1}>
                        {entry}
                    </Text>
                ))}
                {more > 0 ? (
                    <Text style={[styles.entry, { color: theme.colors.textSecondary }]}>
                        +{more} more
                    </Text>
                ) : null}
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
    entry: {
        fontSize: 13,
        color: theme.colors.text,
        fontFamily: 'Menlo',
    },
}));
