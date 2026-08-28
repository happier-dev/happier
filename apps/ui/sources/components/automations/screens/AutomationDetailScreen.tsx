import React from 'react';
import { Platform, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    type AutomationEventSourceStatusV1,
    type AutomationEventSourceCatalogStatus,
    type AutomationTriggerListItem,
} from '@happier-dev/protocol';

import { Modal } from '@/modal';
import {
    storage,
    useAllMachines,
    useAutomation,
    useAutomationRunNextCursor,
    useAutomationRuns,
} from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { sync } from '@/sync/sync';
import { upsertAutomationAssignmentToggle } from '@/components/automations/screens/automationAssignmentsModel';
import {
    formatAutomationRunStateLabel,
    formatAutomationRunCauseLabel,
    formatAutomationTriggerLabel,
    formatAutomationTriggerStatusLabel,
    getAutomationRunCauseAt,
} from '@/components/automations/list/automationListFormatting';
import { useAutomationRunNowController } from '@/components/automations/list/useAutomationRunNowController';
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
import type { AutomationDefinitionRun } from '@/sync/domains/automations/automationTypes';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { resolveAccountScopedCryptoMaterialFromCredentials } from '@/sync/domains/connectedServices/resolveAccountScopedCryptoMaterialFromCredentials';
import { readPluginEventAutomationPrivateDetail } from '@/components/automations/editor/pluginEventAutomationEditSeed';
import { buildPluginEventAutomationPayloadBrowser } from '@/components/automations/editor/pluginEventAutomationPayloadBrowser';
import { AutomationHistoryGapRecoveryAction } from './AutomationHistoryGapRecoveryAction';

