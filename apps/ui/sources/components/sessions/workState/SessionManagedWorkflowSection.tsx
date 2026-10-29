import * as React from 'react';
import { View } from 'react-native';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { WorkflowRunStateStatus } from '@/components/workflows/presentation/WorkflowLifecycleStatus';
import {
    formatWorkflowRunDisplayName,
    resolveWorkflowRunDisplayName,
} from '@/components/workflows/presentation/workflowRunDisplayName';
import { formatWorkflowRunOriginLabel } from '@/components/workflows/run/workflowRunDetailPresentation';

import type { SessionManagedWorkflowRunsState } from '@/components/workflows/run/useContextManagedWorkflowRuns';

/**
 * Managed Workflow Runs started from this Session.
 *
 * It sits beside the observed native-activity section and is deliberately not
 * merged with it: observed Claude activity is evidence about an agent's own
 * phases, while these rows are a managed Run with real lifecycle, custody and
 * recovery. Collapsing the two would be exactly the status guesser the plan
 * forbids.
 *
 * The row is an entry point, not a second Run view: it shows the canonical Run
 * state and opens the exact `runId`, where the one shared Run body owns
 * approvals, results and recovery.
 */

const styles = StyleSheet.create((theme) => ({
    section: {
        gap: theme.space.s8,
        paddingVertical: theme.space.s8,
    },
    sectionLabel: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
        paddingVertical: theme.space.s4,
    },
    rowBody: {
        flexShrink: 1,
        gap: theme.space.s4,
    },
    rowMeta: {
        ...Typography.default('regular'),
        ...Typography.tabular(),
        color: theme.colors.text.secondary,
    },
    action: {
        ...Typography.default('semiBold'),
        color: theme.colors.button.secondary.tint,
        marginLeft: 'auto',
    },
    note: {
        ...Typography.default('regular'),
        color: theme.colors.text.secondary,
    },
}));

export function SessionManagedWorkflowSection(props: Readonly<{
    state: SessionManagedWorkflowRunsState;
    onOpenRun: (runId: string) => void;
    testIDPrefix?: string;
}>): React.ReactElement | null {
    const testIDPrefix = props.testIDPrefix ?? 'session-managed-workflows';
    // A read that failed is reported whether or not it had rows: a stale list
    // is still the entry point to a Run that may be waiting on the person, so
    // the failure is stated beside the rows rather than replacing them.
    const readFailed = props.state.phase === 'failed' || props.state.refreshFailed;
    // Nothing to show is not a state worth a heading: an ordinary Session that
    // never started a workflow keeps its work-state surface unchanged.
    if (!readFailed && props.state.runs.length === 0) return null;

    return (
        <View testID={testIDPrefix} style={styles.section}>
            <Text style={styles.sectionLabel}>{t('workflows.title')}</Text>
            {readFailed ? (
                <Text testID={`${testIDPrefix}-error`} style={styles.note}>
                    {t('workflows.loadFailedBody')}
                </Text>
            ) : null}
            {props.state.runs.map((run) => {
                const needsAttention = props.state.attentionRunIds.has(run.id);
                const title = formatWorkflowRunDisplayName(
                    resolveWorkflowRunDisplayName(props.state.metadataByRunId?.[run.id]),
                );
                return (
                    <HappierPressable
                        key={run.id}
                        testID={`${testIDPrefix}-run-${run.id}`}
                        accessibilityRole="button"
                        accessibilityLabel={t('workflows.run.openExact', {
                            title,
                        })}
                        onPress={() => props.onOpenRun(run.id)}
                        style={styles.row}
                    >
                        <View style={styles.rowBody}>
                            <Text>{title}</Text>
                            <WorkflowRunStateStatus
                                testID={`${testIDPrefix}-run-${run.id}-state`}
                                state={run.state}
                                workflowCustodyState={run.workflowCustodyState}
                            />
                            <Text style={styles.rowMeta} numberOfLines={1}>
                                {formatWorkflowRunOriginLabel(run.origin)}
                            </Text>
                        </View>
                        {/*
                          * Review versus Open is the server's own attention
                          * predicate, so an approval waiting in an invocation this
                          * client has never loaded still surfaces here.
                          */}
                        <Text
                            testID={`${testIDPrefix}-run-${run.id}-${needsAttention ? 'review' : 'open'}`}
                            style={styles.action}
                        >
                            {needsAttention ? t('workflows.run.review') : t('workflows.run.open')}
                        </Text>
                    </HappierPressable>
                );
            })}
        </View>
    );
}
