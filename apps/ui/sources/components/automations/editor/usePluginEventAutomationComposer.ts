import * as React from 'react';

import {
    type AutomationRunExecutionTargetV1,
    type AutomationEventFilterV1,
    type DaemonContributionRegistryProjectionAutomationEligibleEventV1,
    type ExecutionRunDetachedStartRequestV1,
    type PluginMachineExecutionOriginV1,
    type PluginProjectionInstalledPackageV2,
    type SessionServerStartSpawnDraftV1,
    validateAutomationEventFilterAgainstPayloadSchemaV1,
} from '@happier-dev/protocol';

import { loadDaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import type { DaemonMergedProjectionPhase } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    buildPluginMachineExecutionOriginCandidates,
    composePluginMachineExecutionOriginV1,
    isPluginMachineExecutionOriginCandidateSelectable,
    type PluginMachineExecutionOriginCandidateV1,
} from '@/sync/domains/machines/administration/pluginExecutionOrigin';
import { resolveFreshPluginMachineExecutionOrigin } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import { useAllProfileMachineInventorySnapshots } from '@/sync/domains/machines/useMachineInventorySnapshots';
import { useHydrateSessionForRoute } from '@/hooks/session/useHydrateSessionForRoute';
import { isSessionRouteHydrationAvailable } from '@/sync/domains/session/sessionRouteHydrationState';
import { resolveExistingSessionAutomationAvailability, type ExistingSessionAutomationAvailability } from '@/sync/domains/automations/existingSessionAutomationAvailability';
import { readMachineControlTargetForSession } from '@/sync/ops/sessionMachineTarget';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
import {
    storage,
    useSession,
    useSessionListIndexByServerId,
    useSessionListRowRenderablesForItems,
    useSessions,
    useSettings,
} from '@/sync/domains/state/storage';
import { sync } from '@/sync/sync';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import {
    useActivePluginAccountAvailabilityReader,
    useActivePluginAccountAvailabilityReleaseClassifier,
} from '@/sync/domains/plugins/availability/projection';
import {
    arePluginContributionIdentitiesEqual,
    arePluginMachineMaterializationRefsEqual,
} from '@/sync/domains/automations/pluginEventAutomationCurrentness';

import {
    createPluginEventAutomationAuthoringDraft,
    resolveCurrentPluginEventAutomationEligibleEvent,
    supportsPluginEventAutomationObservationTransport,
    type PluginEventAutomationCreateDraft,
    type PluginEventAutomationEditTarget,
    type PluginEventAutomationObservationDraft,
} from './pluginEventAutomationDraft';
import {
    applyRefreshedPluginEventAutomationWebhookEndpoint,
    readPluginEventAutomationWebhookEndpoint,
    type PluginEventAutomationWebhookEndpointBinding,
    type PluginEventAutomationWebhookEndpoint,
} from './pluginEventAutomationWebhookEndpoint';
import type { PluginEventAutomationEditSeed } from './pluginEventAutomationEditSeed';
import {
    readPluginEventAutomationFilterClauses,
    readPluginEventAutomationFilterDraft,
    type PluginEventAutomationFilterClauseDraft,
} from './pluginEventAutomationFilterBuilder';
import {
    buildPluginEventAutomationPayloadBrowser,
    type PluginEventAutomationPayloadBrowser,
} from './pluginEventAutomationPayloadBrowser';
import { configurePluginEventAutomationSetup } from './pluginEventAutomationSetup';
import {
    resolvePluginEventAutomationTarget,
    type PluginEventAutomationResolvedTarget,
    type PluginEventAutomationTargetKind,
} from './pluginEventAutomationTarget';
import {
    buildPluginEventAutomationExistingSessionOptions,
    type PluginEventAutomationExistingSessionOption,
} from './pluginEventAutomationExistingSessionOptions';
export type { PluginEventAutomationExistingSessionOption } from './pluginEventAutomationExistingSessionOptions';

type EventComposerMode = 'schedule' | 'event';

export type PluginEventAutomationComposerSourceStatus =
    | 'idle'
    | 'settingUp'
    | 'configured'
    | 'unavailable';

export type PluginEventAutomationInitialExistingSessionTarget = Readonly<{
    kind: 'existingSession';
    sessionId: string;
    serverId: string;
}>;

type WebhookEndpointRefreshRequest = Readonly<{
    generation: number;
    setupScope: AbortController;
}>;

/**
 * Presentation facts for one daemon-declared Event plugin. The composer only
 * reflects projection/account currentness here; it never derives a parallel
 * plugin catalog, install state, or brand byte source.
 */
export type PluginEventAutomationPluginPresentation = Readonly<{
    eventKey: string;
    displayName: string;
    availability: 'available' | 'unavailable';
    installedPackage: PluginProjectionInstalledPackageV2 | null;
    expectedGeneration: string | null;
    machineId: string | null;
    serverId: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    isCurrent: () => boolean;
}>;

