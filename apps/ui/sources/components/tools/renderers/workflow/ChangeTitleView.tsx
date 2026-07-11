import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { maybeParseJson } from '../../normalization/parse/parseJson';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';


export const ChangeTitleView = React.memo<ToolViewProps>(({ tool, detailLevel }) => {
    if (detailLevel === 'title') return null;
    const title = resolveChangeTitle(tool.input, tool.result);
    if (!title) return null;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                <Text style={styles.label}>{t('tools.changeTitleView.titleLabel')}</Text>
                <Text style={styles.title} numberOfLines={detailLevel === 'full' ? undefined : 2}>
                    {title}
                </Text>
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
