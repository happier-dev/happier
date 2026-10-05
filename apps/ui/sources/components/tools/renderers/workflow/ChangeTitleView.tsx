import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { maybeParseJson } from '@happier-dev/protocol';
import { ToolFindText, useToolFindState } from '../core/ToolFindText';
import { t } from '@/text';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';

export const projectChangeTitleDisplayText: ToolDisplayTextProjector = (tool) => {
    const title = resolveChangeTitle(tool.input, tool.result);
    return [
        ...toolTextBlock('tool-title-label', title ? t('tools.changeTitleView.titleLabel') : null),
        ...toolTextBlock('tool-new-title', title),
    ];
};


export const ChangeTitleView = React.memo<ToolViewProps>(({ tool, detailLevel, messageId }) => {
    const find = useToolFindState(messageId);
    if (detailLevel === 'title' && !find.active) return null;
    const title = resolveChangeTitle(tool.input, tool.result);
    if (!title) return null;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                <ToolFindText messageId={messageId} blockId="tool-title-label" text={t('tools.changeTitleView.titleLabel')} style={styles.label} />
                <ToolFindText messageId={messageId} blockId="tool-new-title" text={title} style={styles.title} numberOfLines={detailLevel === 'full' ? undefined : 2} />
            </View>
        </ToolSectionView>
    );
});

function resolveChangeTitle(input: unknown, result: unknown): string | null {
    return readNonEmptyTitle(input) ?? readNonEmptyTitle(result);
}

function readNonEmptyTitle(value: unknown, depth = 0): string | null {
    const parsed = maybeParseJson(value);
    if (!parsed || typeof parsed !== 'object') return null;

    const record = parsed as { output?: unknown; title?: unknown };
    if (typeof record.title === 'string' && record.title.trim().length > 0) {
        return record.title;
    }

    return depth === 0 && record.output !== undefined ? readNonEmptyTitle(record.output, depth + 1) : null;
}

const styles = StyleSheet.create((theme) => ({
    container: {
        padding: 12,
        borderRadius: 8,
        backgroundColor: theme.colors.surface.inset,
        gap: 6,
    },
    label: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
    title: {
        fontSize: 14,
        color: theme.colors.text.primary,
        fontWeight: '600',
    },
}));
