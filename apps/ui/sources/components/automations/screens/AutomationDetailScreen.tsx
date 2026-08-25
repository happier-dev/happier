import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    createCanonicalJsonSigningInput,
    MAX_AUTOMATION_RESULT_TEXT_UTF8_BYTES,
    type AutomationEventSourceStatusV1,
    type AutomationRunExecutionRecipeV1,
    type AutomationV3EventSourceCatalogStatus,
} from '@happier-dev/protocol';

import { Modal } from '@/modal';
import { useAllMachines, useAutomation, useAutomationRunNextCursor, useAutomationRuns } from '@/sync/domains/state/storage';
import { getAutomationDefinitionRunOriginAt } from '@/sync/domains/automations/automationRunOrigin';
import { readLegacyScheduleAutomationDefinition } from '@/sync/domains/automations/automationLegacyScheduleDefinition';
import { isPluginEventAutomationDefinition } from '@/sync/domains/automations/automationTypes';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { sync } from '@/sync/sync';
import { upsertAutomationAssignmentToggle } from '@/components/automations/screens/automationAssignmentsModel';
import {
    formatAutomationRunStateLabel,
    formatAutomationTriggerLabel,
    getAutomationRunOriginTranslationKey,
} from '@/components/automations/list/automationListFormatting';
import { ItemList } from '@/components/ui/lists/ItemList';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Item } from '@/components/ui/lists/Item';
import { VirtualizedList } from '@/components/ui/lists/virtualized';
import { Switch } from '@/components/ui/forms/Switch';
import { Text } from '@/components/ui/text/Text';
import { layout } from '@/components/ui/layout/layout';
import { t } from '@/text';
import { navigateWithBlurOnWeb } from '@/utils/platform/deferOnWeb';
import { getMachineDisplayName, isMachineOnline } from '@/utils/sessions/machineUtils';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { formatByteSize } from '@/utils/files/formatByteSize';
import {
    readPluginEventAutomationEditSeed,
    readPluginEventAutomationPrivateDetail,
} from '@/components/automations/editor/pluginEventAutomationEditSeed';
import type { AutomationDefinitionRun } from '@/sync/domains/automations/automationTypes';

import { AutomationHistoryGapRecoveryAction } from './AutomationHistoryGapRecoveryAction';
import {
    canPresentAutomationSourceSummary,
    formatAutomationWatcherImpediment,
    resolveAutomationWatcherHealth,
} from './automationWatcherHealth';

const stylesheet = StyleSheet.create((theme) => ({
    loading: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
    },
    emptyRuns: {
        alignItems: 'center',
        justifyContent: 'center',
        paddingVertical: 24,
        gap: 8,
    },
    emptyRunsText: {
        color: theme.colors.text.secondary,
        fontSize: 13,
    },
}));

function formatDate(ms: number, unknownLabel: string): string {
    try {
        return new Date(ms).toLocaleString();
    } catch {
        return unknownLabel;
    }
}

const automationSourceStatusStateLabels = {
    uninitialized: () => t('settingsPlugins.eventAutomationComposer.sourceStatusState.uninitialized'),
    baselined: () => t('settingsPlugins.eventAutomationComposer.sourceStatusState.baselined'),
    observing: () => t('settingsPlugins.eventAutomationComposer.sourceStatusState.observing'),
    backingOff: () => t('settingsPlugins.eventAutomationComposer.sourceStatusState.backingOff'),
    attention: () => t('settingsPlugins.eventAutomationComposer.sourceStatusState.attention'),
} satisfies Record<AutomationEventSourceStatusV1['state'], () => string>;

const automationSourceStatusCodeLabels = {
    credentialMissing: () => t('settingsPlugins.eventAutomationComposer.sourceStatusCode.credentialMissing'),
    credentialRevoked: () => t('settingsPlugins.eventAutomationComposer.sourceStatusCode.credentialRevoked'),
    rateLimited: () => t('settingsPlugins.eventAutomationComposer.sourceStatusCode.rateLimited'),
    historyGap: () => t('settingsPlugins.eventAutomationComposer.sourceStatusCode.historyGap'),
    capacityBlocked: () => t('settingsPlugins.eventAutomationComposer.sourceStatusCode.capacityBlocked'),
    definitionStale: () => t('settingsPlugins.eventAutomationComposer.sourceStatusCode.definitionStale'),
    sourceContractIncompatible: () => t('settingsPlugins.eventAutomationComposer.sourceStatusCode.sourceContractIncompatible'),
    admissionUnavailable: () => t('settingsPlugins.eventAutomationComposer.sourceStatusCode.admissionUnavailable'),
} satisfies Record<NonNullable<AutomationEventSourceStatusV1['code']>, () => string>;