export type PluginEventAutomationComposerModel = Readonly<{
    mode: EventComposerMode;
    setMode: (mode: EventComposerMode) => void;
    /** Event edits cannot be reinterpreted as a retained V2 schedule update. */
    isEditingEvent: boolean;
    /** Narrow direct-detail CAS fact for the incumbent patch writer. */
    editTarget: PluginEventAutomationEditTarget | null;
    /** Event creation chooses exactly one durable protocol target arm. */
    targetKind: PluginEventAutomationTargetKind;
    setTargetKind: (kind: PluginEventAutomationTargetKind) => void;
    existingSessionOptions: readonly PluginEventAutomationExistingSessionOption[];
    selectedExistingSessionId: string | null;
    selectExistingSession: (option: PluginEventAutomationExistingSessionOption) => void;
    existingSessionAvailability: ExistingSessionAutomationAvailability | null;
    executionPermissionMode: 'no_tools' | 'read_only';
    setExecutionPermissionMode: (mode: 'no_tools' | 'read_only') => void;
    /**
     * Re-reads the selected existing Session's canonical machine/control
     * target at submit time; the caller supplies only fresh arm-local inputs.
     */
    resolveExecutionTarget: (params: Readonly<{
        newSessionSpawn?: SessionServerStartSpawnDraftV1 | null;
        executionRun?: Readonly<{
            machineId: string | null;
            request: ExecutionRunDetachedStartRequestV1 | null;
        }> | null;
    }>) => PluginEventAutomationResolvedTarget | null;
    eligibleEvents: readonly DaemonContributionRegistryProjectionAutomationEligibleEventV1[];
    eventCatalogStatus: 'ready' | 'unavailable';
    selectedEvent: DaemonContributionRegistryProjectionAutomationEligibleEventV1 | null;
    selectEvent: (event: DaemonContributionRegistryProjectionAutomationEligibleEventV1) => void;
    getPluginPresentation: (
        event: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
    ) => PluginEventAutomationPluginPresentation;
    sourceStatus: PluginEventAutomationComposerSourceStatus;
    sourceDisplayLabel: string | null;
    sourceInstanceId: string | null;
    configureSource: () => void;
    /**
     * The transports the selected Event declares. The composer offers a choice
     * only where the declaration does; it never invents an arm the Event's own
     * source contract cannot serve.
     */
    availableObservationTransports: readonly PluginEventAutomationObservationDraft['kind'][];
    observationTransport: PluginEventAutomationObservationDraft['kind'];
    setObservationTransport: (kind: PluginEventAutomationObservationDraft['kind']) => void;
    /**
     * Disclosed once, by the ensure that configured the durable-push source.
     * The user must carry the URL and secret to the provider by hand, so the
     * composer keeps them visible until the source is reconfigured.
     */
    webhookEndpoint: PluginEventAutomationWebhookEndpoint | null;
    /**
     * Re-reads the ensured endpoint's readiness through the same canonical
     * webhook owner. Provider configuration happens outside this composer, so
     * without a recheck the readiness the composer showed at ensure time would
     * be the only one it ever showed. It is `null` while there is no ensured
     * endpoint to reread, and never a submission prerequisite.
     */
    refreshWebhookEndpoint: (() => void) | null;
    webhookEndpointRefreshing: boolean;
    watcherCandidates: readonly PluginMachineExecutionOriginCandidateV1[];
    selectedWatcherOrigin: PluginMachineExecutionOriginV1 | null;
    selectWatcher: (candidate: PluginMachineExecutionOriginCandidateV1) => void;
    payloadBrowser: PluginEventAutomationPayloadBrowser;
    filterClauses: readonly PluginEventAutomationFilterClauseDraft[];
    addFilterClause: () => void;
    removeFilterClause: (id: string) => void;
    setFilterClauseField: (id: string, field: string) => void;
    setFilterClauseOperator: (id: string, op: PluginEventAutomationFilterClauseDraft['op']) => void;
    setFilterClauseValueText: (id: string, valueText: string) => void;
    filterValid: boolean;
    maximumObservationAgeMsText: string;
    setMaximumObservationAgeMsText: (value: string) => void;
    maximumObservationAgeMsValid: boolean;
    /** Non-persisted strict writer input; null until every owner-local fact is valid/current. */
    createDraft: PluginEventAutomationCreateDraft | null;
    revision: number;
}>;

function sameEligibleEvent(
    left: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
    right: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
): boolean {
    return arePluginContributionIdentitiesEqual(left.event.identity, right.event.identity)
        && left.event.immutableGenerationId === right.event.immutableGenerationId
        && arePluginContributionIdentitiesEqual(left.setupAction.identity, right.setupAction.identity)
        && left.setupAction.immutableGenerationId === right.setupAction.immutableGenerationId;
}

function eventPresentationKey(
    event: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
): string {
    return JSON.stringify([
        event.event.identity.pluginId,
        event.event.identity.localId,
        event.event.immutableGenerationId,
        event.setupAction.identity.pluginId,
        event.setupAction.identity.localId,
        event.setupAction.immutableGenerationId,
    ]);
}

type PluginEventAutomationPresentationState = Readonly<{
    projectionPhase: DaemonMergedProjectionPhase;
    projectionInputs: DaemonMergedProjectionInputs | null;
    eligibleEvents: readonly DaemonContributionRegistryProjectionAutomationEligibleEventV1[];
    machineId: string | null;
    serverId: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
}>;

type PluginEventAutomationPluginPresentationFacts = Omit<
    PluginEventAutomationPluginPresentation,
    'isCurrent'
>;

function readPluginEventAutomationPluginPresentationFacts(
    state: PluginEventAutomationPresentationState,
    event: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
): PluginEventAutomationPluginPresentationFacts {
    const currentEvent = state.eligibleEvents.find((candidate) => sameEligibleEvent(candidate, event)) ?? null;
    const pluginId = event.event.identity.pluginId;
    const projectionEntry = state.projectionInputs?.pluginProjectionById[pluginId] ?? null;
    const candidatePackage = state.projectionInputs?.pluginProjectionV2?.installedPackagesById[pluginId] ?? null;
    const installedPackage = candidatePackage?.id === pluginId ? candidatePackage : null;
    const expectedGeneration = currentEvent?.event.immutableGenerationId ?? null;
    const hasExactInstalledGeneration = expectedGeneration !== null
        && installedPackage?.immutableGenerationId === expectedGeneration
        && projectionEntry?.pluginId === pluginId
        && projectionEntry.immutableGenerationId === expectedGeneration;
    const hasCurrentTarget = typeof state.machineId === 'string' && state.machineId.trim().length > 0;
    const available = state.projectionPhase === 'ready'
        && state.projectionInputs?.automationEligibleEvents !== undefined
        && currentEvent !== null
        && hasCurrentTarget
        && state.accountLifetime?.isCurrent() === true
        && installedPackage?.enabled === true
        && projectionEntry?.enabled === true
        && hasExactInstalledGeneration;

    return Object.freeze({
        eventKey: eventPresentationKey(event),
        displayName: installedPackage?.displayName ?? projectionEntry?.title ?? pluginId,
        availability: available ? 'available' : 'unavailable',
        // The package-brand owner must never receive an unavailable or stale
        // package binding merely to paint decorative chrome.
        installedPackage: available ? installedPackage : null,
        expectedGeneration: available ? expectedGeneration : null,
        machineId: state.machineId,
        serverId: state.serverId,
        accountLifetime: state.accountLifetime,
    });
}

