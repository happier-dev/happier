import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import type { AutomationRunCause, AutomationV3RunDetail } from '@happier-dev/protocol/automations/automationApiV3';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { ItemList } from '@/components/ui/lists/ItemList';
import { PageHeader } from '@/components/ui/layout/PageHeader';
import { layout } from '@/components/ui/layout/layout';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useServerScopedMachine } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { navigateWithBlurOnWeb } from '@/utils/platform/deferOnWeb';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import {
    formatAutomationRunStateLabel,
    formatAutomationRunCauseLabel,
} from '@/components/automations/list/automationListFormatting';
import type {
    AutomationRunDetailPrivateContentInspection,
} from '@/sync/domains/automations/automationRunDetailInspection';
import type { AutomationDefinitionRun } from '@/sync/domains/automations/automationTypes';
import { buildScopedSessionRouteHref } from '@/hooks/session/sessionRouteServerScope';
import { Icon } from '@/components/ui/icons/Icon';
import { TriggerFromActivityEvent } from '@/components/workflows/triggers/TriggerFromActivityEvent';
import type { WorkflowRunRouteTarget } from '@/sync/domains/workflows/workflowRunRoute';
import { useWorkflowOccurrenceRunDetail } from './useWorkflowOccurrenceRunDetail';

const stylesheet = StyleSheet.create((theme) => ({
    loading: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    unavailable: {
        color: theme.colors.text.secondary,
    },
}));

function formatDate(ms: number, unknownLabel: string): string {
    try {
        return new Date(ms).toLocaleString();
    } catch {
        return unknownLabel;
    }
}

function formatRunCauseTime(
    cause: AutomationRunCause,
    unknownLabel: string,
): string {
    switch (cause.kind) {
        case 'trigger':
            if (cause.triggerKind === 'schedule') {
                return t('automations.detail.runMeta.scheduled', {
                    time: formatDate(cause.evidence.scheduledFor, unknownLabel),
                });
            }
            return t('automations.detail.runMeta.occurred', {
                time: formatDate(cause.occurredAt, unknownLabel),
            });
        case 'manual':
            return t('automations.detail.runMeta.invoked', {
                time: formatDate(cause.invokedAt, unknownLabel),
            });
        case 'conversation':
            return t('automations.detail.runMeta.occurred', {
                time: formatDate(cause.occurredAt, unknownLabel),
            });
    }
}

type AutomationRunDetailTarget = Extract<
    AutomationRunDetailPrivateContentInspection['recipe'],
    Readonly<{ kind: 'available' }>
>['target'];

type AutomationRunDetailEvidence = Extract<
    AutomationRunDetailPrivateContentInspection['recipe'],
    Readonly<{ kind: 'available' }>
>['evidence'];

function formatStructuredPrivateDetail(value: unknown): string {
    try {
        return createCanonicalJsonSigningInput(value);
    } catch {
        return t('common.unavailable');
    }
}

function formatPrivateDetailFailure(
    reason: 'materialUnavailable' | 'currentnessUnavailable' | 'modeMismatch' | 'contentInvalid',
): string {
    switch (reason) {
        case 'currentnessUnavailable':
            return t('automations.detail.runDetail.currentnessUnavailable');
        case 'materialUnavailable':
            return t('automations.detail.runDetail.materialUnavailable');
        case 'modeMismatch':
            return t('automations.detail.runDetail.modeMismatch');
        case 'contentInvalid':
            return t('automations.detail.runDetail.contentInvalid');
    }
}

export function formatRunTarget(target: AutomationRunDetailTarget): string {
    switch (target.kind) {
        case 'contributedAction':
            return `${target.action.pluginId}/${target.action.localId}`;
        case 'existingSession':
            return t('automations.detail.runDetail.existingSession', { sessionId: target.sessionId });
        case 'newSession':
            return t('automations.detail.runDetail.newSession', {
                machineId: target.spawn.executionTarget.machineId,
                directory: target.spawn.directory.kind === 'path'
                    ? target.spawn.directory.path
                    : t('session.folderless.privateToSession'),
            });
        case 'executionRun':
            return t('automations.detail.runDetail.executionRun', {
                permissionMode: target.request.permissionMode,
            });
    }
}

