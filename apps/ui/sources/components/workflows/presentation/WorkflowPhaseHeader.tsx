import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { ToolFindText } from '@/components/tools/renderers/core/ToolFindText';
import { t } from '@/text';
import type { WorkflowPhaseRollup } from '@/components/sessions/workState/sessionWorkflowActivityTypes';

import { formatPhaseRollup } from './workflowPresentation';
import { toolTextBlock } from '@/components/tools/renderers/core/toolDisplayTextTypes';

/**
 * Phase header row (UIW3/UIW4) — phase title + a per-phase status rollup. Primitive props keep the
 * memoized header from re-rendering on unrelated progress. Rollup string is i18n-composed.
 */

export type WorkflowPhaseHeaderProps = Readonly<{
    title?: string;
    fallback?: 'activity';
    rollup: WorkflowPhaseRollup;
    messageId?: string;
    findBlockPrefix?: string;
}>;

function resolvePhaseTitle(props: WorkflowPhaseHeaderProps): string {
    return props.title ?? (props.fallback === 'activity' ? t('tools.workflowActivityView.phaseActivity') : t('tools.workflowActivityView.phaseUntitled'));
}

export function projectWorkflowPhaseDisplayText(props: WorkflowPhaseHeaderProps, prefix: string) {
    return [
        ...toolTextBlock(`${prefix}-title`, resolvePhaseTitle(props)),
        ...toolTextBlock(`${prefix}-rollup`, formatPhaseRollup(props.rollup)),
    ];
}

export const WorkflowPhaseHeader = React.memo<WorkflowPhaseHeaderProps>((props) => {
    const rollupLabel = formatPhaseRollup(props.rollup);
    const title = resolvePhaseTitle(props);
    const prefix = props.findBlockPrefix ?? 'tool-workflow-phase';
    return (
        <View style={styles.header}>
            <ToolFindText messageId={props.messageId} blockId={`${prefix}-title`} text={title} style={styles.title} numberOfLines={1} />
            {rollupLabel ? (
                <ToolFindText messageId={props.messageId} blockId={`${prefix}-rollup`} text={rollupLabel} style={styles.rollup} numberOfLines={1} />
            ) : null}
        </View>
    );
});
WorkflowPhaseHeader.displayName = 'WorkflowPhaseHeader';

const styles = StyleSheet.create((theme) => ({
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: theme.margins.sm,
        minHeight: 28,
        paddingTop: theme.margins.sm,
        paddingBottom: theme.margins.xs,
    },
    title: {
        flexShrink: 1,
        ...Typography.rowTitle(),
        color: theme.colors.text.secondary,
    },
    rollup: {
        ...Typography.timestamp(),
        color: theme.colors.text.secondary,
    },
}));