function resolveCurrentEligibleEventForEditSeed(params: Readonly<{
    eligibleEvents: readonly DaemonContributionRegistryProjectionAutomationEligibleEventV1[];
    seed: PluginEventAutomationEditSeed;
}>): DaemonContributionRegistryProjectionAutomationEligibleEventV1 | null {
    const matches = params.eligibleEvents.filter((candidate) => (
        arePluginContributionIdentitiesEqual(candidate.event.identity, params.seed.eventRef)
        && candidate.event.automation.source.sourceContractVersion === params.seed.source.sourceContractVersion
        && candidate.event.automation.source.supportedObservationTransports.includes(
            params.seed.observation.kind,
        )
        && arePluginContributionIdentitiesEqual(
            candidate.setupAction.identity,
            candidate.event.automation.source.setupActionRef ?? { pluginId: '', localId: '' },
        )
    ));
    return matches.length === 1 ? matches[0]! : null;
}

function readMaximumObservationAgeMs(value: string): Readonly<{
    value: number | null;
    valid: boolean;
}> {
    const normalized = value.trim();
    if (!normalized) return { value: null, valid: true };
    if (!/^(0|[1-9][0-9]*)$/.test(normalized)) return { value: null, valid: false };
    const parsed = Number(normalized);
    return Number.isSafeInteger(parsed)
        ? { value: parsed, valid: true }
        : { value: null, valid: false };
}

