import * as React from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    createCanonicalJsonSigningInput,
    type AutomationRunCause,
    type AutomationV3RunDetail,
} from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { layout } from '@/components/ui/layout/layout';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useAllMachines, useAutomationRuns } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { t } from '@/text';
import { navigateWithBlurOnWeb } from '@/utils/platform/deferOnWeb';
import { getMachineDisplayName } from '@/utils/sessions/machineUtils';
import {
    formatAutomationRunStateLabel,
    formatAutomationRunCauseLabel,
} from '@/components/automations/list/automationListFormatting';
import type {
    AutomationRunDetailPrivateContentInspection,
    AutomationRunDetailRouteInspection,
} from '@/sync/domains/automations/automationRunDetailInspection';
import type { AutomationDefinitionRun } from '@/sync/domains/automations/automationTypes';

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

function normalizeParam(value: string | string[] | undefined): string | null {
    if (typeof value === 'string' && value.trim().length > 0) return value.trim();
    if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim().length > 0) return value[0].trim();
    return null;
}

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

function formatRunTarget(target: AutomationRunDetailTarget): string {
    switch (target.kind) {
        case 'existingSession':
            return t('automations.detail.runDetail.existingSession', { sessionId: target.sessionId });
        case 'newSession':
            return t('automations.detail.runDetail.newSession', {
                machineId: target.spawn.executionTarget.machineId,
                directory: target.spawn.directory,
            });
        case 'executionRun':
            return t('automations.detail.runDetail.executionRun', {
                permissionMode: target.request.permissionMode,
            });
    }
}

function getRunTargetPrompt(target: AutomationRunDetailTarget): string {
    switch (target.kind) {
        case 'existingSession':
            return target.prompt;
        case 'newSession':
            return target.spawn.initialInput?.text ?? t('common.unavailable');
        case 'executionRun':
            return target.request.instructions ?? t('common.unavailable');
    }
}

function AutomationRunDetailEvidenceItems(props: Readonly<{
    evidence: AutomationRunDetailEvidence;
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
                    showChevron={false}
                    mode="info"
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
                    subtitleLines={3}
                    copy={payload}
                    showChevron={false}
                    mode="info"
                />
            </>
        );
    }

    const input = formatStructuredPrivateDetail(evidence.input);
    return (
        <>
            <Item
                title={t('automations.detail.runDetail.conversation')}
                subtitle={evidence.bindingId}
                showChevron={false}
                mode="info"
            />
            <Item
                title={t('automations.detail.runDetail.input')}
                subtitle={input}
                subtitleLines={3}
                copy={input}
                showChevron={false}
                mode="info"
            />
        </>
    );
}

function AutomationRunDetailRecipeItems(props: Readonly<{
    recipe: AutomationRunDetailPrivateContentInspection['recipe'];
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
                    <AutomationRunDetailEvidenceItems evidence={recipe.evidence} />
                    <Item
                        title={t('automations.detail.runDetail.target')}
                        subtitle={formatRunTarget(recipe.target)}
                        showChevron={false}
                        mode="info"
                    />
                    <Item
                        title={t('automations.detail.runDetail.prompt')}
                        subtitle={targetPrompt}
                        subtitleLines={3}
                        copy={targetPrompt}
                        showChevron={false}
                        mode="info"
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
                    subtitleLines={3}
                    copy={result.result.text}
                    showChevron={false}
                    mode="info"
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
                    subtitleLines={3}
                    copy={failureDetail.detail}
                    showChevron={false}
                    mode="info"
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
}>): React.ReactElement {
    return (
        <ItemGroup title={t('automations.detail.runDetail.title')}>
            <AutomationRunDetailRecipeItems recipe={props.content.recipe} />
            <AutomationRunDetailResultItems result={props.content.result} />
            <AutomationRunDetailFailureDetailItems failureDetail={props.content.failureDetail} />
        </ItemGroup>
    );
}

type RouteScopedState<T> = Readonly<{
    generation: number;
    value: T;
}>;

type AccountScopedRouteState<T> = RouteScopedState<T> & Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
}>;

/**
 * The detail route reads direct detail only to retain the freshest safe Run
 * status alongside the incumbent bounded cache. It opens private envelopes
 * through the canonical Account crypto owner and keeps that projection route-
 * local, never in the bounded Run cache.
 */