export function AutomationRunLifecycleCauseItems(props: Readonly<{
    cause: Extract<AutomationRunCause, Readonly<{ kind: 'trigger'; triggerKind: 'sessionLifecycle' }>>;
}>): React.ReactElement {
    const { cause } = props;
    return (
        <>
            <Item
                title={t('automations.pluralEditor.lifecycleEventsTitle')}
                subtitle={t(`automations.pluralEditor.lifecycleEvent.${cause.evidence.event}`)}
                showChevron={false}
                mode="info"
            />
            <Item
                title={t('automations.detail.trigger.sourceSession')}
                subtitle={cause.evidence.sourceSessionId}
                subtitleLines={0}
                copy={cause.evidence.sourceSessionId}
                showChevron={false}
            />
            {'sourceTurnId' in cause.evidence ? (
                <Item
                    title={t('automations.detail.trigger.sourceTurn')}
                    subtitle={cause.evidence.sourceTurnId}
                    subtitleLines={0}
                    copy={cause.evidence.sourceTurnId}
                    showChevron={false}
                />
            ) : null}
        </>
    );
}

function getRunTargetPrompt(target: AutomationRunDetailTarget): string {
    switch (target.kind) {
        case 'contributedAction':
            return formatStructuredPrivateDetail(target.input);
        case 'existingSession':
            return target.prompt;
        case 'newSession':
            return target.spawn.initialInput?.text ?? t('common.unavailable');
        case 'executionRun':
            return target.request.instructions ?? t('common.unavailable');
    }
}

export function AutomationRunDetailEvidenceItems(props: Readonly<{
    evidence: AutomationRunDetailEvidence;
    accountLifetime?: ServerAccountScopeLifetime | null;
}>): React.ReactElement | null {
    const { evidence } = props;
    if (evidence === null) return null;
    if (evidence.kind === 'pluginEvent') {
        const payload = formatStructuredPrivateDetail(evidence.payload);
        return (
            <>
                <Item
                    title={t('automations.detail.runDetail.event')}
                    subtitle={`${evidence.eventRef.pluginId}/${evidence.eventRef.localId}`}
                    showChevron={false}
                    mode="info"
                />
                <Item
                    title={t('automations.detail.runDetail.sourceInstance')}
                    subtitle={evidence.sourceInstanceId}
                    subtitleLines={0}
                    copy={evidence.sourceInstanceId}
                    showChevron={false}
                />
                <Item
                    title={t('automations.detail.runDetail.filter')}
                    detail={t('automations.detail.runDetail.filterMatched')}
                    showChevron={false}
                    mode="info"
                />
                <Item
                    title={t('automations.detail.runDetail.payload')}
                    subtitle={payload}
                    subtitleLines={0}
                    copy={payload}
                    showChevron={false}
                />
                <TriggerFromActivityEvent evidence={evidence} accountLifetime={props.accountLifetime} />
            </>
        );
    }

    const input = formatStructuredPrivateDetail(evidence.input);
    return (
        <>
            <Item
                title={t('automations.detail.runDetail.conversation')}
                subtitle={evidence.bindingId}
                subtitleLines={0}
                copy={evidence.bindingId}
                showChevron={false}
            />
            <Item
                title={t('automations.detail.runDetail.input')}
                subtitle={input}
                subtitleLines={0}
                copy={input}
                showChevron={false}
            />
        </>
    );
}

function AutomationRunDetailRecipeItems(props: Readonly<{
    recipe: AutomationRunDetailPrivateContentInspection['recipe'];
    accountLifetime?: ServerAccountScopeLifetime | null;
}>): React.ReactElement {
    const { recipe } = props;
    switch (recipe.kind) {
        case 'absent':
            return (
                <Item
                    title={t('automations.detail.runDetail.recipe')}
                    subtitle={t('automations.detail.runDetail.recipeAbsent')}
                    showChevron={false}
                    mode="info"
                />
            );
        case 'unavailable':
        case 'invalid':
            return (
                <Item
                    title={t('automations.detail.runDetail.recipe')}
                    subtitle={formatPrivateDetailFailure(recipe.reason)}
                    showChevron={false}
                    mode="info"
                />
            );
        case 'available': {
            const targetPrompt = getRunTargetPrompt(recipe.target);
            return (
                <>
                    <Item
                        title={t('automations.detail.runDetail.templateVersion')}
                        detail={String(recipe.templateVersion)}
                        showChevron={false}
                        mode="info"
                    />
                    <AutomationRunDetailEvidenceItems evidence={recipe.evidence} accountLifetime={props.accountLifetime} />
                    <Item
                        title={t('automations.detail.runDetail.target')}
                        subtitle={formatRunTarget(recipe.target)}
                        subtitleLines={0}
                        copy={formatRunTarget(recipe.target)}
                        showChevron={false}
                    />
                    <Item
                        title={t('automations.detail.runDetail.prompt')}
                        subtitle={targetPrompt}
                        subtitleLines={0}
                        copy={targetPrompt}
                        showChevron={false}
                    />
                </>
            );
        }
    }
}