import {
    canPresentAutomationSourceSummary,
    formatAutomationEventObserverRuntimeImpediment,
    formatAutomationWatcherImpediment,
    resolveAutomationEventObserverRuntimeHealth,
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

function formatRetiredTriggerKind(kind: 'schedule' | 'pluginEvent' | 'sessionLifecycle'): string {
    switch (kind) {
        case 'schedule':
            return t('automations.detail.runMeta.cause.schedule');
        case 'pluginEvent':
            return t('automations.detail.runMeta.cause.pluginEvent');
        case 'sessionLifecycle':
            return t('automations.detail.runMeta.cause.sessionLifecycle');
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
} satisfies Record<AutomationEventSourceCatalogStatus['state'], () => string>;

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
    status: AutomationEventSourceCatalogStatus,
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

function AutomationTriggerOverview(props: Readonly<{
    trigger: AutomationTriggerListItem;
    machines: ReadonlyArray<Machine>;
    unknownDate: string;
    isCurrentRoute: () => boolean;
    rereadAutomationStatus: () => Promise<void>;
    automation: NonNullable<ReturnType<typeof useAutomation>>;
    mutationsEnabled: boolean;
}>): React.ReactElement {
    const { trigger } = props;
    const activeServer = useActiveServerSnapshot();
    const eventMachineId = trigger.kind === 'pluginEvent'
        ? (trigger.observation.kind === 'checkpointedPull'
            ? trigger.observation.watcher?.machineId
            : trigger.observation.endpointMaterializationRef?.machineId ?? null)
        : null;
    const eventProjection = useDaemonMergedProjectionInputs({
        machineId: eventMachineId,
        serverId: activeServer.serverId,
        enabled: trigger.kind === 'pluginEvent' && Boolean(eventMachineId),
    });
    const eventPrivateDetail = React.useMemo(() => {
        if (trigger.kind !== 'pluginEvent') return null;
        const plain = readPluginEventAutomationPrivateDetail(props.automation, trigger.id, { mode: 'plain' });
        if (plain) return plain;
        const credentials = sync.getCredentials();
        if (!credentials) return null;
        try {
            return readPluginEventAutomationPrivateDetail(props.automation, trigger.id, {
                mode: 'e2ee',
                material: resolveAccountScopedCryptoMaterialFromCredentials(credentials),
            });
        } catch {
            return null;
        }
    }, [props.automation, trigger]);
    const currentEligibleEvent = trigger.kind === 'pluginEvent'
        ? eventProjection.inputs?.automationEligibleEvents?.find((candidate) => (
            candidate.event.identity.pluginId === trigger.eventRef.pluginId
            && candidate.event.identity.localId === trigger.eventRef.localId
        )) ?? null
        : null;
    const payloadBrowser = buildPluginEventAutomationPayloadBrowser(currentEligibleEvent?.event.payloadSchema);
    const eventFilter = eventPrivateDetail?.storedDefinition.filter;
    const filterSummary = eventFilter === null
        ? t('common.none')
        : eventFilter?.all.map((clause) => (
            `${clause.field} ${clause.op} ${JSON.stringify(clause.op === 'eq' ? clause.value : clause.values)}`
        )).join('\n') ?? t('automations.detail.event.sourceStatusUnavailable');
    const payloadSchemaSummary = payloadBrowser.fields.length > 0
        ? payloadBrowser.fields.map((field) => `${field.pointer} · ${field.scalarKind}`).join('\n')
        : currentEligibleEvent
            ? t('common.none')
            : t('automations.detail.event.sourceStatusUnavailable');
    const technicalIdentity = t('automations.detail.trigger.identity', {
        id: trigger.id,
        revision: trigger.revision,
    });
    if (trigger.kind === 'schedule') {
        return (
            <ItemGroup title={formatAutomationTriggerLabel(trigger)}>
                <Item
                    title={formatAutomationTriggerStatusLabel(trigger, props.automation.enabled)}
                    subtitle={technicalIdentity}
                    subtitleLines={0}
                    showChevron={false}
                />
                <Item
                    title={t('automations.detail.overview.nextRunTitle')}
                    subtitle={trigger.nextRunAt === null
                        ? t('automations.detail.notScheduled')
                        : formatDate(trigger.nextRunAt, props.unknownDate)}
                    subtitleLines={0}
                    showChevron={false}
                />
            </ItemGroup>
        );
    }
    if (trigger.kind === 'sessionLifecycle') {
        const runId = trigger.status.runId;
        return (
            <ItemGroup title={formatAutomationTriggerLabel(trigger)}>
                <Item
                    title={formatAutomationTriggerStatusLabel(trigger, props.automation.enabled)}
                    subtitle={technicalIdentity}
                    subtitleLines={0}
                    showChevron={false}
                />
                {runId !== null ? (
                    <Item
                        title={t('automations.detail.trigger.run')}
                        subtitle={runId}
                        copy={runId}
                        showChevron={false}
                    />
                ) : null}
                <Item
                    title={t('automations.detail.trigger.sourceSession')}
                    subtitle={trigger.scope.sourceSessionId}
                    copy={trigger.scope.sourceSessionId}
                    showChevron={false}
                />
                <Item
                    title={t('automations.detail.trigger.sourceTurn')}
                    subtitle={trigger.scope.sourceTurnId}
                    copy={trigger.scope.sourceTurnId}
                    showChevron={false}
                />
            </ItemGroup>
        );
    }

    const watcher = trigger.observation.kind === 'checkpointedPull'
        ? trigger.observation.watcher
        : null;
    const watcherMachine = watcher
        ? props.machines.find((candidate) => candidate.id === watcher.machineId)
        : undefined;
    const watcherHealth = watcher
        ? resolveAutomationWatcherHealth({ watcher, machine: watcherMachine })
        : null;
    const endpointMaterializationRef = trigger.observation.kind === 'durablePush'
        ? trigger.observation.endpointMaterializationRef
        : null;
    const endpointMachine = endpointMaterializationRef
        ? props.machines.find((candidate) => candidate.id === endpointMaterializationRef.machineId)
        : undefined;
    const observerRuntimeHealth = trigger.observation.kind === 'checkpointedPull'
        ? resolveAutomationEventObserverRuntimeHealth({
            projection: eventProjection.inputs?.pluginProjectionV2,
            eventPluginId: trigger.eventRef.pluginId,
            reporterImmutableGenerationId: trigger.sourceStatus?.reporterImmutableGenerationId,
        })
        : null;
    const watcherImpediment = watcherHealth && !canPresentAutomationSourceSummary(watcherHealth)
        ? formatAutomationWatcherImpediment(watcherHealth)
        : observerRuntimeHealth
            ? formatAutomationEventObserverRuntimeImpediment(observerRuntimeHealth)
            : undefined;
    const canShowSourceSummary = (watcherHealth ? canPresentAutomationSourceSummary(watcherHealth) : true)
        && (observerRuntimeHealth?.kind === 'current' || observerRuntimeHealth === null);
    const sourceStatus = canShowSourceSummary ? trigger.sourceStatus ?? null : null;
    const catalogStatus = canShowSourceSummary ? trigger.sourceCatalogStatus ?? null : null;
    return (
        <ItemGroup title={formatAutomationTriggerLabel(trigger)}>
            <Item
                title={formatAutomationTriggerStatusLabel(trigger, props.automation.enabled)}
                subtitle={technicalIdentity}
                subtitleLines={0}
                showChevron={false}
            />
            <Item
                title={t('automations.detail.event.transportTitle')}
                detail={t(trigger.observation.kind === 'durablePush'
                    ? 'automations.detail.event.transportDurablePush'
                    : 'automations.detail.event.transportCheckpointedPull')}
                subtitle={t(trigger.observation.kind === 'durablePush'
                    ? 'automations.detail.event.disclosureDurablePush'
                    : 'automations.detail.event.disclosureCheckpointedPull')}
                subtitleLines={0}
                showChevron={false}
            />
            <Item
                testID="automation-detail-event-filter"
                title={t('settingsPlugins.eventAutomationComposer.trigger.eventFilter')}
                subtitle={filterSummary}
                subtitleLines={0}
                showChevron={false}
            />
            <Item
                testID="automation-detail-event-payload-schema"
                title={t('promptLibrary.schema')}
                subtitle={payloadSchemaSummary}
                subtitleLines={0}
                showChevron={false}
            />
            {trigger.observation.kind === 'durablePush' ? (
                <>
                    <Item
                        testID="automation-detail-event-endpoint"
                        title={t('automations.detail.event.endpointTitle')}
                        detail={trigger.observation.webhookEndpointId}
                        subtitle={t('automations.detail.event.endpointObservingSince', {
                            time: formatDate(trigger.observation.observationStartsAt, props.unknownDate),
                        })}
                        subtitleLines={0}
                        showChevron={false}
                    />
                    <Item
                        testID="automation-detail-event-observation-placement"
                        title={t('automations.detail.event.observationPlacementTitle')}
                        detail={endpointMaterializationRef
                            ? (endpointMachine
                                ? getMachineDisplayName(endpointMachine) ?? endpointMaterializationRef.machineId
                                : endpointMaterializationRef.machineId)
                            : t('automations.detail.event.sourceStatusUnavailable')}
                        subtitle={endpointMaterializationRef?.materializationId}
                        subtitleLines={0}
                        showChevron={false}
                    />
                </>
            ) : (
                <Item
                    title={t('automations.detail.event.watcherTitle')}
                    detail={watcher
                        ? (watcherMachine ? getMachineDisplayName(watcherMachine) ?? watcher.machineId : watcher.machineId)
                        : t('automations.detail.event.watcherUnwatched')}
                    subtitle={watcherImpediment}
                    subtitleLines={0}
                    showChevron={false}
                />
            )}
            <Item
                testID="automation-detail-event-source-status"
                title={t('settingsPlugins.eventAutomationComposer.sourceStatusTitle')}
                detail={sourceStatus
                    ? automationSourceStatusStateLabels[sourceStatus.state]()
                    : canShowSourceSummary
                        ? t('automations.detail.event.sourceStatusUnreported')
                        : t('automations.detail.event.sourceStatusUnavailable')}
                subtitle={sourceStatus
                    ? formatAutomationSourceStatusSubtitle(sourceStatus, props.unknownDate)
                    : watcherImpediment}
                subtitleLines={0}
                showChevron={false}
            />
            <Item
                testID="automation-detail-event-source-catalog-status"
                title={t('settingsPlugins.eventAutomationComposer.sourceCatalogStatusTitle')}
                detail={catalogStatus
                    ? automationSourceCatalogStatusStateLabels[catalogStatus.state]()
                    : t('automations.detail.event.sourceCatalogStatusUnavailable')}
                subtitle={catalogStatus
                    ? formatAutomationSourceCatalogStatusSubtitle(catalogStatus, props.unknownDate)
                    : watcherImpediment}
                subtitleLines={0}
                showChevron={false}
            />
            {props.mutationsEnabled ? (
                <AutomationHistoryGapRecoveryAction
                    automation={props.automation}
                    triggerId={trigger.id}
                    isCurrentRoute={props.isCurrentRoute}
                    rereadAutomationStatus={props.rereadAutomationStatus}
                />
            ) : null}
        </ItemGroup>
    );
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

type RouteScopedState<T> = Readonly<{
    generation: number;
    value: T;
}>;

// Keep the visible history page aligned with the canonical continuation
// request size. The store owns the accumulated traversal and cursor; this
// screen anchors each visited page to its first retained Run identity so live
// insertions at the head cannot duplicate or omit rows on an older page.
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
    const [runHistoryAnchorState, setRunHistoryAnchorState] = React.useState<RouteScopedState<readonly string[]>>({
        generation: routeGeneration,
        value: [],
    });
    const runNowController = useAutomationRunNowController();
    const [clearingRunHistoryState, setClearingRunHistoryState] = React.useState<RouteScopedState<boolean>>({
        generation: routeGeneration,
        value: false,
    });
    // A reused route must remain in loading state until its own refresh begins;
    // otherwise an uncached next Automation can flash a false not-found result.
    const loading = loadingState.generation !== routeGeneration || loadingState.value;
    const loadingMoreRuns = loadingMoreRunsState.generation === routeGeneration && loadingMoreRunsState.value;
    const runHistoryAnchors = runHistoryAnchorState.generation === routeGeneration
        ? runHistoryAnchorState.value
        : [];
    const runHistoryAnchorId = runHistoryAnchors.at(-1) ?? null;
    const anchoredRunHistoryIndex = runHistoryAnchorId === null
        ? 0
        : runs.findIndex((run) => run.id === runHistoryAnchorId);
    const runHistoryPageStart = Math.max(0, anchoredRunHistoryIndex);
    const visibleRunHistory = React.useMemo(() => runs.slice(
        runHistoryPageStart,
        runHistoryPageStart + AUTOMATION_RUN_HISTORY_PAGE_SIZE,
    ), [runHistoryPageStart, runs]);
    const hasLoadedOlderRunHistoryPage = runHistoryPageStart + AUTOMATION_RUN_HISTORY_PAGE_SIZE < runs.length;
    const canShowOlderRunHistoryPage = hasLoadedOlderRunHistoryPage || nextRunCursor !== null;
    const refreshFailed = refreshFailureState.generation === routeGeneration && refreshFailureState.value;
    const runNowState = runNowController.stateFor(automationId);
    const clearingRunHistory = clearingRunHistoryState.generation === routeGeneration
        && clearingRunHistoryState.value;
    const runNowPending = runNowState === 'submitting';
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

    React.useEffect(() => {
        void refresh();
    }, [refresh]);

    const handleLoadMoreRuns = React.useCallback(async () => {
        if (!automationId || !isCurrentRoute(automationId, routeGeneration)) return;
        if (hasLoadedOlderRunHistoryPage) {
            const nextAnchorId = runs[runHistoryPageStart + AUTOMATION_RUN_HISTORY_PAGE_SIZE]?.id;
            if (!nextAnchorId) return;
            setRunHistoryAnchorState({
                generation: routeGeneration,
                value: [...runHistoryAnchors, nextAnchorId],
            });
            return;
        }
        if (!nextRunCursor || loadingMoreRuns) return;
        const request = {
            automationId,
            cursor: nextRunCursor,
            generation: routeGeneration,
            anchors: runHistoryAnchors,
            currentPageLastRunId: visibleRunHistory.at(-1)?.id ?? null,
        };
        try {
            setLoadingMoreRunsState({ generation: request.generation, value: true });
            await sync.fetchAutomationRuns(
                request.automationId,
                AUTOMATION_RUN_HISTORY_PAGE_SIZE,
                request.cursor,
            );
            if (!isCurrentRoute(request.automationId, request.generation)) return;
            const latestRuns = storage.getState().automationRunsByAutomationId[request.automationId] ?? [];
            const currentLastIndex = request.currentPageLastRunId === null
                ? -1
                : latestRuns.findIndex((run) => run.id === request.currentPageLastRunId);
            const nextAnchorId = currentLastIndex < 0 ? undefined : latestRuns[currentLastIndex + 1]?.id;
            if (nextAnchorId) {
                setRunHistoryAnchorState({
                    generation: request.generation,
                    value: [...request.anchors, nextAnchorId],
                });
            }
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
        runHistoryAnchors,
        runHistoryPageStart,
        runs,
        routeGeneration,
        visibleRunHistory,
    ]);

    const rereadAutomationStatus = React.useCallback(async () => {
        if (!automationId || !isCurrentRoute(automationId, routeGeneration)) return;
        await sync.refreshAutomations();
        if (!isCurrentRoute(automationId, routeGeneration)) return;
        await sync.refreshAutomationDefinitionDetail(automationId);
    }, [automationId, isCurrentRoute, routeGeneration]);

    const handleShowNewerRuns = React.useCallback(() => {
        if (!automationId || runHistoryAnchors.length === 0 || !isCurrentRoute(automationId, routeGeneration)) return;
        setRunHistoryAnchorState({
            generation: routeGeneration,
            value: runHistoryAnchors.slice(0, -1),
        });
    }, [automationId, isCurrentRoute, routeGeneration, runHistoryAnchors]);

    const handleRunNow = React.useCallback(async () => {
        if (!automationId || !mutationsEnabled) return;
        await runNowController.runNow(automationId, {
            isInvocationCurrent: () => isCurrentRoute(automationId, routeGeneration),
        });
    }, [automationId, isCurrentRoute, mutationsEnabled, routeGeneration, runNowController]);

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
            setRunHistoryAnchorState({ generation: request.generation, value: [] });
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
        if (runHistoryAnchors.length > 0) next.push({ kind: 'previous', key: 'previous' });
        if (canShowOlderRunHistoryPage) next.push({ kind: 'loadMore', key: 'loadMore' });
        return next;
    }, [canShowOlderRunHistoryPage, runHistoryAnchors.length, visibleRunHistory]);
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
                    formatAutomationRunCauseLabel(item.run.cause),
                    ...(item.run.cause.kind === 'trigger' ? [t('automations.detail.runMeta.triggerIdentity', {
                        id: item.run.cause.triggerId,
                        revision: item.run.cause.triggerRevision,
                    })] : []),
                    ...(item.run.triggerRetired ? [t('automations.detail.runMeta.triggerRetired')] : []),
                    formatDate(getAutomationRunCauseAt(item.run.cause), unknownDate),
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

    const hasEnabledAssignments = automation.assignments.some((assignment) => assignment.enabled);

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
                    <Item
                        title={t('automations.detail.overview.statusTitle')}
                        detail={automation.enabled ? t('automations.detail.status.active') : t('automations.detail.status.paused')}
                        showChevron={false}
                    />
                    <Item
                        title={t('automations.detail.overview.triggersTitle')}
                        detail={automation.triggers.length === 0
                            ? t('automations.list.noAutomaticTriggers')
                            : String(automation.triggers.length)}
                        showChevron={false}
                    />
                </ItemGroup>

                {automation.triggers.map((trigger) => (
                    <AutomationTriggerOverview
                        key={trigger.id}
                        trigger={trigger}
                        machines={machines}
                        unknownDate={unknownDate}
                        automation={automation}
                        isCurrentRoute={() => isCurrentRoute(automationId, routeGeneration)}
                        rereadAutomationStatus={rereadAutomationStatus}
                        mutationsEnabled={mutationsEnabled}
                    />
                ))}

                {automation.retiredTriggers.length > 0 ? (
                    <ItemGroup title={t('automations.detail.runMeta.triggerRetired')}>
                        {automation.retiredTriggers.map((trigger) => (
                            <Item
                                key={trigger.id}
                                testID={`automation-retired-trigger-${trigger.id}`}
                                title={formatRetiredTriggerKind(trigger.kind)}
                                subtitle={t('automations.detail.runMeta.triggerIdentity', {
                                    id: trigger.id,
                                    revision: trigger.revision,
                                })}
                                detail={formatDate(trigger.retiredAt, unknownDate)}
                                subtitleLines={0}
                                showChevron={false}
                                mode="info"
                            />
                        ))}
                    </ItemGroup>
                ) : null}

                <ItemGroup title={t('automations.detail.actionsGroupTitle')}>
                    <Item
                        title={t('automations.detail.runNowTitle')}
                        onPress={mutationsEnabled ? () => void handleRunNow() : undefined}
                        disabled={!mutationsEnabled || runNowPending}
                        loading={runNowPending}
                        rightElement={runNowState === 'acknowledged'
                                ? <Icon name="check" size={16} color={theme.colors.text.secondary} />
                                : undefined}
                        showChevron={false}
                    />
                    <Item
                        title={automation.enabled ? t('automations.detail.pauseAutomation') : t('automations.detail.resumeAutomation')}
                        onPress={mutationsEnabled ? () => void handleToggleEnabled() : undefined}
                        disabled={!mutationsEnabled}
                        showChevron={false}
                    />
                    <Item
                        title={t('automations.detail.editAutomation')}
                        onPress={mutationsEnabled ? handleEditAutomation : undefined}
                        disabled={!mutationsEnabled}
                        showChevron={false}
                    />
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
