import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { MeterBar } from '@/components/ui/lists/MeterBar';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import {
    resolveWorkflowMeterTone,
    resolveWorkflowProgressFraction,
} from '@/components/sessions/workState/sessionWorkflowActivityPresentation';
import type { WorkflowPhaseRollup } from '@/components/sessions/workState/sessionWorkflowActivityTypes';
import { AgentActivityStatusSlot } from '@/components/sessions/agentActivity/row/AgentActivityStatusSlot';
import { fromWorkflowRunStatus, type SessionWorkflowRunStatusV1 } from '@happier-dev/protocol';

import { Icon } from '@/components/ui/icons/Icon';

/**
 * Run header shared by the transcript card (UIW4) and popover run panel (UIW3): workflow icon,
 * title, status, agent fraction, and a progress meter. Theme-driven, primitive props.
 *
 * The status mark comes from the shared `AgentActivityStatusSlot`, through the protocol adapter, so
 * a run's glyph and its ink are decided in the same place as every agent row beneath it. There is
 * no local status->colour switch here and there must not be one: a header that painted `failed`
 * from its own table is how the run and its agents end up disagreeing about what red means.
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
}>;

export const WorkflowRunHeader = React.memo<WorkflowRunHeaderProps>((props) => {
    const { theme } = useUnistyles();
    const meterTone = resolveWorkflowMeterTone(props.rollup);
    const fraction = resolveWorkflowProgressFraction(props);

    return (
        <View style={styles.container}>
            <View style={styles.headerRow}>
                <Icon name="graph" size={16} color={theme.colors.text.secondary} />
                <Text style={styles.title} numberOfLines={1}>
                    {props.title}
                </Text>
                <View style={styles.statusBadge}>
                    <AgentActivityStatusSlot status={fromWorkflowRunStatus(props.status)} size={14} />
                    <Text style={styles.statusLabel} numberOfLines={1}>
                        {props.statusLabel}
                    </Text>
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
                    height={4}
                    caption={
                        <Text style={styles.summary} numberOfLines={1} accessibilityLiveRegion="none">
                            {props.summaryLine
                                ?? t('tools.workflowActivityView.agentFraction', {
                                    complete: props.completedAgents,
                                    total: props.totalAgents,
                                })}
                        </Text>
                    }
                />
            ) : props.summaryLine ? (
                <Text style={styles.summary} numberOfLines={1} accessibilityLiveRegion="none">
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
