import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { maybeParseJson } from '@happier-dev/protocol/activity/parseJson';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';
import { ToolFindText, useToolFindState } from '../core/ToolFindText';


function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function coerceFilePaths(value: unknown): string[] {
    const parsed = maybeParseJson(value);
    const record = asRecord(parsed) ?? {};

    const list =
        (Array.isArray(record.file_paths) ? record.file_paths : null) ??
        (Array.isArray(record.paths) ? record.paths : null) ??
        null;
    if (list) {
        const out = list
            .filter((v): v is string => typeof v === 'string')
            .map((v) => v.trim())
            .filter(Boolean);
        return out;
    }

    const single =
        typeof record.file_path === 'string'
            ? record.file_path
            : typeof record.path === 'string'
                ? record.path
                : null;
    if (single && single.trim()) return [single.trim()];
    return [];
}

export const projectDeleteDisplayText: ToolDisplayTextProjector = (tool) => coerceFilePaths(tool.input)
    .flatMap((text, index) => toolTextBlock(`tool-delete-${index}`, text));

export const DeleteView = React.memo<ToolViewProps>(({ tool, detailLevel, messageId }) => {
    const find = useToolFindState(messageId);
    const { theme } = useUnistyles();
    const filePaths = coerceFilePaths(tool.input);
    if (filePaths.length === 0) return null;

    const isFullView = detailLevel === 'full';
    const max = isFullView ? 40 : 8;
    const shown = find.active ? filePaths : filePaths.slice(0, max);
    const more = filePaths.length - shown.length;

    return (
        <ToolSectionView fullWidth={isFullView}>
            <View style={styles.container}>
                {shown.map((entry, idx) => (
                    <ToolFindText key={`${idx}-${entry}`} text={entry} blockId={`tool-delete-${idx}`} messageId={messageId} style={styles.entry} numberOfLines={isFullView ? 2 : 1} />
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
