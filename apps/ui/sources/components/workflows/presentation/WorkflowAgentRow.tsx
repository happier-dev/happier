import { Typography } from '@/constants/Typography';
import * as React from 'react';
import { Platform, View } from 'react-native';
import { HappierPressable, HAPPIER_PRESS_FEEDBACK_V1 } from '@happier-dev/plugin-ui/presentation';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { resolveMinimumInteractiveTargetSize } from '@/components/ui/interactiveTargetSize';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ToolFindText, useToolFindState } from '@/components/tools/renderers/core/ToolFindText';
import { t } from '@/text';
import type { SessionWorkflowAgentStatusV1 } from '@happier-dev/protocol';
import { formatTokenCount } from '@/utils/format/usageNumbers';
import { useTranscriptRowLayoutMutation } from '@/components/sessions/transcript/measurement/TranscriptRowLayoutMutationContext';

import { WorkflowAgentDetail } from './WorkflowAgentDetail';
import { WorkflowStatusIcon } from './workflowStatusIcon';
import { Icon } from '@/components/ui/icons/Icon';
import { normalizeResultPreview } from './resultPreview';
import { toolTextBlock } from '@/components/tools/renderers/core/toolDisplayTextTypes';

/**
 * One workflow agent row (UIW3/UIW4). Props are PRIMITIVE so this memoized row re-renders only when
 * its own status/metrics change — concurrent workflows' progress ticks must not re-render unrelated
 * rows. Status icon/colors come from the shared themed helper.
 */

export type WorkflowAgentRowProps = Readonly<{
    title: string;
    status: SessionWorkflowAgentStatusV1;
    model?: string;
    tokensUsed?: number;
    toolCalls?: number;
    timeUsedSeconds?: number;
    resultPreview?: string;
    summary?: string;
    testID?: string;
    messageId?: string;
    findBlockPrefix?: string;
}>;

function formatDuration(seconds: number): string {
    if (seconds >= 60) {
        const m = Math.floor(seconds / 60);
        const s = Math.round(seconds % 60);
        return `${m}m ${s}s`;
    }
    return `${Math.round(seconds)}s`;
}

function formatAgentMetrics(props: WorkflowAgentRowProps): string {
    const metricParts: string[] = [];
    if (props.model) metricParts.push(props.model);
    if (typeof props.tokensUsed === 'number' && props.tokensUsed > 0) {
        metricParts.push(t('tools.workflowActivityView.tokens', { tokens: formatTokenCount(props.tokensUsed) }));
    }
    if (typeof props.toolCalls === 'number' && props.toolCalls > 0) {
        metricParts.push(t('tools.workflowActivityView.toolCalls', { count: props.toolCalls }));
    }
    if (typeof props.timeUsedSeconds === 'number' && props.timeUsedSeconds > 0) {
        metricParts.push(formatDuration(props.timeUsedSeconds));
    }
    return metricParts.join(' · ');
}

export function projectWorkflowAgentDisplayText(props: WorkflowAgentRowProps, prefix: string) {
    const preview = props.resultPreview ?? props.summary;
    const detail = normalizeResultPreview(props.summary ?? props.resultPreview ?? '', null).display;
    return [
        ...toolTextBlock(`${prefix}-title`, props.title),
        ...toolTextBlock(`${prefix}-metrics`, formatAgentMetrics(props)),
        ...toolTextBlock(`${prefix}-preview`, preview !== detail ? preview : null),
        ...toolTextBlock(`${prefix}-detail`, detail),
    ];
}

export const WorkflowAgentRow = React.memo<WorkflowAgentRowProps>((props) => {
    const find = useToolFindState(props.messageId);
    const prefix = props.findBlockPrefix ?? 'tool-workflow-agent';
    const { theme } = useUnistyles();
    const [expanded, setExpanded] = React.useState(false);
    const rowLayoutMutation = useTranscriptRowLayoutMutation();
    const toggleExpanded = React.useCallback(() => {
        rowLayoutMutation({
            reason: expanded ? 'collapse' : 'expand',
            sourceId: `workflow-agent:${props.testID ?? props.title}`,
        });
        setExpanded(!expanded);
    }, [expanded, props.testID, props.title, rowLayoutMutation]);
    const metrics = formatAgentMetrics(props);
    const hasDetail = Boolean(props.summary || props.resultPreview);
    const collapsedPreview = props.resultPreview ?? props.summary;
    const expandedDetail = props.summary ?? props.resultPreview;
    const isExpanded = expanded || find.active;
    const showPreview = collapsedPreview && (!isExpanded || (find.active && collapsedPreview !== normalizeResultPreview(expandedDetail ?? '', null).display));
    const detailTestID = props.testID ? `${props.testID}-detail` : undefined;
    const content = (
        <View style={styles.mainRow}>
            <View style={styles.iconColumn}>
                <WorkflowStatusIcon status={props.status} size={14} />
            </View>
            <View style={styles.body}>
                <ToolFindText messageId={props.messageId} blockId={`${prefix}-title`} text={props.title} style={styles.title} numberOfLines={1} />
                {metrics ? (
                    <ToolFindText messageId={props.messageId} blockId={`${prefix}-metrics`} text={metrics} style={styles.metrics} numberOfLines={1} />
                ) : null}
                {showPreview ? (
                    <ToolFindText messageId={props.messageId} blockId={`${prefix}-preview`} text={collapsedPreview} style={styles.preview} numberOfLines={1} />
                ) : null}
            </View>
            {hasDetail ? (
                <Icon
                    name={isExpanded ? 'caret-up' : 'caret-down'}
                    size={14}
                    color={theme.colors.text.secondary}
                />
            ) : null}
        </View>
    );

    if (hasDetail) {
        return (
            <View style={[styles.row, isExpanded ? styles.rowExpanded : null]}>
                <HappierPressable
                    accessibilityRole="button"
                    accessibilityLabel={props.title}
                    expanded={isExpanded}
                    onPress={toggleExpanded}
                    style={(state) => [styles.rowTarget, state.pressed ? { opacity: HAPPIER_PRESS_FEEDBACK_V1.opacitySubtle } : null,
                        focusRingStyle({ focused: state.focused, color: theme.colors.border.focus })]}
                    testID={props.testID}
                >
                    {content}
                </HappierPressable>
                {isExpanded && expandedDetail ? (
                    <WorkflowAgentDetail text={expandedDetail} detailTestID={detailTestID} messageId={props.messageId} findBlockId={`${prefix}-detail`} />
                ) : null}
            </View>
        );
    }

    return (
        <View style={styles.row} testID={props.testID}>
            {content}
        </View>
    );
});
WorkflowAgentRow.displayName = 'WorkflowAgentRow';

const styles = StyleSheet.create((theme) => ({
    row: {
        gap: theme.margins.xs,
        paddingVertical: theme.margins.xs,
        paddingHorizontal: theme.margins.xs,
        borderRadius: theme.borderRadius.md,
    },
    rowExpanded: {
        backgroundColor: theme.colors.surface.base,
    },
    rowTarget: {
        minHeight: resolveMinimumInteractiveTargetSize(Platform.OS),
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: 'transparent',
    },
    mainRow: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: theme.margins.sm,
    },
    iconColumn: {
        width: 18,
        alignItems: 'center',
        paddingTop: 1,
    },
    body: {
        flex: 1,
        gap: theme.margins.xs,
    },
    title: {
        ...Typography.rowTitle(),
        color: theme.colors.text.primary,
    },
    metrics: {
        ...Typography.timestamp(),
        color: theme.colors.text.secondary,
    },
    preview: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
    },
}));
