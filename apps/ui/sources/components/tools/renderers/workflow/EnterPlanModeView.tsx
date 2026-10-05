import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ToolViewProps } from '../core/_registry';
import { ToolSectionView } from '../../shell/presentation/ToolSectionView';
import { ToolFindText, useToolFindState } from '../core/ToolFindText';
import { t } from '@/text';
import { toolTextBlock, type ToolDisplayTextProjector } from '../core/toolDisplayTextTypes';

export const projectEnterPlanModeDisplayText: ToolDisplayTextProjector = () => [
    ...toolTextBlock('tool-plan-title', t('tools.enterPlanMode.title')),
    ...toolTextBlock('tool-plan-body', t('tools.enterPlanMode.body')),
];


export const EnterPlanModeView = React.memo<ToolViewProps>(({ detailLevel, messageId }) => {
    const find = useToolFindState(messageId);
    if (detailLevel === 'title' && !find.active) return null;

    return (
        <ToolSectionView>
            <View style={styles.container}>
                <ToolFindText messageId={messageId} blockId="tool-plan-title" text={t('tools.enterPlanMode.title')} style={styles.title} />
                {detailLevel === 'full' || find.active ? (
                    <ToolFindText messageId={messageId} blockId="tool-plan-body" text={t('tools.enterPlanMode.body')} style={styles.body} />
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
