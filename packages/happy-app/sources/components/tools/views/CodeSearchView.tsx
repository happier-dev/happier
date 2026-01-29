import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from './_registry';
import { ToolSectionView } from '../ToolSectionView';
import { maybeParseJson } from '../utils/parseJson';

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

type SearchMatch = { filePath?: string; line?: number; excerpt?: string };

function getMatches(result: unknown): SearchMatch[] {
    const parsed = maybeParseJson(result);
    const record = asRecord(parsed);
    const matches = record?.matches;
    if (!Array.isArray(matches)) return [];

    const out: SearchMatch[] = [];
    for (const item of matches) {
        const obj = asRecord(item);
        if (!obj) continue;
        out.push({
            filePath: typeof (obj as any).filePath === 'string' ? (obj as any).filePath : undefined,
            line: typeof (obj as any).line === 'number' ? (obj as any).line : undefined,
            excerpt: typeof (obj as any).excerpt === 'string' ? (obj as any).excerpt : undefined,
        });
    }
    return out;
}

export const CodeSearchView = React.memo<ToolViewProps>(({ tool, detailLevel }) => {
    if (tool.state !== 'completed') return null;
    const matches = getMatches(tool.result);
    if (matches.length === 0) return null;

    const isFullView = detailLevel === 'full';
    const shown = matches.slice(0, isFullView ? 20 : 6);
    const more = matches.length - shown.length;

    return (
        <ToolSectionView fullWidth={isFullView}>
            <View style={styles.container}>
                {shown.map((m, idx) => {
                    const label = m.filePath
                        ? `${m.filePath}${typeof m.line === 'number' ? `:${m.line}` : ''}`
                        : null;
                    return (
                        <View key={idx} style={styles.row}>
                            {label ? <Text style={styles.label} numberOfLines={isFullView ? 2 : 1}>{label}</Text> : null}
                            {m.excerpt ? <Text style={styles.text} numberOfLines={isFullView ? 6 : 2}>{m.excerpt}</Text> : null}
                        </View>
                    );
                })}
                {more > 0 ? <Text style={styles.more}>+{more} more</Text> : null}
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
    row: {
        gap: 4,
    },
    label: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'Menlo',
    },
    text: {
        fontSize: 13,
        color: theme.colors.text,
        fontFamily: 'Menlo',
    },
    more: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'Menlo',
    },
}));
