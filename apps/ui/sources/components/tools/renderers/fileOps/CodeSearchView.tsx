import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { coerceToolResultRecord } from '../../legacy/coerceToolResultRecord';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';
import { ToolFindText, useToolFindState } from '../core/ToolFindText';


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
            filePath: typeof obj.filePath === 'string' ? obj.filePath : undefined,
            line: typeof obj.line === 'number' ? obj.line : undefined,
            excerpt: typeof obj.excerpt === 'string' ? obj.excerpt : undefined,
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

function matchLabel(match: SearchMatch) {
    return match.filePath ? `${match.filePath}${typeof match.line === 'number' ? `:${match.line}` : ''}` : null;
}

export const projectCodeSearchDisplayText: ToolDisplayTextProjector = (tool) => {
    if (tool.state !== 'completed') return [];
    const matches = getMatches(tool.result);
    const summary = readSearchSummary(tool.result, matches);
    return [
        ...toolTextBlock('tool-code-search-unavailable', summary.detailsUnavailable ? t('tools.workflowActivityView.unavailable') : null),
        ...toolTextBlock('tool-code-search-zero', summary.explicitZero ? t('common.noMatches') : null),
        ...matches.flatMap((match, index) => [
            ...toolTextBlock(`tool-code-search-${index}-label`, matchLabel(match)),
            ...toolTextBlock(`tool-code-search-${index}-excerpt`, match.excerpt),
        ]),
    ];
};

export const CodeSearchView = React.memo<ToolViewProps>(({ tool, detailLevel, messageId }) => {
    const find = useToolFindState(messageId);
    if (tool.state !== 'completed') return null;
    const matches = getMatches(tool.result);
    const summary = readSearchSummary(tool.result, matches);
    if (matches.length === 0 && !summary.detailsUnavailable && !summary.explicitZero) return null;

    const isFullView = detailLevel === 'full';
    const shown = find.active ? matches : matches.slice(0, isFullView ? 20 : 6);
    const more = matches.length - shown.length;

    return (
        <ToolSectionView fullWidth={isFullView}>
            <View style={styles.container}>
                {summary.detailsUnavailable ? <ToolFindText text={t('tools.workflowActivityView.unavailable')} blockId="tool-code-search-unavailable" messageId={messageId} style={styles.summary} /> : null}
                {summary.explicitZero ? <ToolFindText text={t('common.noMatches')} blockId="tool-code-search-zero" messageId={messageId} style={styles.summary} /> : null}
                {shown.map((m, idx) => {
                    const label = matchLabel(m);
                    return (
                        <View key={idx} style={styles.row}>
                            {label ? <ToolFindText text={label} blockId={`tool-code-search-${idx}-label`} messageId={messageId} style={styles.label} numberOfLines={isFullView ? 2 : 1} /> : null}
                            {m.excerpt ? <ToolFindText text={m.excerpt} blockId={`tool-code-search-${idx}-excerpt`} messageId={messageId} style={styles.text} numberOfLines={isFullView ? 6 : 2} /> : null}
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
