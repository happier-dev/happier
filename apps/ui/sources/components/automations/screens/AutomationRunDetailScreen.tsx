import * as React from 'react';
import { View } from 'react-native';
import { Stack, useLocalSearchParams } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    createCanonicalJsonSigningInput,
    type AutomationV3RunDetail,
} from '@happier-dev/protocol';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { layout } from '@/components/ui/layout/layout';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { useAutomationRuns } from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import { Modal } from '@/modal';
import { t } from '@/text';
import { getAutomationRunOriginTranslationKey } from '@/components/automations/list/automationListFormatting';
import type {
    AutomationRunDetailPrivateContentInspection,
    AutomationRunDetailRouteInspection,
} from '@/sync/domains/automations/automationRunDetailInspection';

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

function formatRunOriginTime(
    run: Pick<AutomationV3RunDetail, 'origin'>,
    unknownLabel: string,
): string {
    switch (run.origin.kind) {
        case 'scheduled':
            return t('automations.detail.runMeta.scheduled', {
                time: formatDate(run.origin.scheduledFor, unknownLabel),
            });
        case 'manual':
            return t('automations.detail.runMeta.invoked', {
                time: formatDate(run.origin.invokedAt, unknownLabel),
            });
        case 'pluginEvent':
        case 'conversation':
            return t('automations.detail.runMeta.occurred', {
                time: formatDate(run.origin.occurredAt, unknownLabel),
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
            return target.spawn.initialMessage ?? t('common.unavailable');
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
 * The detail route reads direct V3 detail only to retain the freshest safe Run
 * status alongside the incumbent bounded cache. It opens private envelopes
 * through the canonical Account crypto owner and keeps that projection route-
 * local, never in the bounded Run cache.
 */
export function AutomationRunDetailScreen(): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const params = useLocalSearchParams<{ id?: string | string[]; runId?: string | string[] }>();
    const automationId = normalizeParam(params.id);
    const runId = normalizeParam(params.runId);
    const runs = useAutomationRuns(automationId ?? '');
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
    const privateContent = directDetailIsCurrent ? directDetail.privateContent : null;
    const loading = loadingState.generation !== routeGeneration || loadingState.value;
    const loadFailed = loadFailureState.generation === routeGeneration && loadFailureState.value;
    const cancelling = cancellingState.generation === routeGeneration && cancellingState.value;

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

    const unknownDate = t('automations.detail.unknownDate');
    const title = runId ? t('runs.runLabel', { runId }) : t('runs.title');
    const canCancel = run?.state === 'queued' || run?.state === 'claimed' || run?.state === 'running';
    const occurrenceKey = run?.origin.kind === 'pluginEvent' || run?.origin.kind === 'conversation'
        ? run.origin.occurrenceKey
        : null;
    const sourceSelectorId = run?.origin.kind === 'pluginEvent'
        ? run.origin.sourceSelectorId
        : null;

    return (
        <ItemList style={{ paddingTop: 0 }}>
            <Stack.Screen options={{ headerShown: true, headerTitle: title }} />
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
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
                            <Item title={run.state.toUpperCase()} showChevron={false} mode="info" />
                            <Item
                                title={t('automations.detail.runMeta.originTitle')}
                                detail={t(getAutomationRunOriginTranslationKey(run.origin))}
                                showChevron={false}
                                mode="info"
                            />
                            <Item
                                title={formatRunOriginTime(run, unknownDate)}
                                showChevron={false}
                                mode="info"
                            />
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
                            <Item
                                title={t('automations.detail.runMeta.admitted', {
                                    time: formatDate(run.createdAt, unknownDate),
                                })}
                                showChevron={false}
                                mode="info"
                            />
                            <Item
                                title={t('automations.detail.runMeta.updated', {
                                    time: formatDate(run.updatedAt, unknownDate),
                                })}
                                showChevron={false}
                                mode="info"
                            />
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
                        </ItemGroup>
                        {privateContent ? (
                            <AutomationRunDetailPrivateContent content={privateContent} />
                        ) : null}
                    </>
                )}
            </View>
        </ItemList>
    );
}
