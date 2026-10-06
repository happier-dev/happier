import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { MeterBar } from '@/components/ui/lists/MeterBar';
import { ToolFindText } from '@/components/tools/renderers/core/ToolFindText';
import { t } from '@/text';
import {
    resolveWorkflowMeterTone,
    resolveWorkflowProgressFraction,
} from './workflowPresentation';
import type { WorkflowPhaseRollup } from '@/components/sessions/workState/sessionWorkflowActivityTypes';
import type { SessionWorkflowRunStatusV1 } from '@happier-dev/protocol';

import { WorkflowStatusIcon } from './workflowStatusIcon';
import { Icon } from '@/components/ui/icons/Icon';
import { toolTextBlock } from '@/components/tools/renderers/core/toolDisplayTextTypes';

/**
 * Run header shared by the transcript card (UIW4) and popover run panel (UIW3): workflow icon,
 * title, status, agent fraction, and a progress meter. Theme-driven, primitive props.
 */

export type WorkflowRunHeaderProps = Readonly<{
    title: string;
    status: SessionWorkflowRunStatusV1;
    statusLabel: string;
    completedAgents: number;
    totalAgents: number;
    rollup: WorkflowPhaseRollup;
    /** Optional one-line summary, e.g. `Phase 2 of 3 · 3/5 agents · 45.2K tokens · 2m 15s`. */
    summaryLine?: string;
    /** Present only when the header is acting as a collapsible control. */
    expanded?: boolean;
    messageId?: string;
}>;

function resolveSummary(props: WorkflowRunHeaderProps): string | undefined {
    return props.summaryLine ?? (props.totalAgents > 0
        ? t('tools.workflowActivityView.agentFraction', { complete: props.completedAgents, total: props.totalAgents })
        : undefined);
}

export function projectWorkflowRunHeaderDisplayText(props: WorkflowRunHeaderProps) {
    return [
        ...toolTextBlock('tool-workflow-title', props.title),
        ...toolTextBlock('tool-workflow-status', props.statusLabel),
        ...toolTextBlock('tool-workflow-summary', resolveSummary(props)),
    ];
}

export const WorkflowRunHeader = React.memo<WorkflowRunHeaderProps>((props) => {
    const { theme } = useUnistyles();
    const meterTone = resolveWorkflowMeterTone(props.rollup);
    const fraction = resolveWorkflowProgressFraction(props);

    return (
        <View style={styles.container}>
            <View style={styles.headerRow}>
                <Icon name="graph" size={16} color={theme.colors.text.secondary} />
                <ToolFindText messageId={props.messageId} blockId="tool-workflow-title" text={props.title} style={styles.title} numberOfLines={1} />
                <View style={styles.statusBadge}>
                    <WorkflowStatusIcon status={props.status} size={14} />
                    <ToolFindText messageId={props.messageId} blockId="tool-workflow-status" text={props.statusLabel} style={styles.statusLabel} numberOfLines={1} />
                </View>
                {typeof props.expanded === 'boolean' ? (
                    <Icon
                        name={props.expanded ? 'caret-up' : 'caret-down'}
                        size={14}
                        color={theme.colors.text.secondary}
                    />
                ) : null}
            </View>
            {props.totalAgents > 0 ? (
                <MeterBar
                    tone={meterTone}
                    fillFraction={fraction}
                    caption={
                        <ToolFindText messageId={props.messageId} blockId="tool-workflow-summary" text={resolveSummary(props) ?? ''} style={styles.summary} numberOfLines={1} />
                    }
                />
            ) : props.summaryLine ? (
                <ToolFindText messageId={props.messageId} blockId="tool-workflow-summary" text={props.summaryLine} style={styles.summary} numberOfLines={1} />
            ) : null}
        </View>
    );
});
WorkflowRunHeader.displayName = 'WorkflowRunHeader';

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: theme.margins.xs,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.xs,
    },
    title: {
        flex: 1,
        ...Typography.rowTitle(),
        color: theme.colors.text.primary,
    },
    statusBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.margins.xs,
    },
    statusLabel: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
    summary: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
}));