const automationSourceCatalogStatusStateLabels = {
    current: () => t('settingsPlugins.eventAutomationComposer.sourceCatalogStatusState.current'),
    reconciling: () => t('settingsPlugins.eventAutomationComposer.sourceCatalogStatusState.reconciling'),
    reconciliationLate: () => t('settingsPlugins.eventAutomationComposer.sourceCatalogStatusState.reconciliationLate'),
} satisfies Record<AutomationV3EventSourceCatalogStatus['state'], () => string>;

/**
 * The state label alone says how the source feels, not whether it is still
 * seeing anything. The admission tallies and the last observation are the
 * facts that separate a healthy observing source from one that is observing
 * and skipping everything, so they render alongside the impediment.
 */
function formatAutomationSourceStatusSubtitle(
    status: AutomationEventSourceStatusV1,
    unknownDate: string,
): string {
    const details = [
        status.code ? automationSourceStatusCodeLabels[status.code]() : null,
        t('settingsPlugins.eventAutomationComposer.sourceStatusObservedCount', {
            count: status.observedCount,
        }),
        t('settingsPlugins.eventAutomationComposer.sourceStatusAdmittedCount', {
            count: status.admittedCount,
        }),
        t('settingsPlugins.eventAutomationComposer.sourceStatusSkippedCount', {
            count: status.skippedCount,
        }),
        status.lastObservedAt === null
            ? null
            : t('settingsPlugins.eventAutomationComposer.sourceStatusLastObserved', {
                time: formatDate(status.lastObservedAt, unknownDate),
            }),
        status.nextRetryAt === null
            ? null
            : t('settingsPlugins.eventAutomationComposer.sourceStatusNextRetry', {
                time: formatDate(status.nextRetryAt, unknownDate),
            }),
    ].filter((value): value is string => value !== null);

    return details.join('\n');
}

function formatAutomationSourceCatalogStatusSubtitle(
    status: AutomationV3EventSourceCatalogStatus,
    unknownDate: string,
): string {
    const details = [
        t('settingsPlugins.eventAutomationComposer.sourceCatalogStatusObservedRevision', {
            revision: status.observedRevision,
        }),
        status.adoptedRevision === null
            ? t('settingsPlugins.eventAutomationComposer.sourceCatalogStatusNoAdoptedRevision')
            : t('settingsPlugins.eventAutomationComposer.sourceCatalogStatusAdoptedRevision', {
                revision: status.adoptedRevision,
            }),
        status.scanStartedAt === null
            ? null
            : t('settingsPlugins.eventAutomationComposer.sourceCatalogStatusScanStarted', {
                time: formatDate(status.scanStartedAt, unknownDate),
            }),
        status.nextRetryAt === null
            ? null
            : t('settingsPlugins.eventAutomationComposer.sourceStatusNextRetry', {
                time: formatDate(status.nextRetryAt, unknownDate),
            }),
    ].filter((value): value is string => value !== null);

    return details.join('\n');
}

function formatAutomationAssignmentSubtitle(params: {
    machine: Machine;
    duplicateTitle: boolean;
}): string {
    const host = typeof params.machine.metadata?.host === 'string' ? params.machine.metadata.host.trim() : '';
    const displayName = typeof params.machine.metadata?.displayName === 'string'
        ? params.machine.metadata.displayName.trim()
        : '';
    const platform = typeof params.machine.metadata?.platform === 'string' ? params.machine.metadata.platform.trim() : '';
    const statusText = t(isMachineOnline(params.machine) ? 'status.online' : 'status.offline');
    const detailParts = [
        platform || null,
        statusText,
        params.duplicateTitle ? params.machine.id.slice(0, 8) : null,
    ].filter((value): value is string => Boolean(value));
    const secondaryLine = detailParts.join(' • ');

    if (host && displayName && host !== displayName) {
        return secondaryLine ? `${host}\n${secondaryLine}` : host;
    }

    return secondaryLine || host || params.machine.id;
}