function AutomationRunDetailResultItems(props: Readonly<{
    result: AutomationRunDetailPrivateContentInspection['result'];
}>): React.ReactElement {
    const { result } = props;
    switch (result.kind) {
        case 'absent':
            return (
                <Item
                    title={t('automations.detail.runDetail.result')}
                    subtitle={t('automations.detail.runDetail.resultAbsent')}
                    showChevron={false}
                    mode="info"
                />
            );
        case 'predecessorSummary':
            return (
                <Item
                    title={t('automations.detail.runDetail.result')}
                    subtitle={t('automations.detail.runDetail.predecessorSummary')}
                    showChevron={false}
                    mode="info"
                />
            );
        case 'unavailable':
        case 'invalid':
            return (
                <Item
                    title={t('automations.detail.runDetail.result')}
                    subtitle={formatPrivateDetailFailure(result.reason)}
                    showChevron={false}
                    mode="info"
                />
            );
        case 'available':
            return (
                <Item
                    title={t('automations.detail.runDetail.result')}
                    subtitle={result.result.text || t('common.none')}
                    subtitleLines={0}
                    copy={result.result.text}
                    showChevron={false}
                />
            );
    }
}

function AutomationRunDetailFailureDetailItems(props: Readonly<{
    failureDetail: AutomationRunDetailPrivateContentInspection['failureDetail'];
}>): React.ReactElement {
    const { failureDetail } = props;
    switch (failureDetail.kind) {
        case 'absent':
            return (
                <Item
                    title={t('automations.detail.runDetail.failureDetail')}
                    subtitle={t('automations.detail.runDetail.failureDetailAbsent')}
                    showChevron={false}
                    mode="info"
                />
            );
        case 'unavailable':
        case 'invalid':
            return (
                <Item
                    title={t('automations.detail.runDetail.failureDetail')}
                    subtitle={formatPrivateDetailFailure(failureDetail.reason)}
                    showChevron={false}
                    mode="info"
                />
            );
        case 'available':
            return (
                <Item
                    title={t('automations.detail.runDetail.failureDetail')}
                    subtitle={failureDetail.detail}
                    subtitleLines={0}
                    copy={failureDetail.detail}
                    showChevron={false}
                />
            );
    }
}

/**
 * The Run row already carries its assignment, attempt, dispatch and
 * reply-handoff facts; the detail screen is the one place a user can ask why a
 * Run behaved the way it did, so it names them instead of dropping them.
 * Product language only — a raw state token is never painted at the user.
 */
const automationRunDispatchStateLabels = {
    notStarted: () => t('automations.detail.runMeta.dispatchState.notStarted'),
    dispatchPermitted: () => t('automations.detail.runMeta.dispatchState.dispatchPermitted'),
    retryWaiting: () => t('automations.detail.runMeta.dispatchState.retryWaiting'),
    started: () => t('automations.detail.runMeta.dispatchState.started'),
    settled: () => t('automations.detail.runMeta.dispatchState.settled'),
    outcomeUnknown: () => t('automations.detail.runMeta.dispatchState.outcomeUnknown'),
} satisfies Record<NonNullable<AutomationDefinitionRun['executionDispatchState']>, () => string>;

const automationRunReplyHandoffStateLabels = {
    none: () => t('automations.detail.runMeta.replyHandoffState.none'),
    awaitingResult: () => t('automations.detail.runMeta.replyHandoffState.awaitingResult'),
    ready: () => t('automations.detail.runMeta.replyHandoffState.ready'),
    handingOff: () => t('automations.detail.runMeta.replyHandoffState.handingOff'),
    accepted: () => t('automations.detail.runMeta.replyHandoffState.accepted'),
    suppressed: () => t('automations.detail.runMeta.replyHandoffState.suppressed'),
    blocked: () => t('automations.detail.runMeta.replyHandoffState.blocked'),
} satisfies Record<AutomationDefinitionRun['replyHandoffState'], () => string>;

