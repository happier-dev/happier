import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from './_registry';
import { ToolSectionView } from '../ToolSectionView';

export const ChangeTitleView = React.memo<ToolViewProps>(({ tool, detailLevel }) => {
    if (detailLevel === 'title') return null;
    const title = typeof (tool.input as any)?.title === 'string' ? (tool.input as any).title : null;
    if (!title || title.trim().length === 0) return null;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                <Text style={styles.label}>Title</Text>
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
        backgroundColor: theme.colors.surfaceHigh,
        gap: 6,
    },
    label: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        fontFamily: 'Menlo',
    },
    title: {
        fontSize: 14,
        color: theme.colors.text,
        fontWeight: '600',
    },
}));
