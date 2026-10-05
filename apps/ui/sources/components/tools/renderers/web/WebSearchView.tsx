import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { maybeParseJson } from '@happier-dev/protocol';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { ToolFindText, useToolFindState } from '../core/ToolFindText';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';


type WebResult = { title?: string; url?: string; snippet?: string };

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function coerceResults(value: unknown): WebResult[] {
    const parsed = maybeParseJson(value);
    const arr = Array.isArray(parsed) ? parsed : null;
    const obj = asRecord(parsed);

    const candidates = arr
        ? arr
        : obj && Array.isArray(obj.results)
            ? obj.results
            : obj && Array.isArray(obj.items)
                ? obj.items
                : null;

    if (!candidates) return [];

    const out: WebResult[] = [];
    for (const item of candidates) {
        if (!item) continue;
        if (typeof item === 'string') {
            out.push({ url: item });
            continue;
        }
        const rec = asRecord(item);
        if (!rec) continue;
        out.push({
            title: typeof rec.title === 'string' ? rec.title : undefined,
            url: typeof rec.url === 'string' ? rec.url : (typeof rec.link === 'string' ? rec.link : undefined),
            snippet: typeof rec.snippet === 'string' ? rec.snippet : (typeof rec.description === 'string' ? rec.description : undefined),
        });
    }
    return out;
}

export const projectWebSearchDisplayText: ToolDisplayTextProjector = (tool) => {
    if (tool.state !== 'completed') return [];
    return coerceResults(tool.result).flatMap((result, index) => [
        ...toolTextBlock(`tool-search-${index}-title`, result.title),
        ...toolTextBlock(`tool-search-${index}-url`, result.url),
        ...toolTextBlock(`tool-search-${index}-snippet`, result.snippet),
    ]);
};

export const WebSearchView = React.memo<ToolViewProps>(({ tool, detailLevel, messageId }) => {
    const find = useToolFindState(messageId);
    if (tool.state !== 'completed') return null;
    const results = coerceResults(tool.result);
    if (results.length === 0) return null;

    // NOTE: `detailLevel` controls how much of the tool output is rendered inline.
    // Summary keeps the timeline compact; full is used for expanded cards and the ToolFullView screen.
    const isFullView = detailLevel === 'full';
    const shown = find.active ? results : results.slice(0, isFullView ? 20 : 5);
    const more = results.length - shown.length;

    return (
        <ToolSectionView fullWidth={isFullView}>
            <View style={styles.container}>
                {shown.map((r, idx) => (
                    <View key={idx} style={styles.row}>
                        {r.title ? <ToolFindText text={r.title} blockId={`tool-search-${idx}-title`} messageId={messageId} style={styles.title} numberOfLines={isFullView ? 3 : 2} /> : null}
                        {r.url ? <ToolFindText text={r.url} blockId={`tool-search-${idx}-url`} messageId={messageId} style={styles.url} numberOfLines={isFullView ? 2 : 1} /> : null}
                        {r.snippet ? <ToolFindText text={r.snippet} blockId={`tool-search-${idx}-snippet`} messageId={messageId} style={styles.snippet} numberOfLines={isFullView ? 6 : 3} /> : null}
                    </View>
                ))}
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
        gap: 12,
    },
    row: {
        gap: 4,
    },
    title: {
        fontSize: 13,
        color: theme.colors.text.primary,
        fontWeight: '500',
    },
    url: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
    snippet: {
        fontSize: 13,
        color: theme.colors.text.primary,
        opacity: 0.9,
    },
    more: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
}));