const automationRunHistoryEventLabels: Readonly<Record<string, () => string>> = {
    run_started: () => t('automations.detail.runMeta.historyEvent.run_started'),
    run_succeeded: () => t('automations.detail.runMeta.historyEvent.run_succeeded'),
    run_failed: () => t('automations.detail.runMeta.historyEvent.run_failed'),
    run_cancelled: () => t('automations.detail.runMeta.historyEvent.run_cancelled'),
    run_outcome_uncertain: () => t('automations.detail.runMeta.historyEvent.run_outcome_uncertain'),
    execution_dispatch_retry_scheduled: () =>
        t('automations.detail.runMeta.historyEvent.execution_dispatch_retry_scheduled'),
};

const automationRunHistoryReasonLabels: Readonly<Record<string, () => string>> = {
    cancelled_after_dispatch_permitted: () =>
        t('automations.detail.runMeta.historyReason.cancelled_after_dispatch_permitted'),
    cancelled_while_running: () =>
        t('automations.detail.runMeta.historyReason.cancelled_while_running'),
    dispatch_result_missing_after_lease_expiry: () =>
        t('automations.detail.runMeta.historyReason.dispatch_result_missing_after_lease_expiry'),
    automation_retired_after_lease_expiry: () =>
        t('automations.detail.runMeta.historyReason.automation_retired_after_lease_expiry'),
};

/**
 * A transition type or reason is a server-authored token, not product
 * language, so an unrecognized one falls back to the generic lifecycle label
 * rather than being painted at the user.
 */
function formatAutomationRunHistoryEventLabel(type: string): string {
    return (automationRunHistoryEventLabels[type] ?? (
        () => t('automations.detail.runMeta.historyEvent.unknown')
    ))();
}

function formatAutomationRunHistoryReasonLabel(reason: string | null): string | null {
    if (reason === null) return null;
    const label = automationRunHistoryReasonLabels[reason];
    return label ? label() : null;
}

function joinRunFactLines(lines: readonly (string | null)[]): string | undefined {
    const present = lines.filter((line): line is string => line !== null);
    return present.length > 0 ? present.join('\n') : undefined;
}

function AutomationRunDetailPrivateContent(props: Readonly<{
    content: AutomationRunDetailPrivateContentInspection;
    accountLifetime: ServerAccountScopeLifetime | null;
}>): React.ReactElement {
    return (
        <ItemGroup title={t('automations.detail.runDetail.title')}>
            <AutomationRunDetailRecipeItems recipe={props.content.recipe} accountLifetime={props.accountLifetime} />
            <AutomationRunDetailResultItems result={props.content.result} />
            <AutomationRunDetailFailureDetailItems failureDetail={props.content.failureDetail} />
        </ItemGroup>
    );
}

/**
 * The detail route reads direct detail only to retain the freshest safe Run
 * status alongside the incumbent bounded cache. It opens private envelopes
 * through the canonical Account crypto owner and keeps that projection route-
 * local, never in the bounded Run cache.
 */