function formatAutomationDefinitionTarget(target: AutomationRunExecutionRecipeV1['target']): string {
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

function formatStructuredPrivateDetail(value: unknown): string {
    try {
        return createCanonicalJsonSigningInput(value);
    } catch {
        return t('common.unavailable');
    }
}

type RouteScopedState<T> = Readonly<{
    generation: number;
    value: T;
}>;

// Keep the visible history page aligned with the canonical continuation
// request size. The store owns the accumulated traversal and cursor; this
// screen owns only which already-retained page it presents.
const AUTOMATION_RUN_HISTORY_PAGE_SIZE = 20;

type AutomationDetailRunHistoryRow =
    | Readonly<{ kind: 'run'; key: string; run: AutomationDefinitionRun }>
    | Readonly<{ kind: 'empty'; key: 'empty' }>
    | Readonly<{ kind: 'previous'; key: 'previous' }>
    | Readonly<{ kind: 'loadMore'; key: 'loadMore' }>;

export function AutomationDetailScreen() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const router = useRouter();
    const params = useLocalSearchParams<{ id?: string }>();
    const automationId = typeof params.id === 'string' ? params.id : '';
    const routeCurrentRef = React.useRef({
        automationId,
        generation: 0,
        mounted: true,
    });
    if (routeCurrentRef.current.automationId !== automationId) {
        routeCurrentRef.current = {
            automationId,
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
    const isCurrentRoute = React.useCallback((expectedAutomationId: string, expectedGeneration: number): boolean => {
        const current = routeCurrentRef.current;
        return current.mounted
            && current.automationId === expectedAutomationId
            && current.generation === expectedGeneration;
    }, []);
    const automation = useAutomation(automationId);
    const runs = useAutomationRuns(automationId);
    const nextRunCursor = useAutomationRunNextCursor(automationId);
    const machines = useAllMachines();
    const machineTitleCounts = React.useMemo(() => {
        const counts = new Map<string, number>();
        for (const machine of machines) {
            const title = getMachineDisplayName(machine) ?? machine.id;
            counts.set(title, (counts.get(title) ?? 0) + 1);
        }
        return counts;
    }, [machines]);
    const [loadingState, setLoadingState] = React.useState<RouteScopedState<boolean>>({
        generation: routeGeneration,
        value: true,
    });
    const [refreshFailureState, setRefreshFailureState] = React.useState<RouteScopedState<boolean>>({
        generation: routeGeneration,
        value: false,
    });
    const [loadingMoreRunsState, setLoadingMoreRunsState] = React.useState<RouteScopedState<boolean>>({
        generation: routeGeneration,
        value: false,
    });
    const [runHistoryPageState, setRunHistoryPageState] = React.useState<RouteScopedState<number>>({
        generation: routeGeneration,
        value: 0,
    });
    const [runNowStateForRoute, setRunNowStateForRoute] = React.useState<RouteScopedState<'idle' | 'running' | 'queued'>>({
        generation: routeGeneration,
        value: 'idle',
    });
    const [clearingRunHistoryState, setClearingRunHistoryState] = React.useState<RouteScopedState<boolean>>({
        generation: routeGeneration,
        value: false,
    });
    const runNowInFlightGenerationsRef = React.useRef(new Map<string, number>());
    // A reused route must remain in loading state until its own refresh begins;
    // otherwise an uncached next Automation can flash a false not-found result.
    const loading = loadingState.generation !== routeGeneration || loadingState.value;
    const loadingMoreRuns = loadingMoreRunsState.generation === routeGeneration && loadingMoreRunsState.value;
    const runHistoryPage = runHistoryPageState.generation === routeGeneration
        ? runHistoryPageState.value
        : 0;
    const runHistoryPageStart = runHistoryPage * AUTOMATION_RUN_HISTORY_PAGE_SIZE;
    const visibleRunHistory = runs.slice(
        runHistoryPageStart,
        runHistoryPageStart + AUTOMATION_RUN_HISTORY_PAGE_SIZE,
    );
    const hasLoadedOlderRunHistoryPage = runHistoryPageStart + AUTOMATION_RUN_HISTORY_PAGE_SIZE < runs.length;
    const canShowOlderRunHistoryPage = hasLoadedOlderRunHistoryPage || nextRunCursor !== null;
    const refreshFailed = refreshFailureState.generation === routeGeneration && refreshFailureState.value;
    const runNowState = runNowStateForRoute.generation === routeGeneration
        ? runNowStateForRoute.value
        : 'idle';
    const clearingRunHistory = clearingRunHistoryState.generation === routeGeneration
        && clearingRunHistoryState.value;
    const runNowPending = runNowState === 'running' || runNowInFlightGenerationsRef.current.has(automationId);
    const mutationsEnabled = !refreshFailed;

    const refresh = React.useCallback(async () => {
        if (!automationId) return;
        const request = { automationId, generation: routeGeneration };
        try {
            setLoadingState({ generation: request.generation, value: true });
            setRefreshFailureState({ generation: request.generation, value: false });
            await sync.refreshAutomations();
            if (!isCurrentRoute(request.automationId, request.generation)) return;
            await Promise.all([
                sync.refreshAutomationDefinitionDetail(request.automationId),
                sync.fetchAutomationRuns(request.automationId),
            ]);
        } catch {
            if (!isCurrentRoute(request.automationId, request.generation)) return;
            setRefreshFailureState({ generation: request.generation, value: true });
        } finally {
            if (isCurrentRoute(request.automationId, request.generation)) {
                setLoadingState({ generation: request.generation, value: false });
            }
        }
    }, [automationId, isCurrentRoute, routeGeneration]);

    // Source status is list-safe canonical Automation state, so a recovery
    // never writes a local success marker or reaches into the source envelope.
    const rereadAutomationSourceStatus = React.useCallback(async () => {
        if (!automationId || !isCurrentRoute(automationId, routeGeneration)) return;
        await sync.refreshAutomations();
    }, [automationId, isCurrentRoute, routeGeneration]);

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    const handleLoadMoreRuns = React.useCallback(async () => {
        if (!automationId || !isCurrentRoute(automationId, routeGeneration)) return;
        if (hasLoadedOlderRunHistoryPage) {
            setRunHistoryPageState({
                generation: routeGeneration,
                value: runHistoryPage + 1,
            });
            return;
        }
        if (!nextRunCursor || loadingMoreRuns) return;
        const request = {
            automationId,
            cursor: nextRunCursor,
            generation: routeGeneration,
            page: runHistoryPage,
        };
        try {
            setLoadingMoreRunsState({ generation: request.generation, value: true });
            await sync.fetchAutomationRuns(
                request.automationId,
                AUTOMATION_RUN_HISTORY_PAGE_SIZE,
                request.cursor,
            );
            if (!isCurrentRoute(request.automationId, request.generation)) return;
            setRunHistoryPageState({ generation: request.generation, value: request.page + 1 });
        } catch (error) {
            if (!isCurrentRoute(request.automationId, request.generation)) return;
            await Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('automations.detail.refreshFailed'),
            );
        } finally {
            if (isCurrentRoute(request.automationId, request.generation)) {
                setLoadingMoreRunsState({ generation: request.generation, value: false });
            }
        }
    }, [
        automationId,
        hasLoadedOlderRunHistoryPage,
        isCurrentRoute,
        loadingMoreRuns,
        nextRunCursor,
        routeGeneration,
        runHistoryPage,
    ]);

    const handleShowNewerRuns = React.useCallback(() => {
        if (!automationId || runHistoryPage === 0 || !isCurrentRoute(automationId, routeGeneration)) return;
        setRunHistoryPageState({
            generation: routeGeneration,
            value: runHistoryPage - 1,
        });
    }, [automationId, isCurrentRoute, routeGeneration, runHistoryPage]);

    const handleRunNow = React.useCallback(async () => {
        if (!automationId || !mutationsEnabled) return;
        const request = { automationId, generation: routeGeneration };
        if (runNowInFlightGenerationsRef.current.has(request.automationId)) return;
        runNowInFlightGenerationsRef.current.set(request.automationId, request.generation);
        try {
            setRunNowStateForRoute({ generation: request.generation, value: 'running' });
            await sync.runAutomationNow(request.automationId);
            if (!isCurrentRoute(request.automationId, request.generation)) return;
            setRunNowStateForRoute({ generation: request.generation, value: 'queued' });
            setTimeout(() => {
                if (!isCurrentRoute(request.automationId, request.generation)) return;
                setRunNowStateForRoute((previous) => (
                    previous.generation === request.generation && previous.value === 'queued'
                        ? { generation: request.generation, value: 'idle' }
                        : previous
                ));
            }, 2500);
        } catch (error) {
            if (!isCurrentRoute(request.automationId, request.generation)) return;
            await Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('automations.detail.runFailed')
            );
            if (isCurrentRoute(request.automationId, request.generation)) {
                setRunNowStateForRoute({ generation: request.generation, value: 'idle' });
            }
        } finally {
            if (runNowInFlightGenerationsRef.current.get(request.automationId) === request.generation) {
                runNowInFlightGenerationsRef.current.delete(request.automationId);
                const currentRoute = routeCurrentRef.current;
                if (
                    currentRoute.mounted
                    && currentRoute.automationId === request.automationId
                    && currentRoute.generation !== request.generation
                ) {
                    setRunNowStateForRoute({ generation: currentRoute.generation, value: 'idle' });
                }
            }
        }
    }, [automationId, isCurrentRoute, mutationsEnabled, routeGeneration]);

    const handleOpenRun = React.useCallback((runId: string) => {
        if (!automationId) return;
        navigateWithBlurOnWeb(() => router.push({
            pathname: '/automations/[id]/runs/[runId]',
            params: { id: automationId, runId },
        }));
    }, [automationId, router]);

    const handleToggleEnabled = React.useCallback(async () => {
        if (!automationId || !automation || !mutationsEnabled) return;
        const request = { automationId, generation: routeGeneration };
        try {
            if (automation.enabled) {
                await sync.pauseAutomation(request.automationId);
            } else {
                await sync.resumeAutomation(request.automationId);
            }
        } catch (error) {
            if (!isCurrentRoute(request.automationId, request.generation)) return;
            await Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('automations.edit.updateFailed')
            );
        }
    }, [automation, automationId, isCurrentRoute, mutationsEnabled, routeGeneration]);

    const handleDelete = React.useCallback(async () => {
        if (!automationId || !mutationsEnabled) return;
        const request = { automationId, generation: routeGeneration };
        const confirmed = await Modal.confirm(
            t('automations.detail.deleteConfirmTitle'),
            t('automations.detail.deleteConfirmMessage'),
            { destructive: true, confirmText: t('automations.detail.deleteConfirmButton') },
        );
        if (!confirmed || !isCurrentRoute(request.automationId, request.generation)) return;
        try {
            await sync.deleteAutomation(request.automationId);
            if (!isCurrentRoute(request.automationId, request.generation)) return;
            navigateWithBlurOnWeb(() => {
                if (isCurrentRoute(request.automationId, request.generation)) {
                    router.replace('/automations');
                }
            });
        } catch (error) {
            if (!isCurrentRoute(request.automationId, request.generation)) return;
            await Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('automations.detail.deleteFailed')
            );
        }
    }, [automationId, isCurrentRoute, mutationsEnabled, routeGeneration, router]);

    const handleClearRunHistory = React.useCallback(async () => {
        if (!automationId || !mutationsEnabled || clearingRunHistory) return;
        const request = { automationId, generation: routeGeneration };
        const confirmed = await Modal.confirm(
            t('automations.detail.clearHistoryConfirmTitle'),
            t('automations.detail.clearHistoryConfirmMessage'),
            { destructive: true, confirmText: t('automations.detail.clearHistoryConfirmButton') },
        );
        if (!confirmed || !isCurrentRoute(request.automationId, request.generation)) return;

        try {
            setClearingRunHistoryState({ generation: request.generation, value: true });
            await sync.clearAutomationRunHistory(request.automationId);
            if (!isCurrentRoute(request.automationId, request.generation)) return;
            // Sync re-seeds the canonical first Run window after the server
            // applies its eligibility rule. This screen only returns its
            // presentation to that fresh first page.
            setRunHistoryPageState({ generation: request.generation, value: 0 });
        } catch (error) {
            if (!isCurrentRoute(request.automationId, request.generation)) return;
            await Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('automations.detail.clearHistoryFailed'),
            );
        } finally {
            if (isCurrentRoute(request.automationId, request.generation)) {
                setClearingRunHistoryState({ generation: request.generation, value: false });
            }
        }
    }, [automationId, clearingRunHistory, isCurrentRoute, mutationsEnabled, routeGeneration]);

    const handleEditAutomation = React.useCallback(() => {
        if (!automationId) return;
        navigateWithBlurOnWeb(() => router.push({
            pathname: '/automations/edit',
            params: { id: automationId },
        } as any));
    }, [automationId, router]);

    const handleToggleMachineAssignment = React.useCallback(async (machineId: string, enabled: boolean) => {
        if (!automationId || !automation || !mutationsEnabled) return;
        const request = { automationId, generation: routeGeneration };
        try {
            const nextAssignments = upsertAutomationAssignmentToggle({
                assignments: automation.assignments,
                machineId,
                enabled,
            });
            await sync.replaceAutomationAssignments(request.automationId, nextAssignments);
        } catch (error) {
            if (!isCurrentRoute(request.automationId, request.generation)) return;
            await Modal.alert(
                t('common.error'),
                error instanceof Error ? error.message : t('automations.detail.assignmentsUpdateFailed')
            );
        }
    }, [automation, automationId, isCurrentRoute, mutationsEnabled, routeGeneration]);

    const unknownDate = t('automations.detail.unknownDate');
    const runHistoryRows = React.useMemo<readonly AutomationDetailRunHistoryRow[]>(() => {
        const next: AutomationDetailRunHistoryRow[] = visibleRunHistory.map((run) => ({
            kind: 'run',
            key: run.id,
            run,
        }));
        if (next.length === 0) next.push({ kind: 'empty', key: 'empty' });
        if (runHistoryPage > 0) next.push({ kind: 'previous', key: 'previous' });
        if (canShowOlderRunHistoryPage) next.push({ kind: 'loadMore', key: 'loadMore' });
        return next;
    }, [canShowOlderRunHistoryPage, runHistoryPage, visibleRunHistory]);
    const renderRunHistoryRow = React.useCallback(({
        item,
        index,
    }: {
        item: AutomationDetailRunHistoryRow;
        index: number;
    }) => {
        const isFirst = index === 0;
        const isLast = index === runHistoryRows.length - 1;
        const row = item.kind === 'run' ? (
            <Item
                title={formatAutomationRunStateLabel(item.run.state)}
                subtitle={[
                    t(getAutomationRunOriginTranslationKey(item.run.origin)),
                    formatDate(getAutomationDefinitionRunOriginAt(item.run), unknownDate),
                    t('automations.detail.runMeta.updated', { time: formatDate(item.run.updatedAt, unknownDate) }),
                    ...(item.run.errorCode ? [t('automations.detail.runMeta.error', { message: item.run.errorCode })] : []),
                ].join('\n')}
                subtitleLines={0}
                onPress={() => handleOpenRun(item.run.id)}
            />
        ) : item.kind === 'empty' ? (
            <Item title={t('runs.empty')} showChevron={false} />
        ) : item.kind === 'previous' ? (
            <Item title={t('common.previous')} onPress={handleShowNewerRuns} showChevron={false} />
        ) : (
            <Item
                title={t('automations.detail.loadMoreRuns')}
                onPress={() => void handleLoadMoreRuns()}
                loading={loadingMoreRuns}
                showChevron={false}
            />
        );

        return (
            <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                <ItemGroup
                    {...(isFirst ? { title: t('automations.detail.recentRunsTitle') } : {})}
                    virtualizedSegment={{ first: isFirst, last: isLast }}
                >
                    {row}
                </ItemGroup>
            </View>
        );
    }, [handleLoadMoreRuns, handleOpenRun, handleShowNewerRuns, loadingMoreRuns, runHistoryRows.length, unknownDate]);

    if (!automationId) {
        return (
            <ItemList>
                <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                    <View style={styles.emptyRuns}>
                        <Text style={styles.emptyRunsText}>{t('automations.detail.invalidId')}</Text>
                    </View>
                </View>
            </ItemList>
        );
    }

    if (loading && !automation) {
        return (
            <ItemList>
                <View style={styles.loading}>
                    <ActivitySpinner size="small" color={theme.colors.text.secondary} />
                </View>
            </ItemList>
        );
    }

    if (!automation) {
        if (refreshFailed) {
            return (
                <ItemList>
                    <SurfaceStateCard
                        testID="automation-detail-refresh-error"
                        kind="error"
                        title={t('common.error')}
                        reason={t('automations.detail.refreshFailed')}
                        action={{
                            label: t('common.retry'),
                            onPress: () => { void refresh(); },
                        }}
                        accessibilitySemantics="alert"
                    />
                </ItemList>
            );
        }
        return (
            <ItemList>
                <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                    <View style={styles.emptyRuns}>
                        <Icon name="warning-circle" size={32} color={theme.colors.text.secondary} />
                        <Text style={styles.emptyRunsText}>{t('automations.detail.notFound')}</Text>
                    </View>
                </View>
            </ItemList>
        );
    }

    const nextRunLabel = automation.nextRunAt
        ? formatDate(automation.nextRunAt, unknownDate)
        : t('automations.detail.notScheduled');
    const hasEnabledAssignments = automation.assignments.some((assignment) => assignment.enabled);
    const supportsScheduleEditor = readLegacyScheduleAutomationDefinition(automation) !== null;
    // The edit route accepts only this current direct-detail seed. Reuse that
    // contract here so detail availability cannot diverge from route admission.
    const supportsEventEditor = readPluginEventAutomationEditSeed(automation) !== null;
    const eventEndpoint = automation.trigger.kind === 'pluginEvent'
        && automation.trigger.observation.kind === 'durablePush'
        ? automation.trigger.observation
        : null;
    const eventWatcher = automation.trigger.kind === 'pluginEvent'
        && automation.trigger.observation.kind === 'checkpointedPull'
        ? (() => {
            const watcher = automation.trigger.observation.watcher;
            if (!watcher) {
                // An unwatched Event has no watcher whose availability could
                // contradict a provider summary, and the server projects no
                // summary without a current reporter.
                return {
                    label: t('automations.detail.event.watcherUnwatched'),
                    impediment: undefined,
                    canPresentSourceSummary: true,
                };
            }
            const machine = machines.find((candidate) => candidate.id === watcher.machineId);
            const health = resolveAutomationWatcherHealth({ watcher, machine });
            return {
                label: machine ? (getMachineDisplayName(machine) ?? machine.id) : watcher.machineId,
                impediment: formatAutomationWatcherImpediment(health),
                canPresentSourceSummary: canPresentAutomationSourceSummary(health),
            };
        })()
        : null;
    // A provider summary reports what the watcher last saw, not whether it is
    // still running. Host-derived availability therefore decides whether the
    // reported state may be presented at all, and the watcher impediment is
    // the truthful reason that replaces the retained provider detail.
    const eventSourceSummaryUnavailable = eventWatcher?.canPresentSourceSummary === false;
    const eventSourceSummaryImpediment = eventSourceSummaryUnavailable
        ? eventWatcher?.impediment
        : undefined;
    const eventSourceStatus = isPluginEventAutomationDefinition(automation)
        && !eventSourceSummaryUnavailable
        ? automation.sourceStatus ?? null
        : null;
    const eventSourceStatusSubtitle = eventSourceStatus
        ? formatAutomationSourceStatusSubtitle(eventSourceStatus, unknownDate)
        : eventSourceSummaryImpediment;
    const eventSourceCatalogStatus = isPluginEventAutomationDefinition(automation)
        && !eventSourceSummaryUnavailable
        ? automation.sourceCatalogStatus ?? null
        : null;
    const eventSourceCatalogStatusSubtitle = eventSourceCatalogStatus
        ? formatAutomationSourceCatalogStatusSubtitle(eventSourceCatalogStatus, unknownDate)
        : eventSourceSummaryImpediment;
    const eventPrivateDetail = readPluginEventAutomationPrivateDetail(automation);
    const eventFilterSummary = eventPrivateDetail?.storedDefinition.filter === null
        ? null
        : eventPrivateDetail
            ? formatStructuredPrivateDetail(eventPrivateDetail.storedDefinition.filter)
            : null;

    return (
        <VirtualizedList
            testID="automation-detail-history"
            data={runHistoryRows}
            keyExtractor={(item) => item.key}
            renderItem={renderRunHistoryRow}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingBottom: Platform.OS === 'ios' ? 34 : 16 }}
            backendPreference="auto"
            initialNumToRender={4}
            ListHeaderComponent={(
                <View style={{ maxWidth: layout.maxWidth, alignSelf: 'center', width: '100%' }}>
                {refreshFailed ? (
                    <ItemGroup>
                        <Item
                            testID="automation-detail-stale-refresh-error"
                            title={t('automations.detail.refreshFailed')}
                            icon={<Icon name="warning" size={20} color={theme.colors.state.warning.foreground} />}
                            mode="info"
                            showChevron={false}
                            accessibilityRole="alert"
                            accessibilityLiveRegion="assertive"
                            webRole="alert"
                        />
                        <Item
                            testID="automation-detail-stale-refresh-retry"
                            title={t('common.retry')}
                            icon={<Icon name="arrow-clockwise" size={20} color={theme.colors.accent.blue} />}
                            onPress={() => { void refresh(); }}
                            showChevron={false}
                        />
                    </ItemGroup>
                ) : null}
                <ItemGroup title={t('automations.detail.overviewGroupTitle')}>
                    <Item title={t('automations.detail.overview.nameTitle')} detail={automation.name} showChevron={false} />
                    <Item title={t('automations.detail.overview.scheduleTitle')} subtitle={formatAutomationTriggerLabel(automation.trigger)} subtitleLines={0} showChevron={false} />
                    <Item
                        title={t('automations.detail.overview.statusTitle')}
                        detail={automation.enabled ? t('automations.detail.status.active') : t('automations.detail.status.paused')}
                        showChevron={false}
                    />
                    {eventWatcher ? (
                        <Item
                            title={t('automations.detail.event.watcherTitle')}
                            detail={eventWatcher.label}
                            subtitle={eventWatcher.impediment}
                            subtitleLines={0}
                            {...(eventWatcher.impediment
                                ? {
                                    icon: (
                                        <Icon
                                            name="warning"
                                            size={20}
                                            color={theme.colors.state.warning.foreground}
                                        />
                                    ),
                                }
                                : {})}
                            showChevron={false}
                        />
                    ) : null}
                    {eventEndpoint ? (
                        <Item
                            testID="automation-detail-event-endpoint"
                            title={t('automations.detail.event.endpointTitle')}
                            detail={eventEndpoint.webhookEndpointId}
                            subtitle={t('automations.detail.event.endpointObservingSince', {
                                time: formatDate(eventEndpoint.observationStartsAt, unknownDate),
                            })}
                            subtitleLines={0}
                            showChevron={false}
                        />
                    ) : null}
                    {/*
                      * A missing report is a state, not an absence: an Event
                      * Automation whose source has never reported, or whose
                      * catalog currentness is unavailable, must read as such
                      * rather than as a healthy definition with fewer rows.
                      */}
                    {isPluginEventAutomationDefinition(automation) ? (
                        <>
                            <Item
                                testID="automation-detail-event-source-status"
                                title={t('settingsPlugins.eventAutomationComposer.sourceStatusTitle')}
                                detail={eventSourceStatus
                                    ? automationSourceStatusStateLabels[eventSourceStatus.state]()
                                    : eventSourceSummaryUnavailable
                                        ? t('automations.detail.event.sourceStatusUnavailable')
                                        : t('automations.detail.event.sourceStatusUnreported')}
                                subtitle={eventSourceStatusSubtitle}
                                subtitleLines={0}
                                showChevron={false}
                            />
                            <Item
                                testID="automation-detail-event-source-catalog-status"
                                title={t('settingsPlugins.eventAutomationComposer.sourceCatalogStatusTitle')}
                                detail={eventSourceCatalogStatus
                                    ? automationSourceCatalogStatusStateLabels[eventSourceCatalogStatus.state]()
                                    : t('automations.detail.event.sourceCatalogStatusUnavailable')}
                                subtitle={eventSourceCatalogStatusSubtitle}
                                subtitleLines={0}
                                showChevron={false}
                            />
                        </>
                    ) : null}
                    {eventPrivateDetail ? (
                        <>
                            <Item
                                title={t('automations.detail.runDetail.sourceInstance')}
                                detail={eventPrivateDetail.storedDefinition.displayLabel}
                                showChevron={false}
                            />
                            {eventFilterSummary !== null ? (
                                <Item
                                    title={t('automations.detail.runDetail.filter')}
                                    subtitle={eventFilterSummary}
                                    subtitleLines={3}
                                    copy={eventFilterSummary}
                                    showChevron={false}
                                />
                            ) : null}
                            <Item
                                title={t('automations.detail.runDetail.target')}
                                detail={formatAutomationDefinitionTarget(eventPrivateDetail.recipe.target)}
                                showChevron={false}
                            />
                            <Item
                                title={t('automations.detail.runDetail.outputCeiling')}
                                detail={formatByteSize(MAX_AUTOMATION_RESULT_TEXT_UTF8_BYTES)}
                                showChevron={false}
                            />
                        </>
                    ) : null}
                    {automation.trigger.kind === 'schedule' ? (
                        <Item title={t('automations.detail.overview.nextRunTitle')} subtitle={nextRunLabel} subtitleLines={0} showChevron={false} />
                    ) : null}
                </ItemGroup>

                <ItemGroup title={t('automations.detail.actionsGroupTitle')}>
                    {automation.trigger.kind === 'pluginEvent' && mutationsEnabled ? (
                        <AutomationHistoryGapRecoveryAction
                            automation={automation}
                            isCurrentRoute={() => isCurrentRoute(automationId, routeGeneration)}
                            rereadAutomationStatus={rereadAutomationSourceStatus}
                        />
                    ) : null}
                    <Item
                        title={t('automations.detail.runNowTitle')}
                        subtitle={runNowState === 'queued' ? t('automations.detail.runNowQueuedSubtitle') : undefined}
                        subtitleLines={0}
                        onPress={mutationsEnabled ? () => void handleRunNow() : undefined}
                        disabled={!mutationsEnabled || runNowPending}
                        loading={runNowPending}
                        rightElement={runNowState === 'queued'
                                ? <Text style={{ color: theme.colors.text.secondary, fontSize: 13, fontWeight: '600' }}>{t('automations.detail.runNowQueuedBadge')}</Text>
                                : undefined}
                        showChevron={false}
                    />
                    <Item
                        title={automation.enabled ? t('automations.detail.pauseAutomation') : t('automations.detail.resumeAutomation')}
                        onPress={mutationsEnabled ? () => void handleToggleEnabled() : undefined}
                        disabled={!mutationsEnabled}
                        showChevron={false}
                    />
                    {supportsScheduleEditor || supportsEventEditor ? (
                        <Item
                            title={t('automations.detail.editAutomation')}
                            onPress={mutationsEnabled ? handleEditAutomation : undefined}
                            disabled={!mutationsEnabled}
                            showChevron={false}
                        />
                    ) : null}
                    <Item
                        testID="automation-detail-clear-history"
                        title={t('automations.detail.clearHistory')}
                        subtitle={t('automations.detail.clearHistorySubtitle')}
                        subtitleLines={0}
                        destructive
                        onPress={mutationsEnabled ? () => void handleClearRunHistory() : undefined}
                        disabled={!mutationsEnabled || clearingRunHistory}
                        loading={clearingRunHistory}
                        showChevron={false}
                    />
                    <Item
                        title={t('automations.detail.deleteAutomation')}
                        destructive
                        onPress={mutationsEnabled ? () => void handleDelete() : undefined}
                        disabled={!mutationsEnabled}
                        showChevron={false}
                    />
                </ItemGroup>

                <ItemGroup
                    title={t('automations.detail.machineAssignmentsTitle')}
                    footer={hasEnabledAssignments ? undefined : t('automations.detail.machineAssignmentsFooter')}
                >
                    {machines.length === 0 ? (
                        <Item title={t('newSession.machinePicker.emptyMessage')} showChevron={false} />
                    ) : machines.map((machine) => {
                        const assignment = automation.assignments.find((item) => item.machineId === machine.id);
                        const isEnabled = assignment?.enabled === true;
                        const machineName = getMachineDisplayName(machine) ?? machine.id;
                        const machineMeta = formatAutomationAssignmentSubtitle({
                            machine,
                            duplicateTitle: (machineTitleCounts.get(machineName) ?? 0) > 1,
                        });

                        return (
                            <Item
                                key={machine.id}
                                title={machineName}
                                subtitle={machineMeta}
                                subtitleLines={0}
                                rightElement={(
                                    <Switch
                                        value={isEnabled}
                                        onValueChange={mutationsEnabled
                                            ? () => void handleToggleMachineAssignment(machine.id, !isEnabled)
                                            : undefined}
                                        disabled={!mutationsEnabled}
                                        accessibilityLabel={[
                                            automation.name,
                                            machineName,
                                            t('automations.detail.machineAssignmentsTitle'),
                                        ].join('. ')}
                                    />
                                )}
                                showChevron={false}
                            />
                        );
                    })}
                </ItemGroup>
                </View>
            )}
        />
    );
}
