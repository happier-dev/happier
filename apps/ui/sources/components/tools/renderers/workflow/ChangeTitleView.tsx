import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { glassContentFill } from '@/components/ui/glass/glassSurfacePaint';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { maybeParseJson } from '@happier-dev/protocol/activity/parseJson';
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
        padding: theme.space.s12,
        borderRadius: 8,
        backgroundColor: glassContentFill(theme.colors.surface.inset, theme.colors, { nested: true }),
        gap: theme.space.s6,
    },
    label: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        fontFamily: 'Menlo',
    },
    title: {
        ...Typography.variant('label', 'semiBold'),
        color: theme.colors.text.primary,
    },
}));
