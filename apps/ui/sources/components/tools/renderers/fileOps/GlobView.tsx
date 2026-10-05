import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import type { ToolViewProps } from '../core/_registry';
import { coerceToolResultRecord } from '../../legacy/coerceToolResultRecord';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';
import { ToolFindText, useToolFindState } from '../core/ToolFindText';


function getMatches(result: unknown): string[] {
    const record = coerceToolResultRecord(result);
    const matches = record?.matches;
    if (!Array.isArray(matches)) return [];
    return matches.filter((m): m is string => typeof m === 'string');
}

export const projectGlobDisplayText: ToolDisplayTextProjector = (tool) => tool.state === 'completed'
    ? getMatches(tool.result).flatMap((text, index) => toolTextBlock(`tool-glob-${index}`, text)) : [];

export const GlobView = React.memo<ToolViewProps>(({ tool, detailLevel, messageId }) => {
    const find = useToolFindState(messageId);
    const { theme } = useUnistyles();
    if (tool.state !== 'completed') return null;

    const matches = getMatches(tool.result);
    if (matches.length === 0) return null;

    const isFullView = detailLevel === 'full';
    const max = isFullView ? 40 : 8;
    const shown = find.active ? matches : matches.slice(0, max);
    const more = matches.length - shown.length;

    return (
        <ToolSectionView fullWidth={isFullView}>
            <View style={styles.container}>
                {shown.map((path, idx) => (
                    <ToolFindText key={`${idx}-${path}`} text={path} blockId={`tool-glob-${idx}`} messageId={messageId} style={styles.path} numberOfLines={isFullView ? 2 : 1} />
                ))}
                {more > 0 && (
                    <Text style={[styles.path, { color: theme.colors.text.secondary }]}>
                        {t('tools.structuredResult.more', { count: more })}
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
        backgroundColor: theme.colors.surface.inset,
        gap: 6,
    },
    path: {
        fontSize: 13,
        color: theme.colors.text.primary,
        fontFamily: 'Menlo',
    },
}));
