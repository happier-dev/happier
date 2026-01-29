import * as React from 'react';
import { View, Text } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from './_registry';
import { ToolSectionView } from '../ToolSectionView';

export const EnterPlanModeView = React.memo<ToolViewProps>(({ detailLevel }) => {
    if (detailLevel === 'title') return null;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                <Text style={styles.title}>Entered plan mode</Text>
                {detailLevel === 'full' ? (
                    <Text style={styles.body}>
                        The agent will now provide a structured plan before taking action. You can exit plan mode or request changes when ready.
                    </Text>
                ) : null}
            </View>
        </ToolSectionView>
    );
});

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 8,
        paddingVertical: 4,
    },
    title: {
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.text,
    },
    body: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.textSecondary,
    },
}));