/** Resolves explicit managed correspondence before presenting a legacy occurrence; never probes another reader. */
export function WorkflowOccurrenceRunContent(props: Readonly<{
    target: Extract<WorkflowRunRouteTarget, { kind: 'occurrence' }>;
    serverId: string | null;
    active: boolean;
    renderManagedRun: (input: Readonly<{ runId: string; occurrenceDetails: React.ReactNode }>) => React.ReactElement;
}>): React.ReactElement | null {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const { automationId, runId } = props.target;
    const detail = useWorkflowOccurrenceRunDetail(props);
    const { accountLifetime, scopeUnavailable, run, runProblem, privateContent, currentDetail, loading, loadFailed, cancelling, refresh, handleCancel } = detail;
    const unknownDate = t('automations.detail.unknownDate');
    const title = runId ? t('runs.runLabel', { runId }) : t('runs.title');
    const canCancel = run?.state === 'queued' || run?.state === 'claimed' || run?.state === 'running';
    // A Run that produced a Session is the user's only pointer back to the
    // work it started, so the detail keeps that reachable rather than leaving
    // the identifier in the transport projection.
    const producedSessionId = run?.producedSessionId ?? null;
    // Only the direct detail response carries the native execution identity
    // and committed transition history; the cached list projection does not.
    const nativeExecutionRunId = currentDetail?.detail.executionNativeRunId ?? null;
    const nativeExecutionCallId = currentDetail?.detail.executionNativeCallId ?? null;
    const nativeExecutionSidechainId = currentDetail?.detail.executionNativeSidechainId ?? null;
    const runHistory = currentDetail?.detail.events ?? [];
    const claimedByMachine = useServerScopedMachine(accountLifetime?.scope.serverId ?? '', run?.claimedByMachineId ?? '');
    const claimedByLabel = claimedByMachine ? getMachineDisplayName(claimedByMachine) : null;

    if (scopeUnavailable) return <SurfaceStateCard testID="workflow-run-unavailable" kind="unavailable"
        title={t('workflows.destination.history.loadFailedTitle')} reason={t('workflows.destination.history.loadFailedBody')} />;
    const managedRunId = currentDetail?.detail.workflowRun?.workflowRunId;
    if (managedRunId !== undefined) return props.renderManagedRun({
        runId: managedRunId, occurrenceDetails: <WorkflowOccurrenceRunFacts detail={detail} />,
    });

    return (
        <ItemList>
            {/*
              * The run's identity first: what state it is in, what started it and when. The
              * facts keep their line while the run loads so nothing below moves.
              */}
            <PageHeader
                testID="automation-run-detail-header"
                title={title}
                description={t('automationPages.run.description')}
                meta={run ? [
                    { key: 'state', text: formatAutomationRunStateLabel(run) },
                    { key: 'cause', text: formatAutomationRunCauseLabel(run.cause) },
                    { key: 'admitted', text: formatDate(run.createdAt, unknownDate) },
                ] : []}
            />
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                {/*
                  * A refresh that fails while a cached Run is on screen used to
                  * change nothing visible, so a reader could not tell a settled
                  * Run from one whose status simply stopped arriving. The
                  * cached projection stays — clearing it would destroy the only
                  * data the reader has — but it is announced as stale and
                  * carries the same retry the cold-load state offers.
                  */}
                {loadFailed && run ? (
                    <AttentionBanner
                        testID="automation-run-detail-stale-refresh-error"
                        title={t('runs.runDetails.failedToLoad')}
                        announce="alert"
                        accessibilityLiveRegion="assertive"
                        action={{ label: t('common.retry'), onPress: refresh, testID: 'automation-run-detail-stale-refresh-retry' }}
                    />
                ) : null}
                {loading ? (
                    <View style={styles.loading}>
                        <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                    </View>
                ) : loadFailed && !run ? (
                    <SurfaceStateCard
                        testID="automation-run-detail-load-error"
                        kind="error"
                        title={t('common.error')}
                        reason={t('runs.runDetails.failedToLoad')}
                        action={{
                            label: t('common.retry'),
                            onPress: refresh,
                        }}
                        accessibilitySemantics="alert"
                    />
                ) : !automationId || !runId || !run ? (
                    <ItemGroup>
                        <Item
                            title={t('runs.runDetails.failedToLoad')}
                            subtitle={t('runs.empty')}
                            subtitleLines={0}
                            showChevron={false}
                            mode="info"
                            titleStyle={styles.unavailable}
                        />
                    </ItemGroup>
                ) : (
                    <>
                        <ItemGroup
                            title={t('automationPages.run.statusTitle')}
                            description={t('automationPages.run.statusDescription')}
                        >
                            <Item title={formatAutomationRunStateLabel(run)} showChevron={false} mode="info" />
                            {runProblem !== null || run.errorCode ? (
                                <Item
                                    title={runProblem?.message ?? t('automations.detail.runMeta.error', { message: run.errorCode ?? '' })}
                                    subtitleLines={0}
                                    showChevron={false}
                                    mode="info"
                                />
                            ) : null}
                            {run.errorCode === 'invalid_template' ? (
                                <Item
                                    title={t('automations.detail.runDetail.invalidTemplate')}
                                    showChevron={false}
                                    mode="info"
                                />
                            ) : null}
                            {run.executionDispatchState === 'outcomeUnknown' ? (
                                <Item
                                    title={t('automations.detail.runDetail.outcomeUnknown')}
                                    showChevron={false}
                                    mode="info"
                                />
                            ) : null}
                            <Item
                                title={t('automations.detail.runMeta.admitted', {
                                    time: formatDate(run.createdAt, unknownDate),
                                })}
                                showChevron={false}
                                mode="info"
                            />
                            {run.startedAt !== null ? (
                                <Item
                                    title={t('executionRuns.details.timestamps.started')}
                                    detail={formatDate(run.startedAt, unknownDate)}
                                    showChevron={false}
                                    mode="info"
                                />
                            ) : null}
                            {run.finishedAt !== null ? (
                                <Item
                                    title={t('executionRuns.details.timestamps.finished')}
                                    detail={formatDate(run.finishedAt, unknownDate)}
                                    showChevron={false}
                                    mode="info"
                                />
                            ) : null}
                            <Item
                                title={t('automations.detail.runMeta.updated', {
                                    time: formatDate(run.updatedAt, unknownDate),
                                })}
                                showChevron={false}
                                mode="info"
                            />
                            {run.attempt > 1 ? (
                                <Item
                                    title={t('automations.detail.runMeta.attemptTitle')}
                                    detail={t('automations.detail.runMeta.attempt', { attempt: run.attempt })}
                                    showChevron={false}
                                    mode="info"
                                />
                            ) : null}
                            {run.claimedByMachineId ? (
                                <Item
                                    title={t('automations.detail.runMeta.claimedByTitle')}
                                    detail={claimedByLabel ?? run.claimedByMachineId}
                                    subtitle={joinRunFactLines([
                                        run.claimedAt === null
                                            ? null
                                            : t('automations.detail.runMeta.claimedAt', {
                                                time: formatDate(run.claimedAt, unknownDate),
                                            }),
                                        run.leaseExpiresAt === null
                                            ? null
                                            : t('automations.detail.runMeta.leaseExpires', {
                                                time: formatDate(run.leaseExpiresAt, unknownDate),
                                            }),
                                    ])}
                                    subtitleLines={0}
                                    showChevron={false}
                                    mode="info"
                                />
                            ) : null}
                            {run.executionDispatchState !== null ? (
                                <Item
                                    title={t('automations.detail.runMeta.dispatchTitle')}
                                    detail={automationRunDispatchStateLabels[run.executionDispatchState]()}
                                    subtitle={run.executionAttempt > 0
                                        ? t('automations.detail.runMeta.dispatchAttempt', {
                                            attempt: run.executionAttempt,
                                        })
                                        : undefined}
                                    subtitleLines={0}
                                    showChevron={false}
                                    mode="info"
                                />
                            ) : null}
                            {nativeExecutionRunId ? (
                                <Item
                                    testID="automation-run-detail-native-execution"
                                    title={t('automations.detail.runMeta.nativeExecutionTitle')}
                                    subtitle={joinRunFactLines([
                                        nativeExecutionRunId,
                                        nativeExecutionCallId === null
                                            ? null
                                            : t('automations.detail.runMeta.nativeExecutionCall', {
                                                callId: nativeExecutionCallId,
                                            }),
                                        nativeExecutionSidechainId === null
                                            ? null
                                            : t('automations.detail.runMeta.nativeExecutionSidechain', {
                                                sidechainId: nativeExecutionSidechainId,
                                            }),
                                    ])}
                                    subtitleLines={0}
                                    copy={nativeExecutionRunId}
                                    showChevron={false}
                                />
                            ) : null}
                            <WorkflowOccurrenceDeliveryItems detail={detail} />
                            {producedSessionId ? (
                                <Item
                                    testID="automation-run-detail-produced-session"
                                    icon={<Icon name="chat-circle-dots" />}
                                    title={t('runs.openSession')}
                                    subtitle={producedSessionId}
                                    subtitleLines={0}
                                    onPress={() => navigateWithBlurOnWeb(
                                        // The Run was read under one Account scope; its produced
                                        // Session lives on that Home, not the active one.
                                        () => router.push(buildScopedSessionRouteHref({
                                            sessionId: producedSessionId,
                                            serverId: accountLifetime?.scope.serverId ?? null,
                                        }) as never),
                                    )}
                                />
                            ) : null}
                            {canCancel ? (
                                <Item
                                    title={t('common.cancel')}
                                    destructive
                                    onPress={() => void handleCancel()}
                                    loading={cancelling}
                                    showChevron={false}
                                />
                            ) : null}
                        </ItemGroup>
                        <WorkflowOccurrenceCauseAndHistory run={run} events={runHistory} />
                        {privateContent ? (
                            <AutomationRunDetailPrivateContent content={privateContent} accountLifetime={accountLifetime} />
                        ) : null}
                    </>
                )}
            </View>
        </ItemList>
    );
}