export function AutomationRunDetailScreen(): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const params = useLocalSearchParams<{ id?: string | string[]; runId?: string | string[] }>();
    const automationId = normalizeParam(params.id);
    const runId = normalizeParam(params.runId);
    const runs = useAutomationRuns(automationId ?? '');
    const machines = useAllMachines();
    const cachedRun = runs.find((candidate) => candidate.id === runId) ?? null;
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const routeCurrentRef = React.useRef({
        automationId,
        runId,
        generation: 0,
        mounted: true,
    });
    // A successful cancellation publishes a newer bounded Run through the
    // incumbent store. Direct reads started before that mutation must not
    // reclaim this route after the store has accepted the cancellation.
    const directReadEpochRef = React.useRef(0);
    if (
        routeCurrentRef.current.automationId !== automationId
        || routeCurrentRef.current.runId !== runId
    ) {
        routeCurrentRef.current = {
            automationId,
            runId,
            generation: routeCurrentRef.current.generation + 1,
            mounted: routeCurrentRef.current.mounted,
        };
    }
    const routeGeneration = routeCurrentRef.current.generation;
    React.useEffect(() => {
        routeCurrentRef.current.mounted = true;
        return () => {
            routeCurrentRef.current.mounted = false;
        };
    }, []);
    const isCurrentRoute = React.useCallback((expectedAutomationId: string | null, expectedRunId: string | null, expectedGeneration: number): boolean => {
        const current = routeCurrentRef.current;
        return current.mounted
            && current.automationId === expectedAutomationId
            && current.runId === expectedRunId
            && current.generation === expectedGeneration;
    }, []);
    const [directDetailState, setDirectDetailState] = React.useState<AccountScopedRouteState<AutomationRunDetailRouteInspection | null>>({
        generation: routeGeneration,
        accountLifetime,
        value: null,
    });
    const [loadingState, setLoadingState] = React.useState<RouteScopedState<boolean>>({
        generation: routeGeneration,
        value: cachedRun === null,
    });
    const [loadFailureState, setLoadFailureState] = React.useState<RouteScopedState<boolean>>({
        generation: routeGeneration,
        value: false,
    });
    const [cancellingState, setCancellingState] = React.useState<RouteScopedState<boolean>>({
        generation: routeGeneration,
        value: false,
    });
    const [retryingReplyHandoffState, setRetryingReplyHandoffState] = React.useState<RouteScopedState<boolean>>({
        generation: routeGeneration,
        value: false,
    });
    const directDetail = directDetailState.generation === routeGeneration
        && directDetailState.accountLifetime === accountLifetime
        && accountLifetime?.isCurrent() === true
        ? directDetailState.value
        : null;
    const directDetailIsCurrent = directDetail !== null
        && (!cachedRun || directDetail.detail.updatedAt >= cachedRun.updatedAt);
    const run = directDetailIsCurrent
        ? directDetail.detail
        : cachedRun;
    const privateContent = directDetailIsCurrent
        ? directDetail.privateContent
        : null;
    const loading = loadingState.generation !== routeGeneration || loadingState.value;
    const loadFailed = loadFailureState.generation === routeGeneration && loadFailureState.value;
    const cancelling = cancellingState.generation === routeGeneration && cancellingState.value;
    const retryingReplyHandoff = retryingReplyHandoffState.generation === routeGeneration
        && retryingReplyHandoffState.value;

    React.useEffect(() => {
        const retirement = accountLifetime?.onRetire(() => {
            directReadEpochRef.current += 1;
            setDirectDetailState((current) => (
                current.accountLifetime === accountLifetime
                    ? { ...current, value: null }
                    : current
            ));
        });
        return () => retirement?.dispose();
    }, [accountLifetime]);

    const refresh = React.useCallback(() => {
        const request = {
            automationId,
            runId,
            generation: routeGeneration,
            directReadEpoch: directReadEpochRef.current,
            accountLifetime,
        };
        const isCurrentRequest = () => (
            isCurrentRoute(request.automationId, request.runId, request.generation)
            && request.accountLifetime?.isCurrent() === true
        );
        if (!automationId || !runId || !request.accountLifetime?.isCurrent()) {
            if (isCurrentRoute(request.automationId, request.runId, request.generation)) {
                setDirectDetailState({
                    generation: request.generation,
                    accountLifetime: request.accountLifetime,
                    value: null,
                });
                setLoadingState({ generation: request.generation, value: false });
                setLoadFailureState({ generation: request.generation, value: false });
            }
            return;
        }

        setLoadFailureState({ generation: request.generation, value: false });
        if (!cachedRun) {
            setLoadingState({ generation: request.generation, value: true });
        }
        const directRead = sync.getAutomationRunDetailInspection(automationId, runId)
            .then((detail) => {
                if (
                    !isCurrentRequest()
                    || directReadEpochRef.current !== request.directReadEpoch
                ) return;
                setDirectDetailState({
                    generation: request.generation,
                    accountLifetime: request.accountLifetime,
                    value: detail,
                });
            })
            // A direct route read may fail, but Account material/currentness
            // unavailability is represented by the route projection itself.
            // Keep the bounded cached Run projection visible on transport
            // failure and never surface raw envelope bytes.
            .catch(() => {
                if (isCurrentRequest()) {
                    setLoadFailureState({ generation: request.generation, value: true });
                }
            });
        const rootPageRefresh = cachedRun
            ? Promise.resolve()
            : sync.fetchAutomationRuns(automationId).catch(() => {
                if (isCurrentRequest()) {
                    setLoadFailureState({ generation: request.generation, value: true });
                }
            });

        void Promise.all([directRead, rootPageRefresh])
            .finally(() => {
                if (isCurrentRequest()) {
                    setLoadingState({ generation: request.generation, value: false });
                }
            });
    }, [accountLifetime, automationId, cachedRun, isCurrentRoute, routeGeneration, runId]);

    React.useEffect(() => {
        refresh();
    }, [refresh]);

    const handleCancel = React.useCallback(async () => {
        if (!runId) return;
        const request = { automationId, runId, generation: routeGeneration };
        try {
            setCancellingState({ generation: request.generation, value: true });
            await sync.cancelAutomationRun(request.runId);
            if (!isCurrentRoute(request.automationId, request.runId, request.generation)) return;
            directReadEpochRef.current += 1;
            // The mutation's bounded Run projection is already in the one
            // cache owner. Clear the direct private response so it cannot
            // visually regress the freshly cancelled state.
            setDirectDetailState({
                generation: request.generation,
                accountLifetime,
                value: null,
            });
        } catch (error) {
            if (!isCurrentRoute(request.automationId, request.runId, request.generation)) return;
            await Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('automations.detail.runFailed'),
            );
        } finally {
            if (isCurrentRoute(request.automationId, request.runId, request.generation)) {
                setCancellingState({ generation: request.generation, value: false });
            }
        }
    }, [accountLifetime, automationId, isCurrentRoute, routeGeneration, runId]);

    const handleRetryReplyHandoff = React.useCallback(async () => {
        if (!runId) return;
        const request = { automationId, runId, generation: routeGeneration };
        try {
            setRetryingReplyHandoffState({ generation: request.generation, value: true });
            await sync.retryAutomationReplyHandoff(request.runId);
            if (!isCurrentRoute(request.automationId, request.runId, request.generation)) return;
            directReadEpochRef.current += 1;
            setDirectDetailState({
                generation: request.generation,
                accountLifetime,
                value: null,
            });
        } catch (error) {
            if (!isCurrentRoute(request.automationId, request.runId, request.generation)) return;
            await Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('automations.detail.runFailed'),
            );
        } finally {
            if (isCurrentRoute(request.automationId, request.runId, request.generation)) {
                setRetryingReplyHandoffState({ generation: request.generation, value: false });
            }
        }
    }, [accountLifetime, automationId, isCurrentRoute, routeGeneration, runId]);

    const unknownDate = t('automations.detail.unknownDate');
    const title = runId ? t('runs.runLabel', { runId }) : t('runs.title');
    const canCancel = run?.state === 'queued' || run?.state === 'claimed' || run?.state === 'running';
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
    // A Run that produced a Session is the user's only pointer back to the
    // work it started, so the detail keeps that reachable rather than leaving
    // the identifier in the transport projection.
    const producedSessionId = run?.producedSessionId ?? null;
    // Only the direct detail response carries the native execution identity
    // and committed transition history; the cached list projection does not.
    const nativeExecutionRunId = directDetailIsCurrent
        ? directDetail.detail.executionNativeRunId
        : null;
    const nativeExecutionCallId = directDetailIsCurrent
        ? directDetail.detail.executionNativeCallId
        : null;
    const nativeExecutionSidechainId = directDetailIsCurrent
        ? directDetail.detail.executionNativeSidechainId
        : null;
    const runHistory = directDetailIsCurrent ? directDetail.detail.events : [];
    const claimedByMachine = run?.claimedByMachineId
        ? machines.find((candidate) => candidate.id === run.claimedByMachineId)
        : undefined;
    const claimedByLabel = claimedByMachine ? getMachineDisplayName(claimedByMachine) : null;

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <Stack.Screen options={{ headerShown: true, headerTitle: title }} />
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
                    <ItemGroup>
                        <Item
                            testID="automation-run-detail-stale-refresh-error"
                            title={t('runs.runDetails.failedToLoad')}
                            icon={<Icon name="warning" size={20} color={theme.colors.state.warning.foreground} />}
                            mode="info"
                            showChevron={false}
                            accessibilityRole="alert"
                            accessibilityLiveRegion="assertive"
                            webRole="alert"
                        />
                        <Item
                            testID="automation-run-detail-stale-refresh-retry"
                            title={t('common.retry')}
                            icon={<Icon name="arrow-clockwise" size={20} color={theme.colors.accent.blue} />}
                            onPress={refresh}
                            showChevron={false}
                        />
                    </ItemGroup>
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
                    <ItemGroup title={t('automations.detail.recentRunsTitle')}>
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
                        <ItemGroup title={t('automations.detail.recentRunsTitle')}>
                            <Item title={formatAutomationRunStateLabel(run.state)} showChevron={false} mode="info" />
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
                                    mode="info"
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
                                    showChevron={false}
                                    mode="info"
                                />
                            ) : null}
                            {sourceSelectorId ? (
                                <Item
                                    title={t('automations.detail.runMeta.sourceTitle')}
                                    subtitle={sourceSelectorId}
                                    subtitleLines={0}
                                    showChevron={false}
                                    mode="info"
                                />
                            ) : null}
                            {eventRef ? (
                                <Item
                                    title={t('automations.detail.runMeta.eventReferenceTitle')}
                                    subtitle={`${eventRef.pluginId}/${eventRef.localId}`}
                                    subtitleLines={0}
                                    copy={`${eventRef.pluginId}/${eventRef.localId}`}
                                    showChevron={false}
                                    mode="info"
                                />
                            ) : null}
                            {triggerCause?.triggerKind === 'sessionLifecycle' ? (
                                <>
                                    <Item
                                        title={t('automations.detail.trigger.sourceSession')}
                                        subtitle={triggerCause.evidence.sourceSessionId}
                                        copy={triggerCause.evidence.sourceSessionId}
                                        showChevron={false}
                                        mode="info"
                                    />
                                    <Item
                                        title={t('automations.detail.trigger.sourceTurn')}
                                        subtitle={triggerCause.evidence.sourceTurnId}
                                        copy={triggerCause.evidence.sourceTurnId}
                                        showChevron={false}
                                        mode="info"
                                    />
                                </>
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
                                    mode="info"
                                />
                            ) : null}
                            {producedSessionId ? (
                                <Item
                                    testID="automation-run-detail-produced-session"
                                    title={t('runs.openSession')}
                                    subtitle={producedSessionId}
                                    subtitleLines={0}
                                    onPress={() => navigateWithBlurOnWeb(
                                        () => router.push(`/session/${producedSessionId}` as never),
                                    )}
                                />
                            ) : null}
                            {run.errorCode ? (
                                <Item
                                    title={t('automations.detail.runMeta.error', { message: run.errorCode })}
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
                            {canCancel ? (
                                <Item
                                    title={t('common.cancel')}
                                    destructive
                                    onPress={() => void handleCancel()}
                                    loading={cancelling}
                                    showChevron={false}
                                />
                            ) : null}
                            {run.replyHandoffState === 'blocked' ? (
                                <Item
                                    testID="automation-run-retry-reply-handoff"
                                    title={t('common.retry')}
                                    subtitle={t('automations.detail.runMeta.replyHandoffTitle')}
                                    onPress={() => void handleRetryReplyHandoff()}
                                    loading={retryingReplyHandoff}
                                    showChevron={false}
                                />
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
                        {privateContent ? (
                            <AutomationRunDetailPrivateContent content={privateContent} />
                        ) : null}
                    </>
                )}
            </View>
        </ItemList>
    );
}
