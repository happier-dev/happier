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

function coerceFilePaths(value: unknown): string[] {
    const parsed = maybeParseJson(value);
    const record = asRecord(parsed) ?? {};

    const list =
        (Array.isArray((record as any).file_paths) ? ((record as any).file_paths as unknown[]) : null) ??
        (Array.isArray((record as any).paths) ? ((record as any).paths as unknown[]) : null) ??
        null;
    if (list) {
        const out = list
            .filter((v): v is string => typeof v === 'string')
            .map((v) => v.trim())
            .filter(Boolean);
        return out;
    }

    const single =
        typeof (record as any).file_path === 'string'
            ? String((record as any).file_path)
            : typeof (record as any).path === 'string'
                ? String((record as any).path)
                : null;
    if (single && single.trim()) return [single.trim()];
    return [];
}

export const DeleteView = React.memo<ToolViewProps>(({ tool, detailLevel }) => {
    const { theme } = useUnistyles();
    const filePaths = coerceFilePaths(tool.input);
    if (filePaths.length === 0) return null;

    const isFullView = detailLevel === 'full';
    const max = isFullView ? 40 : 8;
    const shown = filePaths.slice(0, max);
    const more = filePaths.length - shown.length;

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