type OccurrenceDetail = ReturnType<typeof useWorkflowOccurrenceRunDetail>;

function WorkflowOccurrenceDeliveryItems({ detail }: Readonly<{ detail: OccurrenceDetail }>): React.ReactElement | null {
    const { run, retryingReplyHandoff, redeliveringResult, handleRetryReplyHandoff, handleDeliverResultAgain } = detail;
    if (run === null) return null;
    const unknownDate = t('automations.detail.unknownDate');
    // Retry exists only for a block an external change can still repair. When
    // the server has classified this exact Run's frozen handoff facts as
    // invalid, the recovery route refuses it, so the surface states that plainly
    // instead of offering an action that cannot work. An older server that
    // sends no classification keeps the previous behaviour.
    const replyHandoffUnrecoverable = run?.replyHandoffState === 'blocked'
        && 'replyHandoffRecoverable' in run
        && run.replyHandoffRecoverable === false;
    return <>
                            {replyHandoffUnrecoverable ? (
                                <Item
                                    testID="automation-run-reply-handoff-unrecoverable"
                                    title={t('automations.detail.runMeta.replyHandoffUnrecoverableTitle')}
                                    subtitle={t('automations.detail.runMeta.replyHandoffUnrecoverableSubtitle')}
                                    showChevron={false}
                                    mode="info"
                                />
                            ) : null}
                            {run.replyHandoffState !== 'none' ? (
                                <Item
                                    title={t('automations.detail.runMeta.replyHandoffTitle')}
                                    detail={automationRunReplyHandoffStateLabels[run.replyHandoffState]()}
                                    subtitle={joinRunFactLines([
                                        run.replyHandoffAttempt > 0
                                            ? t('automations.detail.runMeta.replyHandoffAttempt', {
                                                attempt: run.replyHandoffAttempt,
                                            })
                                            : null,
                                        run.replyHandoffDueAt === null
                                            ? null
                                            : t('automations.detail.runMeta.replyHandoffDue', {
                                                time: formatDate(run.replyHandoffDueAt, unknownDate),
                                            }),
                                    ])}
                                    subtitleLines={0}
                                    showChevron={false}
                                    mode="info"
                                />
                            ) : null}
                            {run.replyHandoffState === 'blocked' && !replyHandoffUnrecoverable ? (
                                <Item
                                    testID="automation-run-retry-reply-handoff"
                                    title={t('common.retry')}
                                    subtitle={t('automations.detail.runMeta.replyHandoffTitle')}
                                    onPress={() => void handleRetryReplyHandoff()}
                                    loading={retryingReplyHandoff}
                                    showChevron={false}
                                />
                            ) : null}
                            {run.replyHandoffState === 'accepted' ? (
                                <Item
                                    testID="automation-run-deliver-result-again"
                                    title={t('automations.detail.runMeta.replyHandoffDeliverAgainTitle')}
                                    subtitle={t('automations.detail.runMeta.replyHandoffDeliverAgainSubtitle')}
                                    onPress={() => void handleDeliverResultAgain(run.revision)}
                                    loading={redeliveringResult}
                                    showChevron={false}
                                />
                            ) : null}
    </>;
}

