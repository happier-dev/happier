import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { coerceToolResultRecord } from '../../legacy/coerceToolResultRecord';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';


function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

type SearchMatch = { filePath?: string; line?: number; excerpt?: string };

type SearchSummary = Readonly<{
    detailsUnavailable: boolean;
    explicitZero: boolean;
}>;

function getMatches(result: unknown): SearchMatch[] {
    const record = coerceToolResultRecord(result);
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

function readSearchSummary(result: unknown, matches: readonly SearchMatch[]): SearchSummary {
    const record = coerceToolResultRecord(result);
    const aggregateCounts = [record?.totalMatches, record?.totalFiles]
        .filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
    return {
        // `matchDetailsUnavailable` is the short-lived producer alias from the
        // initial dev port. Keep it read-compatible for already materialized rows;
        // new CLI normalization writes the canonical `detailsUnavailable` field.
        detailsUnavailable: record?.detailsUnavailable === true || record?.matchDetailsUnavailable === true,
        explicitZero: matches.length === 0 && aggregateCounts.length > 0 && aggregateCounts.every((count) => count === 0),
    };
}

export const CodeSearchView = React.memo<ToolViewProps>(({ tool, detailLevel }) => {
    if (tool.state !== 'completed') return null;
    const matches = getMatches(tool.result);
    const summary = readSearchSummary(tool.result, matches);
    if (matches.length === 0 && !summary.detailsUnavailable && !summary.explicitZero) return null;

    const isFullView = detailLevel === 'full';
    const shown = matches.slice(0, isFullView ? 20 : 6);
    const more = matches.length - shown.length;

    return (
        <ToolSectionView fullWidth={isFullView}>
            <View style={styles.container}>
                {summary.detailsUnavailable ? <Text style={styles.summary}>{t('tools.workflowActivityView.unavailable')}</Text> : null}
                {summary.explicitZero ? <Text style={styles.summary}>{t('common.noMatches')}</Text> : null}
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
                {more > 0 ? <Text style={styles.more}>{t('tools.structuredResult.more', { count: more })}</Text> : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.inset,
        gap: 10,
    },
    summary: {
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
    row: {
        gap: 4,
    },
    label: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
    text: {
        fontSize: 13,
        color: theme.colors.text.primary,
        fontFamily: 'Menlo',
    },
    more: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
}));
