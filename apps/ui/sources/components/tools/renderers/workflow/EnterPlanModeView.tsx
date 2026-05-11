import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';


export const EnterPlanModeView = React.memo<ToolViewProps>(({ detailLevel }) => {
    if (detailLevel === 'title') return null;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                <Text style={styles.title}>{t('tools.enterPlanMode.title')}</Text>
                {detailLevel === 'full' ? (
                    <Text style={styles.body}>
                        {t('tools.enterPlanMode.body')}
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
        color: theme.colors.text.primary,
    },
    body: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
}));