function normalizeSessionTargetId(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readSessionListIndexSessionItems(
    indexByServerId: Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>>,
): readonly Extract<SessionListIndexItem, { type: 'session' }>[] {
    const items: Extract<SessionListIndexItem, { type: 'session' }>[] = [];
    for (const [recordServerId, indexItems] of Object.entries(indexByServerId)) {
        const serverId = normalizeSessionTargetId(recordServerId);
        if (!serverId || !Array.isArray(indexItems)) continue;
        for (const item of indexItems) {
            if (item.type !== 'session') continue;
            items.push(item.serverId ? item : { ...item, serverId });
        }
    }
    return Object.freeze(items);
}

/**
 * The Event-specific part of the ordinary new-session Automation composer.
 * It reads the one daemon-projected cold Event catalog, borrows the generic
 * exact no-invoke Action form, and leaves durable writing to the incumbent
 * Automation API/store owner.
 */
export function usePluginEventAutomationComposer(params: Readonly<{
    machineId: string | null;
    serverId: string | null;
    projectionPhase: DaemonMergedProjectionPhase;
    projectionInputs: DaemonMergedProjectionInputs | null;
    initialEditSeed?: PluginEventAutomationEditSeed | null;
    initialExistingSessionServerId?: string | null;
    initialExistingSessionTarget?: PluginEventAutomationInitialExistingSessionTarget | null;
}>): PluginEventAutomationComposerModel {
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const availabilityReader = useActivePluginAccountAvailabilityReader();
    const classifyRelease = useActivePluginAccountAvailabilityReleaseClassifier();
    const machineSnapshots = useAllProfileMachineInventorySnapshots();
    const initialEditSeed = params.initialEditSeed ?? null;
    const editTarget = React.useMemo<PluginEventAutomationEditTarget | null>(() => {
        if (
            !initialEditSeed
            || initialEditSeed.automationId.trim().length === 0
            || initialEditSeed.automationId !== initialEditSeed.automationId.trim()
            || !Number.isSafeInteger(initialEditSeed.expectedTemplateVersion)
            || initialEditSeed.expectedTemplateVersion < 0
        ) {
            return null;
        }
        return Object.freeze({
            automationId: initialEditSeed.automationId,
            expectedTemplateVersion: initialEditSeed.expectedTemplateVersion,
        });
    }, [initialEditSeed]);
    const initialExistingSessionTarget = params.initialExistingSessionTarget ?? null;
    const initialTargetKind = initialEditSeed?.target.kind
        ?? (initialExistingSessionTarget ? 'existingSession' : 'newSession');
    const [targetKind, setTargetKindState] = React.useState<PluginEventAutomationTargetKind>(initialTargetKind);
    const initialExistingSessionSelection = React.useMemo<PluginEventAutomationExistingSessionOption | null>(() => {
        const sessionId = initialEditSeed?.target.kind === 'existingSession'
            ? initialEditSeed.target.sessionId
            : initialExistingSessionTarget?.sessionId;
        if (!sessionId) return null;
        const handoffServerId = initialExistingSessionTarget?.sessionId === sessionId
            ? initialExistingSessionTarget.serverId
            : null;
        return Object.freeze({
            sessionId,
            serverId: normalizeSessionTargetId(handoffServerId)
                ?? normalizeSessionTargetId(params.initialExistingSessionServerId)
                ?? resolveServerIdForSessionIdFromLocalCache(sessionId),
            label: sessionId,
        });
    }, [initialEditSeed, initialExistingSessionTarget, params.initialExistingSessionServerId]);
    const [selectedExistingSession, setSelectedExistingSession] = React.useState<PluginEventAutomationExistingSessionOption | null>(
        initialExistingSessionSelection,
    );
    const [executionPermissionMode, setExecutionPermissionModeState] = React.useState<'no_tools' | 'read_only'>(() => (
        initialEditSeed?.target.kind === 'executionRun'
            ? initialEditSeed.target.request.permissionMode
            : 'read_only'
    ));
    const [mode, setModeState] = React.useState<EventComposerMode>(() => (
        editTarget || initialExistingSessionTarget ? 'event' : 'schedule'
    ));
    const [selectedEvent, setSelectedEvent] = React.useState<DaemonContributionRegistryProjectionAutomationEligibleEventV1 | null>(null);
    const selectedEventRef = React.useRef(selectedEvent);
    selectedEventRef.current = selectedEvent;
    const [configuredSetup, setConfiguredSetup] = React.useState<PluginEventAutomationCreateDraft | null>(null);
    const [sourceStatus, setSourceStatus] = React.useState<PluginEventAutomationComposerSourceStatus>('idle');
    const [observationTransport, setObservationTransportState] = React.useState<
        PluginEventAutomationObservationDraft['kind']
    >('checkpointedPull');
    const [webhookEndpoint, setWebhookEndpoint] = React.useState<PluginEventAutomationWebhookEndpoint | null>(null);
    const [webhookEndpointRefreshing, setWebhookEndpointRefreshing] = React.useState(false);
    const nextWebhookEndpointRefreshGenerationRef = React.useRef(0);
    const activeWebhookEndpointRefreshRef = React.useRef<WebhookEndpointRefreshRequest | null>(null);
    // A durable-push edit re-reads its already-ensured endpoint through the
    // canonical webhook owner. That owner keeps the endpoint's exact target
    // materialization and public URL, so the Automation projection never
    // duplicates them and an ordinary edit never re-ensures a credential.
    const [seededWebhookBinding, setSeededWebhookBinding] = React.useState<
        PluginEventAutomationWebhookEndpointBinding | null
    >(null);
    // The configured source, its ensured endpoint, and the one-time secret that
    // endpoint disclosed belong to the Account they were ensured for. The
    // composer tree stays mounted across an ordinary Account change, so
    // aborting in-flight setup is not enough: the already-configured
    // credential must be erased.
    const eraseConfiguredSource = React.useCallback(() => {
        setConfiguredSetup(null);
        setWebhookEndpoint(null);
        setSeededWebhookBinding(null);
        setSourceStatus('idle');
    }, []);
    React.useEffect(() => {
        const retirement = accountLifetime?.onRetire(eraseConfiguredSource);
        return () => retirement?.dispose();
    }, [accountLifetime, eraseConfiguredSource]);
    // The Account the configured source belongs to. Erasing during render
    // rather than only from the retirement callback matters: the successor
    // Account's lifetime can be captured here before the predecessor's callback
    // has run, and by then `isCurrent()` already names the SUCCESSOR, so a
    // currentness check alone would keep disclosing the predecessor's
    // credential.
    //
    // Only the Account is a boundary here. The endpoint is ensured against the
    // Account plus the watcher materialization this composer selected, so a
    // watcher change is already erased by `selectWatcher`, and an out-of-date
    // binding already stops disclosing the credential through the presentation
    // currentness gate. `params.serverId`/`params.machineId` are the `/new`
    // screen's own target selections, which name neither. Erasing on those
    // would destroy an already-disclosed ONE-TIME secret — and, on an edit,
    // permanently strand the form, because the seed effect latches on
    // `appliedEditSeedKeyRef` and cannot restore what it erased.
    const [configuredSourceAccount, setConfiguredSourceAccount] = React.useState(accountLifetime);
    if (configuredSourceAccount !== accountLifetime) {
        setConfiguredSourceAccount(accountLifetime);
        eraseConfiguredSource();
    }
    const [selectedWatcherOrigin, setSelectedWatcherOrigin] = React.useState<PluginMachineExecutionOriginV1 | null>(null);
    const [filterClauses, setFilterClauses] = React.useState<readonly PluginEventAutomationFilterClauseDraft[]>([]);
    const nextFilterClauseIdRef = React.useRef(0);
    const [maximumObservationAgeMsText, setMaximumObservationAgeMsText] = React.useState('');
    const [revision, advanceRevision] = React.useReducer((value: number) => value + 1, 0);
    const settings = useSettings();
    const sessions = useSessions() ?? [];
    const sessionListIndexByServerId = useSessionListIndexByServerId();
    const sessionListItems = React.useMemo(
        () => readSessionListIndexSessionItems(sessionListIndexByServerId),
        [sessionListIndexByServerId],
    );
    const sessionListRowRenderablesByKey = useSessionListRowRenderablesForItems(sessionListItems);
    const existingSessionOptions = React.useMemo(
        () => buildPluginEventAutomationExistingSessionOptions({
            sessionListItems,
            sessionListRowRenderablesByKey,
            sessions,
        }),
        [sessionListItems, sessionListRowRenderablesByKey, sessions],
    );
    const selectedExistingSessionId = selectedExistingSession?.sessionId ?? null;
    const selectedExistingSessionServerId = selectedExistingSession?.serverId ?? null;
    const existingSessionHydration = useHydrateSessionForRoute(
        selectedExistingSessionId ?? '',
        'PluginEventAutomationComposer.hydrateExistingSessionTarget',
        selectedExistingSessionServerId ? { serverId: selectedExistingSessionServerId } : undefined,
    );
    const selectedExistingSessionRecord = useSession(selectedExistingSessionId ?? '');
    const selectedExistingSessionMachineTarget = selectedExistingSessionId
        ? readMachineControlTargetForSession(selectedExistingSessionId)
        : null;
    const selectedExistingSessionDekBase64 = selectedExistingSessionId
        ? sync.getSessionEncryptionKeyBase64ForResume(selectedExistingSessionId)
        : null;
    const existingSessionAvailability = React.useMemo<ExistingSessionAutomationAvailability | null>(() => {
        if (!selectedExistingSessionId) return null;
        return resolveExistingSessionAutomationAvailability({
            sessionHydrated: isSessionRouteHydrationAvailable(existingSessionHydration),
            session: selectedExistingSessionRecord,
            machineIdOverride: selectedExistingSessionMachineTarget?.machineId ?? null,
            sessionDekBase64: selectedExistingSessionDekBase64,
            accountSettings: settings,
        });
    }, [
        existingSessionHydration,
        selectedExistingSessionDekBase64,
        selectedExistingSessionId,
        selectedExistingSessionMachineTarget?.machineId,
        selectedExistingSessionRecord,
        settings,
    ]);
    // Editing an Event may move it between the three approved target arms.
    // The replacement writer rewrites the whole strict recipe for future
    // Runs, and submit re-derives the assignment and capability facts for the
    // arm that is actually saved, so no editor-local arm lock is needed.
    const setTargetKind = React.useCallback((nextKind: PluginEventAutomationTargetKind) => {
        setTargetKindState(nextKind);
        advanceRevision();
    }, []);
    const selectExistingSession = React.useCallback((option: PluginEventAutomationExistingSessionOption) => {
        const selected = existingSessionOptions.find((candidate) => (
            candidate.sessionId === option.sessionId
            && candidate.serverId === option.serverId
        ));
        if (!selected) return;
        setSelectedExistingSession(selected);
        advanceRevision();
    }, [existingSessionOptions]);
    const setExecutionPermissionMode = React.useCallback((nextMode: 'no_tools' | 'read_only') => {
        setExecutionPermissionModeState(nextMode);
        advanceRevision();
    }, []);
    const targetStateRef = React.useRef<Readonly<{
        targetKind: PluginEventAutomationTargetKind;
        selectedExistingSession: PluginEventAutomationExistingSessionOption | null;
    }> | null>(null);
    targetStateRef.current = { targetKind, selectedExistingSession };
    const resolveExecutionTarget = React.useCallback((input: Readonly<{
        newSessionSpawn?: SessionServerStartSpawnDraftV1 | null;
        executionRun?: Readonly<{
            machineId: string | null;
            request: ExecutionRunDetachedStartRequestV1 | null;
        }> | null;
    }>): PluginEventAutomationResolvedTarget | null => {
        const current = targetStateRef.current;
        if (!current) return null;
        if (current.targetKind !== 'existingSession') {
            return resolvePluginEventAutomationTarget({
                kind: current.targetKind,
                ...(input.newSessionSpawn ? { newSessionSpawn: input.newSessionSpawn } : {}),
                ...(input.executionRun ? {
                    executionRun: {
                        machineId: input.executionRun.machineId ?? '',
                        request: input.executionRun.request,
                    },
                } : {}),
            });
        }

        const selected = current.selectedExistingSession;
        if (!selected) return null;
        const session = storage.getState().sessions[selected.sessionId] ?? null;
        const availability = resolveExistingSessionAutomationAvailability({
            sessionHydrated: session !== null,
            session,
            machineIdOverride: readMachineControlTargetForSession(selected.sessionId)?.machineId ?? null,
            sessionDekBase64: sync.getSessionEncryptionKeyBase64ForResume(selected.sessionId),
            accountSettings: storage.getState().settings,
        });
        return resolvePluginEventAutomationTarget({
            kind: 'existingSession',
            existingSession: {
                sessionId: selected.sessionId,
                availability,
            },
        });
    }, []);

    const eligibleEvents = React.useMemo(() => (
        params.projectionPhase === 'ready' && params.projectionInputs?.automationEligibleEvents
            ? params.projectionInputs.automationEligibleEvents
            : []
    ), [params.projectionInputs?.automationEligibleEvents, params.projectionPhase]);
    const eventCatalogStatus = params.projectionPhase === 'ready'
        && params.projectionInputs?.automationEligibleEvents !== undefined
        ? 'ready' as const
        : 'unavailable' as const;
    const presentationStateRef = React.useRef<PluginEventAutomationPresentationState | null>(null);
    presentationStateRef.current = {
        projectionPhase: params.projectionPhase,
        projectionInputs: params.projectionInputs,
        eligibleEvents,
        machineId: params.machineId,
        serverId: params.serverId,
        accountLifetime,
    };
    const getPluginPresentation = React.useCallback((event: DaemonContributionRegistryProjectionAutomationEligibleEventV1) => {
        const currentState = presentationStateRef.current;
        const facts = currentState
            ? readPluginEventAutomationPluginPresentationFacts(currentState, event)
            : null;
        if (!facts) {
            return Object.freeze({
                eventKey: eventPresentationKey(event),
                displayName: event.event.identity.pluginId,
                availability: 'unavailable' as const,
                installedPackage: null,
                expectedGeneration: null,
                machineId: null,
                serverId: null,
                accountLifetime: null,
                isCurrent: () => false,
            });
        }
        return Object.freeze({
            ...facts,
            isCurrent: () => {
                const latest = presentationStateRef.current;
                if (!latest) return false;
                const current = readPluginEventAutomationPluginPresentationFacts(latest, event);
                return current.availability === 'available'
                    && current.eventKey === facts.eventKey;
            },
        });
    }, []);

    const materializationAdmission = React.useMemo(
        () => availabilityReader?.readMaterializations() ?? null,
        [availabilityReader],
    );
    const watcherCandidates = React.useMemo(() => buildPluginMachineExecutionOriginCandidates({
        pluginId: selectedEvent?.event.identity.pluginId ?? initialEditSeed?.eventRef.pluginId ?? '',
        materializations: materializationAdmission?.kind === 'available'
            ? materializationAdmission.materializations
            : [],
        machineSnapshots,
        classifyRelease,
    }), [
        classifyRelease,
        initialEditSeed?.eventRef.pluginId,
        machineSnapshots,
        materializationAdmission,
        selectedEvent?.event.identity.pluginId,
    ]);

    const payloadBrowser = React.useMemo(
        () => buildPluginEventAutomationPayloadBrowser(selectedEvent?.event.payloadSchema),
        [selectedEvent?.event.payloadSchema],
    );
    const filter = React.useMemo<Readonly<{
        value: AutomationEventFilterV1 | null;
        valid: boolean;
    }>>(() => {
        const drafted = readPluginEventAutomationFilterDraft(filterClauses);
        if (!drafted.valid) return Object.freeze({ value: null, valid: false });
        const validation = validateAutomationEventFilterAgainstPayloadSchemaV1({
            filter: drafted.filter,
            payloadSchema: selectedEvent?.event.payloadSchema,
        });
        return validation.kind === 'valid'
            ? Object.freeze({ value: drafted.filter, valid: true })
            : Object.freeze({ value: null, valid: false });
    }, [filterClauses, selectedEvent?.event.payloadSchema]);
    const maximumObservationAgeMs = React.useMemo(
        () => readMaximumObservationAgeMs(maximumObservationAgeMsText),
        [maximumObservationAgeMsText],
    );

    const addFilterClause = React.useCallback(() => {
        const firstField = payloadBrowser.fields[0];
        if (!firstField) return;
        const id = `draft-${nextFilterClauseIdRef.current++}`;
        setFilterClauses((current) => Object.freeze([
            ...current,
            Object.freeze({
                id,
                field: firstField.pointer,
                op: 'eq' as const,
                valueText: JSON.stringify(firstField.sampleValue),
            }),
        ]));
        advanceRevision();
    }, [payloadBrowser.fields]);
    const removeFilterClause = React.useCallback((id: string) => {
        setFilterClauses((current) => {
            const next = current.filter((clause) => clause.id !== id);
            return next.length === current.length ? current : Object.freeze(next);
        });
        advanceRevision();
    }, []);
    const setFilterClauseField = React.useCallback((id: string, field: string) => {
        if (!payloadBrowser.fields.some((candidate) => candidate.pointer === field)) return;
        setFilterClauses((current) => Object.freeze(current.map((clause) => (
            clause.id === id ? Object.freeze({ ...clause, field }) : clause
        ))));
        advanceRevision();
    }, [payloadBrowser.fields]);
    const setFilterClauseOperator = React.useCallback((
        id: string,
        op: PluginEventAutomationFilterClauseDraft['op'],
    ) => {
        if (op !== 'eq' && op !== 'in') return;
        setFilterClauses((current) => Object.freeze(current.map((clause) => (
            clause.id === id ? Object.freeze({ ...clause, op }) : clause
        ))));
        advanceRevision();
    }, []);
    const setFilterClauseValueText = React.useCallback((id: string, valueText: string) => {
        setFilterClauses((current) => Object.freeze(current.map((clause) => (
            clause.id === id ? Object.freeze({ ...clause, valueText }) : clause
        ))));
        advanceRevision();
    }, []);

    const availableObservationTransports = React.useMemo<
        readonly PluginEventAutomationObservationDraft['kind'][]
    >(() => {
        if (!selectedEvent) return Object.freeze(['checkpointedPull' as const]);
        return Object.freeze((['checkpointedPull', 'durablePush'] as const)
            .filter((kind) => supportsPluginEventAutomationObservationTransport(selectedEvent, kind)));
    }, [selectedEvent]);
    // A retired or replaced Event declaration must never leave the composer
    // holding a transport its source contract no longer serves.
    const effectiveObservationTransport = availableObservationTransports.includes(observationTransport)
        ? observationTransport
        : 'checkpointedPull';
    const setObservationTransport = React.useCallback((
        kind: PluginEventAutomationObservationDraft['kind'],
    ) => {
        setObservationTransportState(kind);
        setConfiguredSetup(null);
        setSourceStatus('idle');
        setWebhookEndpoint(null);
        advanceRevision();
    }, []);

    const chooseEvent = React.useCallback((event: DaemonContributionRegistryProjectionAutomationEligibleEventV1) => {
        const current = eligibleEvents.find((candidate) => sameEligibleEvent(candidate, event)) ?? null;
        if (!current) return;
        setSelectedEvent(current);
        setConfiguredSetup(null);
        setSourceStatus('idle');
        setSelectedWatcherOrigin(null);
        setFilterClauses([]);
        setObservationTransportState('checkpointedPull');
        setWebhookEndpoint(null);
        advanceRevision();
    }, [eligibleEvents]);

    const setMode = React.useCallback((nextMode: EventComposerMode) => {
        if (editTarget && nextMode === 'schedule') return;
        setModeState(nextMode);
        if (nextMode === 'schedule') {
            setSelectedEvent(null);
            setConfiguredSetup(null);
            setSourceStatus('idle');
            setSelectedWatcherOrigin(null);
            setFilterClauses([]);
            setObservationTransportState('checkpointedPull');
            setWebhookEndpoint(null);
        }
        advanceRevision();
    }, [editTarget]);

    const selectWatcher = React.useCallback((candidate: PluginMachineExecutionOriginCandidateV1) => {
        const selected = selectedEventRef.current;
        if (
            !selected
            || candidate.materialization.pluginId !== selected.event.identity.pluginId
            || !isPluginMachineExecutionOriginCandidateSelectable(candidate)
        ) {
            return;
        }
        setSelectedWatcherOrigin(composePluginMachineExecutionOriginV1(candidate.materialization));
        setConfiguredSetup(null);
        setSourceStatus('idle');
        setWebhookEndpoint(null);
        advanceRevision();
    }, []);

    const resolveExecutionOrigin = React.useCallback(() => {
        const event = selectedEventRef.current;
        if (!event || !selectedWatcherOrigin) return null;
        return resolveFreshPluginMachineExecutionOrigin({
            pluginId: event.event.identity.pluginId,
            origin: selectedWatcherOrigin,
            reader: availabilityReader,
            classifyRelease,
        });
    }, [availabilityReader, classifyRelease, selectedWatcherOrigin]);

    const appliedEditSeedKeyRef = React.useRef<string | null>(null);
    const editSeedKey = editTarget
        ? `${editTarget.automationId}:${editTarget.expectedTemplateVersion}`
        : null;
    const appliedTargetSeedKeyRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (editTarget) setModeState('event');
    }, [editTarget]);
    React.useEffect(() => {
        if (!initialEditSeed || !editSeedKey || appliedTargetSeedKeyRef.current === editSeedKey) return;
        setTargetKindState(initialEditSeed.target.kind);
        if (initialEditSeed.target.kind === 'existingSession') {
            const sessionId = initialEditSeed.target.sessionId;
            setSelectedExistingSession({
                sessionId,
                serverId: normalizeSessionTargetId(params.initialExistingSessionServerId)
                    ?? resolveServerIdForSessionIdFromLocalCache(sessionId),
                label: sessionId,
            });
        }
        if (initialEditSeed.target.kind === 'executionRun') {
            setExecutionPermissionModeState(initialEditSeed.target.request.permissionMode);
        }
        appliedTargetSeedKeyRef.current = editSeedKey;
        advanceRevision();
    }, [editSeedKey, initialEditSeed, params.initialExistingSessionServerId]);
    // Keyed on the exact persisted identities rather than the seed object, so
    // a caller that rebuilds the seed on every render cannot turn this into a
    // request storm against the endpoint owner.
    const seededPushEndpointId = initialEditSeed?.observation.kind === 'durablePush'
        ? initialEditSeed.observation.webhookEndpointId
        : null;
    const seededPushRoutingSourceInstanceId = initialEditSeed?.observation.kind === 'durablePush'
        ? initialEditSeed.observation.webhookRoutingSourceInstanceId
        : null;
    const seededPushPluginId = initialEditSeed?.eventRef.pluginId ?? null;
    React.useEffect(() => {
        if (
            !seededPushEndpointId
            || !seededPushRoutingSourceInstanceId
            || !seededPushPluginId
            || !accountLifetime
        ) {
            return;
        }
        let alive = true;
        const controller = new AbortController();
        const retirement = accountLifetime.onRetire(() => controller.abort());
        setSeededWebhookBinding(null);
        void (async () => {
            const result = await readPluginEventAutomationWebhookEndpoint({
                webhookEndpointId: seededPushEndpointId,
                expectedPluginId: seededPushPluginId,
                expectedSourceInstanceId: seededPushRoutingSourceInstanceId,
                accountLifetime,
                signal: controller.signal,
            });
            if (!alive || controller.signal.aborted || !accountLifetime.isCurrent()) return;
            setSeededWebhookBinding(result.kind === 'available' ? result.binding : null);
            advanceRevision();
        })();
        return () => {
            alive = false;
            controller.abort();
            retirement.dispose();
        };
    }, [
        accountLifetime,
        seededPushEndpointId,
        seededPushPluginId,
        seededPushRoutingSourceInstanceId,
    ]);
    React.useEffect(() => {
        if (
            !initialEditSeed
            || !editSeedKey
            || appliedEditSeedKeyRef.current === editSeedKey
            || eventCatalogStatus !== 'ready'
        ) {
            return;
        }
        const event = resolveCurrentEligibleEventForEditSeed({
            eligibleEvents,
            seed: initialEditSeed,
        });
        const seedObservation = initialEditSeed.observation;
        // Both arms name one selected plugin materialization: the pull arm's
        // watcher, and the push arm's endpoint target as the endpoint owner
        // currently holds it.
        const seededMaterializationRef = seedObservation.kind === 'checkpointedPull'
            ? seedObservation.watcherMaterializationRef
            : seededWebhookBinding?.targetMaterialization ?? null;
        const watcher = event && seededMaterializationRef
            ? watcherCandidates.find((candidate) => (
                isPluginMachineExecutionOriginCandidateSelectable(candidate)
                && arePluginMachineMaterializationRefsEqual(candidate.materialization, seededMaterializationRef)
            )) ?? null
            : null;
        const watcherOrigin = watcher ? composePluginMachineExecutionOriginV1(watcher.materialization) : null;
        const authoringDraft = event && watcherOrigin
            ? createPluginEventAutomationAuthoringDraft({
                eligibleEvent: event,
                setupResult: initialEditSeed.source,
                watcherOrigin,
                // The persisted transport is replayed exactly. A push edit
                // reuses the endpoint it was authored with, so an ordinary
                // prompt, filter, or target correction never re-runs the
                // one-time credential setup.
                observation: seedObservation.kind === 'checkpointedPull'
                    ? { kind: 'checkpointedPull' }
                    : {
                        kind: 'durablePush',
                        webhookEndpointId: seedObservation.webhookEndpointId,
                    },
                filter: initialEditSeed.filter,
                maximumObservationAgeMs: initialEditSeed.maximumObservationAgeMs,
            })
            : null;

        // A direct definition can arrive before its matching current Event or
        // watcher projection. Keep the transient seed retryable until both
        // canonical owners agree, rather than consuming it on a temporary
        // catalog gap.
        if (!authoringDraft || !event || !watcherOrigin) {
            setConfiguredSetup(null);
            setSourceStatus('unavailable');
            return;
        }

        setSelectedEvent(event);
        setSelectedWatcherOrigin(watcherOrigin);
        setFilterClauses(readPluginEventAutomationFilterClauses(initialEditSeed.filter));
        setMaximumObservationAgeMsText(
            initialEditSeed.maximumObservationAgeMs === null
                ? ''
                : String(initialEditSeed.maximumObservationAgeMs),
        );
        setObservationTransportState(seedObservation.kind);
        setWebhookEndpoint(seededWebhookBinding?.endpoint ?? null);
        setConfiguredSetup(Object.freeze({
            draft: authoringDraft,
            // `createDraft` always replaces this with the current
            // Availability/Administration resolver. This placeholder is
            // never writer input.
            resolveFreshWatcherOrigin: () => null,
        }));
        setSourceStatus('configured');
        appliedEditSeedKeyRef.current = editSeedKey;
        advanceRevision();
    }, [
        editSeedKey,
        eligibleEvents,
        eventCatalogStatus,
        initialEditSeed,
        seededWebhookBinding,
        watcherCandidates,
    ]);
    const setupScope = React.useMemo(
        () => new AbortController(),
        [
            accountLifetime,
            params.machineId,
            params.serverId,
            selectedEvent?.event.immutableGenerationId,
            selectedEvent?.event.identity.localId,
            selectedEvent?.event.identity.pluginId,
            selectedWatcherOrigin?.materializationRef.machineId,
            selectedWatcherOrigin?.materializationRef.materializationId,
            selectedWatcherOrigin?.serverIdentityId,
        ],
    );
    React.useEffect(() => () => setupScope.abort(), [setupScope]);
    React.useEffect(() => {
        const activeRefresh = activeWebhookEndpointRefreshRef.current;
        if (!activeRefresh || activeRefresh.setupScope === setupScope) return;
        activeWebhookEndpointRefreshRef.current = null;
        setWebhookEndpointRefreshing(false);
    }, [setupScope]);

    const configureSource = React.useCallback(() => {
        void (async () => {
            const event = selectedEventRef.current;
            if (!event || !accountLifetime || setupScope.signal.aborted) {
                setSourceStatus('unavailable');
                return;
            }
            if (!filter.valid || !maximumObservationAgeMs.valid) {
                setSourceStatus('unavailable');
                return;
            }
            const currentEvent = eligibleEvents.find((candidate) => sameEligibleEvent(candidate, event)) ?? null;
            if (!currentEvent) {
                setSourceStatus('unavailable');
                return;
            }
            if (!resolveExecutionOrigin()) {
                setSourceStatus('unavailable');
                return;
            }
            if (!supportsPluginEventAutomationObservationTransport(currentEvent, effectiveObservationTransport)) {
                setSourceStatus('unavailable');
                return;
            }
            setSourceStatus('settingUp');
            setWebhookEndpoint(null);
            const configured = await configurePluginEventAutomationSetup({
                eligibleEvent: currentEvent,
                observationTransport: effectiveObservationTransport,
                filter: filter.value,
                maximumObservationAgeMs: maximumObservationAgeMs.value,
                accountLifetime,
                signal: setupScope.signal,
                resolveExecutionOrigin,
                loadCurrentProjection: async (target) => await loadDaemonMergedProjectionInputs({
                    machineId: target.machineId,
                    serverId: target.serverId,
                    staleMs: 0,
                }),
            });
            if (
                setupScope.signal.aborted
                || selectedEventRef.current === null
                || !sameEligibleEvent(selectedEventRef.current, currentEvent)
            ) {
                return;
            }
            if (configured.kind !== 'configured') {
                setSourceStatus('unavailable');
                return;
            }
            setConfiguredSetup(configured.draft);
            setWebhookEndpoint(configured.webhookEndpoint);
            setSourceStatus('configured');
            advanceRevision();
        })();
    }, [
        accountLifetime,
        effectiveObservationTransport,
        eligibleEvents,
        filter.valid,
        filter.value,
        maximumObservationAgeMs.valid,
        maximumObservationAgeMs.value,
        resolveExecutionOrigin,
        setupScope,
    ]);

    const webhookEndpointId = webhookEndpoint?.webhookEndpointId ?? null;
    const webhookEndpointPluginId = configuredSetup?.draft.eventRef.pluginId ?? null;
    // The endpoint was ensured against the setup result's source instance, and
    // the writer persists that same value as the routing source instance, so
    // one reread key covers both create and edit.
    const webhookEndpointSourceInstanceId = configuredSetup?.draft.source.sourceInstanceId ?? null;
    const refreshWebhookEndpoint = React.useCallback(() => {
        if (
            !webhookEndpointId
            || !webhookEndpointPluginId
            || !webhookEndpointSourceInstanceId
            || !accountLifetime
            || setupScope.signal.aborted
        ) {
            return;
        }
        if (activeWebhookEndpointRefreshRef.current?.setupScope === setupScope) return;
        const request = Object.freeze({
            generation: nextWebhookEndpointRefreshGenerationRef.current + 1,
            setupScope,
        });
        nextWebhookEndpointRefreshGenerationRef.current = request.generation;
        activeWebhookEndpointRefreshRef.current = request;
        setWebhookEndpointRefreshing(true);
        void (async () => {
            const result = await readPluginEventAutomationWebhookEndpoint({
                webhookEndpointId,
                expectedPluginId: webhookEndpointPluginId,
                expectedSourceInstanceId: webhookEndpointSourceInstanceId,
                accountLifetime,
                signal: request.setupScope.signal,
            });
            const activeRefresh = activeWebhookEndpointRefreshRef.current;
            if (
                !activeRefresh
                || activeRefresh.generation !== request.generation
                || activeRefresh.setupScope !== request.setupScope
            ) {
                return;
            }
            activeWebhookEndpointRefreshRef.current = null;
            setWebhookEndpointRefreshing(false);
            if (request.setupScope.signal.aborted || !accountLifetime.isCurrent()) return;
            // A reread that cannot reach the owner, or that finds the binding
            // no longer current, keeps the disclosed URL and one-time secret
            // on screen: dropping them would destroy the only copy the user
            // has, and the readiness alert already says the path is unproven.
            if (result.kind !== 'available') return;
            setWebhookEndpoint((current) => applyRefreshedPluginEventAutomationWebhookEndpoint(
                current,
                result.binding.endpoint,
            ));
            advanceRevision();
        })();
    }, [
        accountLifetime,
        setupScope,
        webhookEndpointId,
        webhookEndpointPluginId,
        webhookEndpointSourceInstanceId,
    ]);

    const createDraft = React.useMemo<PluginEventAutomationCreateDraft | null>(() => {
        if (
            mode !== 'event'
            || !configuredSetup
            || !filter.valid
            || !maximumObservationAgeMs.valid
        ) {
            return null;
        }
        const eligibleEvent = resolveCurrentPluginEventAutomationEligibleEvent({
            eligibleEvents,
            draft: configuredSetup.draft,
        });
        if (!eligibleEvent) return null;
        const draft = createPluginEventAutomationAuthoringDraft({
            eligibleEvent,
            setupResult: configuredSetup.draft.source,
            watcherOrigin: configuredSetup.draft.watcherOrigin,
            // The transport comes from the configured setup, never from the
            // live selector: the ensured endpoint and the persisted trigger
            // must name one arm even if the selector moved afterwards.
            observation: configuredSetup.draft.observation,
            filter: filter.value,
            maximumObservationAgeMs: maximumObservationAgeMs.value,
        });
        if (!draft) return null;
        return Object.freeze({
            ...configuredSetup,
            draft,
            resolveFreshWatcherOrigin: resolveExecutionOrigin,
        });
    }, [
        configuredSetup,
        eligibleEvents,
        filter.valid,
        filter.value,
        maximumObservationAgeMs.valid,
        maximumObservationAgeMs.value,
        mode,
        resolveExecutionOrigin,
    ]);

    const sourceDisplayLabel = configuredSetup?.draft.source.displayLabel ?? null;
    const sourceInstanceId = configuredSetup?.draft.source.sourceInstanceId ?? null;

    return React.useMemo(() => ({
        mode,
        setMode,
        isEditingEvent: editTarget !== null,
        editTarget,
        targetKind,
        setTargetKind,
        existingSessionOptions,
        selectedExistingSessionId,
        selectExistingSession,
        existingSessionAvailability,
        executionPermissionMode,
        setExecutionPermissionMode,
        resolveExecutionTarget,
        eligibleEvents,
        eventCatalogStatus,
        selectedEvent,
        selectEvent: chooseEvent,
        getPluginPresentation,
        sourceStatus,
        sourceDisplayLabel,
        sourceInstanceId,
        configureSource,
        availableObservationTransports,
        observationTransport: effectiveObservationTransport,
        setObservationTransport,
        webhookEndpoint,
        refreshWebhookEndpoint: webhookEndpointId === null ? null : refreshWebhookEndpoint,
        webhookEndpointRefreshing,
        watcherCandidates,
        selectedWatcherOrigin,
        selectWatcher,
        payloadBrowser,
        filterClauses,
        addFilterClause,
        removeFilterClause,
        setFilterClauseField,
        setFilterClauseOperator,
        setFilterClauseValueText,
        filterValid: filter.valid,
        maximumObservationAgeMsText,
        setMaximumObservationAgeMsText,
        maximumObservationAgeMsValid: maximumObservationAgeMs.valid,
        createDraft,
        revision,
    }), [
        addFilterClause,
        availableObservationTransports,
        chooseEvent,
        configureSource,
        createDraft,
        editTarget,
        effectiveObservationTransport,
        setObservationTransport,
        webhookEndpoint,
        webhookEndpointId,
        webhookEndpointRefreshing,
        refreshWebhookEndpoint,
        eligibleEvents,
        eventCatalogStatus,
        existingSessionAvailability,
        existingSessionOptions,
        executionPermissionMode,
        filterClauses,
        filter.valid,
        getPluginPresentation,
        maximumObservationAgeMs.valid,
        maximumObservationAgeMsText,
        mode,
        revision,
        payloadBrowser,
        removeFilterClause,
        selectWatcher,
        selectedEvent,
        selectedExistingSessionId,
        selectedWatcherOrigin,
        selectExistingSession,
        resolveExecutionTarget,
        setExecutionPermissionMode,
        setMode,
        setTargetKind,
        sourceDisplayLabel,
        sourceInstanceId,
        sourceStatus,
        setFilterClauseField,
        setFilterClauseOperator,
        setFilterClauseValueText,
        watcherCandidates,
        targetKind,
    ]);
}
