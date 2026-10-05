import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import type { ToolViewProps } from '../core/_registry';
import { coerceToolResultRecord } from '../../legacy/coerceToolResultRecord';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';
import { ToolFindText, useToolFindState } from '../core/ToolFindText';


type GrepMatch = { filePath?: string; line?: number; excerpt?: string };

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function getMatches(result: unknown): GrepMatch[] {
    const record = coerceToolResultRecord(result);
    const matches = record?.matches;
    if (!Array.isArray(matches)) return [];

    const out: GrepMatch[] = [];
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

function matchLabel(match: GrepMatch) {
    return match.filePath ? `${match.filePath}${typeof match.line === 'number' ? `:${match.line}` : ''}` : null;
}

export const projectGrepDisplayText: ToolDisplayTextProjector = (tool) => tool.state === 'completed' ? getMatches(tool.result).flatMap((match, index) => [
    ...toolTextBlock(`tool-grep-${index}-label`, matchLabel(match)),
    ...toolTextBlock(`tool-grep-${index}-excerpt`, match.excerpt),
]) : [];

export const GrepView = React.memo<ToolViewProps>(({ tool, detailLevel, messageId }) => {
    const find = useToolFindState(messageId);
    if (tool.state !== 'completed') return null;
    const matches = getMatches(tool.result);
    if (matches.length === 0) return null;

    const isFullView = detailLevel === 'full';
    const max = isFullView ? 24 : 6;
    const shown = find.active ? matches : matches.slice(0, max);
    const more = matches.length - shown.length;

    return (
        <ToolSectionView fullWidth={isFullView}>
            <View style={styles.container}>
                {shown.map((m, idx) => {
                    const label = matchLabel(m);
                    return (
                        <View key={idx} style={styles.row}>
                            {label ? <ToolFindText text={label} blockId={`tool-grep-${idx}-label`} messageId={messageId} style={styles.label} numberOfLines={isFullView ? 2 : 1} /> : null}
                            {m.excerpt ? <ToolFindText text={m.excerpt} blockId={`tool-grep-${idx}-excerpt`} messageId={messageId} style={styles.text} numberOfLines={isFullView ? 6 : 2} /> : null}
                        </View>
                    );
                })}
                {more > 0 && <Text style={styles.more}>{t('tools.structuredResult.more', { count: more })}</Text>}
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