function WorkflowOccurrenceCauseAndHistory({ run, events: runHistory }: Readonly<{
    run: NonNullable<OccurrenceDetail['run']>;
    events: AutomationV3RunDetail['events'];
}>): React.ReactElement {
    const unknownDate = t('automations.detail.unknownDate');
    const occurrenceKey = run?.cause.kind === 'trigger' || run?.cause.kind === 'conversation'
        ? run.cause.occurrenceKey
        : null;
    const sourceSelectorId = run?.cause.kind === 'trigger' && run.cause.triggerKind === 'pluginEvent'
        ? run.cause.evidence.sourceSelectorId
        : null;
    const eventRef = run?.cause.kind === 'trigger' && run.cause.triggerKind === 'pluginEvent'
        ? run.cause.evidence.eventRef
        : null;
    const triggerCause = run?.cause.kind === 'trigger' ? run.cause : null;
    const triggerRetired = run?.triggerRetired === true;
    return <>
                        <ItemGroup
                            title={t('automationPages.run.causeTitle')}
                            description={t('automationPages.run.causeDescription')}
                        >
                            <Item
                                title={t('automations.detail.runMeta.causeTitle')}
                                detail={formatAutomationRunCauseLabel(run.cause)}
                                showChevron={false}
                                mode="info"
                            />
                            <Item
                                title={formatRunCauseTime(run.cause, unknownDate)}
                                showChevron={false}
                                mode="info"
                            />
                            {triggerCause ? (
                                <Item
                                    title={t('automations.detail.runMeta.triggerIdentityTitle')}
                                    subtitle={t('automations.detail.runMeta.triggerIdentity', {
                                        id: triggerCause.triggerId,
                                        revision: triggerCause.triggerRevision,
                                    })}
                                    subtitleLines={0}
                                    copy={`${triggerCause.triggerId}@${triggerCause.triggerRevision}`}
                                    showChevron={false}
                                />
                            ) : null}
                            {triggerRetired ? (
                                <Item
                                    testID="automation-run-trigger-retired"
                                    title={t('automations.detail.runMeta.triggerRetired')}
                                    subtitle={t('automations.detail.runMeta.triggerRetiredSubtitle')}
                                    subtitleLines={0}
                                    showChevron={false}
                                    mode="info"
                                />
                            ) : null}
                            {occurrenceKey ? (
                                <Item
                                    title={t('automations.detail.runMeta.occurrenceTitle')}
                                    subtitle={occurrenceKey}
                                    subtitleLines={0}
                                    copy={occurrenceKey}
                                    showChevron={false}
                                />
                            ) : null}
                            {sourceSelectorId ? (
                                <Item
                                    title={t('automations.detail.runMeta.sourceTitle')}
                                    subtitle={sourceSelectorId}
                                    subtitleLines={0}
                                    copy={sourceSelectorId}
                                    showChevron={false}
                                />
                            ) : null}
                            {eventRef ? (
                                <Item
                                    title={t('automations.detail.runMeta.eventReferenceTitle')}
                                    subtitle={`${eventRef.pluginId}/${eventRef.localId}`}
                                    subtitleLines={0}
                                    copy={`${eventRef.pluginId}/${eventRef.localId}`}
                                    showChevron={false}
                                />
                            ) : null}
                            {triggerCause?.triggerKind === 'sessionLifecycle' ? (
                                <AutomationRunLifecycleCauseItems cause={triggerCause} />
                            ) : null}
                        </ItemGroup>
                        {runHistory.length > 0 ? (
                            <ItemGroup title={t('automations.detail.runMeta.historyTitle')}>
                                {runHistory.map((event, index) => (
                                    <Item
                                        key={`${event.at}-${event.type}-${index}`}
                                        title={formatAutomationRunHistoryEventLabel(event.type)}
                                        detail={formatDate(event.at, unknownDate)}
                                        subtitle={joinRunFactLines([
                                            formatAutomationRunHistoryReasonLabel(event.reason),
                                            event.errorCode === null
                                                ? null
                                                : t('automations.detail.runMeta.error', {
                                                    message: event.errorCode,
                                                }),
                                            event.executionAttempt === null
                                                ? null
                                                : t('automations.detail.runMeta.dispatchAttempt', {
                                                    attempt: event.executionAttempt,
                                                }),
                                        ])}
                                        subtitleLines={0}
                                        showChevron={false}
                                        mode="info"
                                    />
                                ))}
                            </ItemGroup>
                        ) : null}
    </>;
}

