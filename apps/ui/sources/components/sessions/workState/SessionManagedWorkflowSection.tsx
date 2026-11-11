import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import { WorkflowRunStateMark } from '@/components/workflows/presentation/WorkflowLifecycleStatus';
import { describeWorkflowRunState } from '@/components/workflows/presentation/workflowLifecyclePresentation';
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
 * The row is an entry point, not a second Run view: one menu row per Run (its name; its canonical state and
 * where it came from as one quiet meta line, in the state's tone) that opens the exact `runId`, where the one
 * shared Run body owns approvals, results and recovery (owner 2026-11-11: the popover's row grammar).
 */

const styles = StyleSheet.create((theme) => ({
    meta: {
        ...Typography.variant('meta'),
        ...Typography.tabular(),
        color: theme.colors.text.secondary,
    },
    action: {
        ...Typography.variant('meta', 'semiBold'),
        color: theme.colors.text.secondary,
    },
    actionAttention: {
        color: theme.colors.text.primary,
    },
}));

export function SessionManagedWorkflowSection(props: Readonly<{
    state: SessionManagedWorkflowRunsState;
    onOpenRun: (runId: string) => void;
    testIDPrefix?: string;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const testIDPrefix = props.testIDPrefix ?? 'session-managed-workflows';
    // A read that failed is reported whether or not it had rows: a stale list
    // is still the entry point to a Run that may be waiting on the person, so
    // the failure is stated beside the rows rather than replacing them.
    const readFailed = props.state.phase === 'failed' || props.state.refreshFailed;
    // Nothing to show is not a state worth a heading: an ordinary Session that
    // never started a workflow keeps its work-state surface unchanged.
    if (!readFailed && props.state.runs.length === 0) return null;

    return (
        <ItemGroup testID={testIDPrefix} title={t('workflows.title')}>
            {readFailed ? (
                <Item
                    testID={`${testIDPrefix}-error`}
                    rowRole="menu"
                    mode="info"
                    showChevron={false}
                    showDivider={false}
                    title={t('workflows.loadFailedBody')}
                    titleLines={0}
                />
            ) : null}
            {props.state.runs.map((run) => {
                const needsAttention = props.state.attentionRunIds.has(run.id);
                const title = formatWorkflowRunDisplayName(
                    resolveWorkflowRunDisplayName(props.state.metadataByRunId?.[run.id]),
                );
                const state = describeWorkflowRunState(run.state, { workflowCustodyState: run.workflowCustodyState });
                // A state that asks for the person (interrupted, failed, waiting) reads in its own tone; the rest stay quiet.
                const toned = state.variant === 'attention' || state.variant === 'warning' || state.variant === 'danger';
                const origin = formatWorkflowRunOriginLabel(run.origin);
                return (
                    <Item
                        key={run.id}
                        testID={`${testIDPrefix}-run-${run.id}`}
                        rowRole="menu"
                        showDivider={false}
                        showChevron={false}
                        accessibilityLabel={t('workflows.run.openExact', { title })}
                        onPress={() => props.onOpenRun(run.id)}
                        icon={(
                            <WorkflowRunStateMark
                                state={run.state}
                                context={{ workflowCustodyState: run.workflowCustodyState }}
                                size={16}
                                testID={`${testIDPrefix}-run-${run.id}-state-marker`}
                            />
                        )}
                        title={title}
                        subtitle={(
                            <Text
                                testID={`${testIDPrefix}-run-${run.id}-state`}
                                accessibilityLabel={state.label}
                                style={[styles.meta, toned ? { color: theme.colors.state[state.variant].foreground } : null]}
                                numberOfLines={1}
                            >
                                {[state.label, origin].filter(Boolean).join(' · ')}
                            </Text>
                        )}
                        // Review versus Open is the server's own attention predicate, so an approval waiting in an
                        // invocation this client has never loaded still surfaces here.
                        rightElement={(
                            <Text
                                testID={`${testIDPrefix}-run-${run.id}-${needsAttention ? 'review' : 'open'}`}
                                style={[styles.action, needsAttention ? styles.actionAttention : null]}
                            >
                                {needsAttention ? t('workflows.run.review') : t('workflows.run.open')}
                            </Text>
                        )}
                    />
                );
            })}
        </ItemGroup>
    );
}
