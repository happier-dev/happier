import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { maybeParseJson } from '@happier-dev/protocol';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';
import { ToolFindText, useToolFindState } from '../core/ToolFindText';


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

export const projectLSDisplayText: ToolDisplayTextProjector = (tool) => tool.state === 'completed'
    ? getEntries(tool.result).flatMap((text, index) => toolTextBlock(`tool-ls-${index}`, text)) : [];

export const LSView = React.memo<ToolViewProps>(({ tool, detailLevel, messageId }) => {
    const find = useToolFindState(messageId);
    const { theme } = useUnistyles();
    if (tool.state !== 'completed') return null;
    const entries = getEntries(tool.result);
    if (entries.length === 0) return null;

    const isFullView = detailLevel === 'full';
    const max = isFullView ? 40 : 8;
    const shown = find.active ? entries : entries.slice(0, max);
    const more = entries.length - shown.length;

    return (
        <ToolSectionView fullWidth={isFullView}>
            <View style={styles.container}>
                {shown.map((entry, idx) => (
                    <ToolFindText key={`${idx}-${entry}`} text={entry} blockId={`tool-ls-${idx}`} messageId={messageId} style={styles.entry} numberOfLines={isFullView ? 2 : 1} />
                ))}
                {more > 0 ? (
                    <Text style={[styles.entry, { color: theme.colors.text.secondary }]}>
                        {t('tools.structuredResult.more', { count: more })}
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
        backgroundColor: theme.colors.surface.inset,
        gap: 6,
    },
    entry: {
        fontSize: 13,
        color: theme.colors.text.primary,
        fontFamily: 'Menlo',
    },
}));
