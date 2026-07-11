import { Ionicons } from '@expo/vector-icons';
import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { MeterBar } from '@/components/ui/lists/MeterBar';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import {
    resolveWorkflowMeterTone,
    resolveWorkflowProgressFraction,
    type WorkflowStatusTone,
} from '@/components/sessions/workState/sessionWorkflowActivityPresentation';
import type { WorkflowPhaseRollup } from '@/components/sessions/workState/sessionWorkflowActivityTypes';
import type { SessionWorkflowRunStatusV1 } from '@happier-dev/protocol';

import { WorkflowStatusIcon } from './workflowStatusIcon';

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
    tone: WorkflowStatusTone;
    /** Present only when the header is acting as a collapsible control. */
    expanded?: boolean;
}>;

export const WorkflowRunHeader = React.memo<WorkflowRunHeaderProps>((props) => {
    const { theme } = useUnistyles();
    const meterTone = resolveWorkflowMeterTone(props.rollup);
    const fraction = resolveWorkflowProgressFraction(props);

    return (
        <View style={styles.container}>
            <View style={styles.headerRow}>
                <Ionicons name="git-network-outline" size={16} color={theme.colors.text.secondary} />
                <Text style={styles.title} numberOfLines={1}>
                    {props.title}
                </Text>
                <View style={styles.statusBadge}>
                    <WorkflowStatusIcon status={props.status} size={14} />
                    <Text style={styles.statusLabel} numberOfLines={1}>
                        {props.statusLabel}
                    </Text>
                </View>
                {typeof props.expanded === 'boolean' ? (
                    <Ionicons
                        name={props.expanded ? 'chevron-up' : 'chevron-down'}
                        size={14}
                        color={theme.colors.text.secondary}
                    />
                ) : null}
            </View>
            {props.totalAgents > 0 ? (
                <MeterBar
                    tone={meterTone}
                    fillFraction={fraction}
                    height={4}
                    caption={
                        <Text style={styles.summary} numberOfLines={1}>
                            {props.summaryLine
                                ?? t('tools.workflowActivityView.agentFraction', {
                                    complete: props.completedAgents,
                                    total: props.totalAgents,
                                })}
                        </Text>
                    }
                />
            ) : props.summaryLine ? (
                <Text style={styles.summary} numberOfLines={1}>
                    {props.summaryLine}
                </Text>
            ) : null}
        </View>
    );
});
WorkflowRunHeader.displayName = 'WorkflowRunHeader';

const styles = StyleSheet.create((theme) => ({
    container: {
        gap: 6,
    },
    headerRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    title: {
        flex: 1,
        fontSize: 14,
        fontWeight: '600',
        color: theme.colors.text.primary,
    },
    statusBadge: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    statusLabel: {
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
    summary: {
        fontSize: 12,
        color: theme.colors.text.secondary,
    },
}));
