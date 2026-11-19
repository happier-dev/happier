import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { isExecutionRunActive, type ExecutionRunPublicState } from '@happier-dev/protocol/execution/runs/responseSchemas';
import {
    readExecutionRunAgentActivityStatus,
    resolveAgentActivityStatusPresentation,
} from '@/components/sessions/agents/presentation/sessionAgentActivityPresentation';
import { WORK_STATUS_PILL_VARIANT } from '@/components/work/status/resolveWorkStatusTone';
import { StatusPill } from '@/components/ui/status/StatusPill';
import { presentExecutionRunFailureSummary } from '@/components/sessions/presentation/sessionRuntimeIssuePresentation';
import { Text } from '@/components/ui/text/Text';
import { resolveExecutionRunAgentMarkId, resolveExecutionRunBackendLabel } from '@/components/sessions/runs/resolveExecutionRunBackendLabel';
import { AgentIcon } from '@/agents/registry/AgentIcon';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';
import { Item } from '@/components/ui/lists/Item';
import { useItemSubtitleTextStyle } from '@/components/ui/lists/ItemSubtitleText';
import { resolveExecutionRunTitle } from './resolveExecutionRunTitle';
import { resolveExecutionRunSelectionLabel, resolveRunNativeModelLabel, type RunNativeModelCatalog } from './resolveExecutionRunSelectionLabel';
import { useExecutionRunSourceLabel } from './useExecutionRunSourceLabel';
import { useProviderSettingsForServer } from '@/providers/hooks/useProviderSettings';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';


export type ExecutionRunRowRun =
    Pick<ExecutionRunPublicState, 'runId' | 'intent' | 'backendTarget' | 'status' | 'display'>
    & Partial<Pick<ExecutionRunPublicState, 'error'>>
    /** A daemon marker records only its failure code. */
    & Readonly<{ errorCode?: string }>
    & Partial<Pick<ExecutionRunPublicState, 'startedAtMs' | 'finishedAtMs' | 'runClass' | 'turnInFlight' | 'resolvedSelection'>>;

function ExecutionRunScopedSubtitle(props: Readonly<{
    backendTarget: ExecutionRunRowRun['backendTarget'];
    selection: NonNullable<ExecutionRunPublicState['resolvedSelection']>;
    serverId: string;
    lead: string | null;
    subtitle: string | null;
    /** A failed Run's cause, which leads the line so a narrow row ellipsizes the metadata, never the cause. */
    failure: string | null;
    nativeModelCatalog?: RunNativeModelCatalog;
}>) {
    const subtitleStyle = useItemSubtitleTextStyle();
    const connections = useProviderSettingsForServer(props.serverId).connections;
    const sourceLabel = useExecutionRunSourceLabel(props.selection, props.serverId);
    const selectionLabel = resolveExecutionRunSelectionLabel(props.selection, (connectionId) => (
        connections.find(connection => connection.id === connectionId)?.displayName ?? null
    ), sourceLabel, resolveRunNativeModelLabel(props.backendTarget, props.nativeModelCatalog, props.selection));
    return <Text style={subtitleStyle} numberOfLines={1}>
        {[props.failure, props.lead, selectionLabel, props.subtitle].filter(Boolean).join(' · ')}
    </Text>;
}

/**
 * One Run as a row of the list it sits in (a Machine's runs, the Runs page): what the work is, then
 * its Agent, model and the host's process facts, with its state at the end. A host control (Stop) is
 * a sibling of the row's press target, never inside it.
 */
export const ExecutionRunRow = React.memo((props: Readonly<{
    run: ExecutionRunRowRun;
    onPress?: () => void;
    /** The host's facts about this Run (its process), after the Agent and model. */
    subtitle?: string;
    serverId?: string | null;
    machineId?: string | null;
    nativeModelCatalog?: RunNativeModelCatalog;
    rightAccessory?: React.ReactNode;
    selected?: boolean;
}>) => {
    const { theme } = useUnistyles();
    const { run, onPress } = props;
    // A failed Run says its typed cause (the shared presenter's one line) instead of its process facts, first on
    // its line: a phone row ellipsizes what follows, so the cause stays visible.
    const failure = run.status !== 'failed' ? null
        : presentExecutionRunFailureSummary(run.error ?? (run.errorCode ? { code: run.errorCode } : null))?.summary ?? null;
    const subtitle = failure ? null : typeof props.subtitle === 'string' && props.subtitle.trim() ? props.subtitle : null;
    const backendLabel = resolveExecutionRunBackendLabel(run.backendTarget);
    const agentMarkId = resolveExecutionRunAgentMarkId(run.backendTarget, theme);
    // The run's state in the roster's words (sessionAgentActivityPresentation) and the shared tone (I3).
    const activityStatus = readExecutionRunAgentActivityStatus(run.status);
    const presence = useMachinePresenceSummary(props.serverId, props.machineId);
    const status = resolveAgentActivityStatusPresentation(activityStatus, isExecutionRunActive(run),
        presence.reachability === 'unknown' ? undefined : presence.reachability === 'reachable').workStatus;
    const display = run.display && typeof run.display === 'object' ? run.display as { title?: unknown; participantLabel?: unknown } : null;
    const participantLabel = typeof display?.participantLabel === 'string' ? display.participantLabel.trim() : '';
    const givenTitle = typeof display?.title === 'string' ? display.title.trim() : '';
    // What the work is, in words (the Run title owner); a Run with no words for its work is named by its Agent.
    const title = resolveExecutionRunTitle({ intent: run.intent, display: { title: givenTitle || participantLabel || undefined } },
        'summary', backendLabel);
    const lead = backendLabel && backendLabel !== title ? backendLabel : null;
    const selectionLabel = resolveExecutionRunSelectionLabel(run.resolvedSelection, () => null, null,
        resolveRunNativeModelLabel(run.backendTarget, props.nativeModelCatalog, run.resolvedSelection));

    const rowSubtitle = run.resolvedSelection && props.serverId ? (
        <ExecutionRunScopedSubtitle backendTarget={run.backendTarget} selection={run.resolvedSelection} serverId={props.serverId}
            lead={lead} subtitle={subtitle} failure={failure} nativeModelCatalog={props.nativeModelCatalog} />
    ) : ([failure, lead, selectionLabel, subtitle].filter(Boolean).join(' · ') || undefined);

    return (
        <Item
            title={title}
            subtitle={rowSubtitle}
            icon={agentMarkId
                ? <AgentIcon agentId={agentMarkId} size={20} />
                : <Icon name="sparkle" size={20} color={theme.colors.text.secondary} />}
            subtitleLines={1}
            selected={props.selected === true}
            onPress={onPress}
            mode={onPress ? undefined : 'info'}
            accessibilityRole={onPress ? 'button' : undefined}
            accessibilityLabel={title}
            accessibilityHint={onPress ? t('runs.openRun') : undefined}
            rightElementOutsidePressable={Boolean(props.rightAccessory)}
            rightElement={(
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 }}>
                    <StatusPill
                        testID="execution-run-row-status"
                        variant={WORK_STATUS_PILL_VARIANT[status.tone]}
                        label={status.word}
                        labelVariant="micro"
                        hideDot
                    />
                    {props.rightAccessory ?? null}
                </View>
            )}
        />
    );
});
