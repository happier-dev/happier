import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';


export const ChangeTitleView = React.memo<ToolViewProps>(({ tool, detailLevel }) => {
    if (detailLevel === 'title') return null;
    const title = typeof (tool.input as any)?.title === 'string' ? (tool.input as any).title : null;
    if (!title || title.trim().length === 0) return null;

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