/** Delivery recovery and immutable provenance supplement the canonical managed Run body. */
function WorkflowOccurrenceRunFacts({ detail }: Readonly<{ detail: OccurrenceDetail }>): React.ReactElement {
    const { run, currentDetail, loading, loadFailed, refresh } = detail;
    return <>
        {loadFailed ? <AttentionBanner testID="automation-run-detail-stale-refresh-error"
            title={t('runs.runDetails.failedToLoad')} announce="alert" accessibilityLiveRegion="assertive"
            action={{ label: t('common.retry'), onPress: refresh, testID: 'automation-run-detail-stale-refresh-retry' }} /> : null}
        {run === null ? loading ? <ActivitySpinner size="small" /> : null : <>
            {run.replyHandoffState === 'none' ? null : <ItemGroup title={t('automations.detail.runMeta.replyHandoffTitle')}>
                <WorkflowOccurrenceDeliveryItems detail={detail} />
            </ItemGroup>}
            <WorkflowOccurrenceCauseAndHistory run={run} events={currentDetail?.detail.events ?? []} />
        </>}
    </>;
}

/** Direct managed links acquire their occurrence facts through the same reader, with no legacy page mounted. */
export function WorkflowOccurrenceRunDetails(props: Readonly<{
    target: Extract<WorkflowRunRouteTarget, { kind: 'occurrence' }>;
    serverId: string | null;
    active: boolean;
}>): React.ReactElement {
    const detail = useWorkflowOccurrenceRunDetail(props);
    return <WorkflowOccurrenceRunFacts detail={detail} />;
}
