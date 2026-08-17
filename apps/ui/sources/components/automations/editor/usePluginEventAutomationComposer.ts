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
import { getSessionName } from '@/utils/sessions/sessionUtils';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import {
    useActivePluginAccountAvailabilityReader,
    useActivePluginAccountAvailabilityReleaseClassifier,
} from '@/sync/domains/plugins/availability/projection';

import {
    createPluginEventAutomationAuthoringDraft,
    resolveCurrentPluginEventAutomationEligibleEvent,
    type PluginEventAutomationCreateDraft,
    type PluginEventAutomationEditTarget,
} from './pluginEventAutomationDraft';
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

type EventComposerMode = 'schedule' | 'event';

export type PluginEventAutomationComposerSourceStatus =
    | 'idle'
    | 'settingUp'
    | 'configured'
    | 'unavailable';

export type PluginEventAutomationExistingSessionOption = Readonly<{
    sessionId: string;
    serverId: string | null;
    label: string;
}>;

export type PluginEventAutomationInitialExistingSessionTarget = Readonly<{
    kind: 'existingSession';
    sessionId: string;
    serverId: string;
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
    /** Narrow direct-detail CAS fact for the incumbent V3 patch writer. */
    editTarget: PluginEventAutomationEditTarget | null;
    /** Event creation chooses exactly one durable protocol target arm. */
    targetKind: PluginEventAutomationTargetKind;
    setTargetKind: (kind: PluginEventAutomationTargetKind) => void;
    /** An Event edit may change fields inside its arm, never arm kind. */
    targetKindLocked: boolean;
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
    /** Non-persisted strict V3 writer input; null until every owner-local fact is valid/current. */
    createDraft: PluginEventAutomationCreateDraft | null;
    revision: number;
}>;

function sameContributionIdentity(
    left: Readonly<{ pluginId: string; localId: string }>,
    right: Readonly<{ pluginId: string; localId: string }>,
): boolean {
    return left.pluginId === right.pluginId && left.localId === right.localId;
}

function sameEligibleEvent(
    left: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
    right: DaemonContributionRegistryProjectionAutomationEligibleEventV1,
): boolean {
    return sameContributionIdentity(left.event.identity, right.event.identity)
        && left.event.immutableGenerationId === right.event.immutableGenerationId
        && sameContributionIdentity(left.setupAction.identity, right.setupAction.identity)
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

function sameWatcherMaterialization(
    left: Readonly<{ machineId: string; pluginId: string; materializationId: string }>,
    right: Readonly<{ machineId: string; pluginId: string; materializationId: string }>,
): boolean {
    return left.machineId === right.machineId
        && left.pluginId === right.pluginId
        && left.materializationId === right.materializationId;
}

function resolveCurrentEligibleEventForEditSeed(params: Readonly<{
    eligibleEvents: readonly DaemonContributionRegistryProjectionAutomationEligibleEventV1[];
    seed: PluginEventAutomationEditSeed;
}>): DaemonContributionRegistryProjectionAutomationEligibleEventV1 | null {
    const matches = params.eligibleEvents.filter((candidate) => (
        sameContributionIdentity(candidate.event.identity, params.seed.eventRef)
        && candidate.event.automation.source.sourceContractVersion === params.seed.source.sourceContractVersion
        && candidate.event.automation.source.supportedObservationTransports.includes('checkpointedPull')
        && sameContributionIdentity(
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
    const existingSessionOptions = React.useMemo<readonly PluginEventAutomationExistingSessionOption[]>(() => {
        const options: PluginEventAutomationExistingSessionOption[] = [];
        const seen = new Set<string>();
        for (const item of sessionListItems) {
            const sessionId = normalizeSessionTargetId(item.sessionId);
            const serverId = normalizeSessionTargetId(item.serverId);
            if (!sessionId || !serverId) continue;
            const row = sessionListRowRenderablesByKey.get(`${serverId}:${sessionId}`);
            if (!row) continue;
            const key = `${serverId}\u0000${sessionId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            options.push(Object.freeze({
                sessionId,
                serverId,
                label: getSessionName(row),
            }));
        }
        for (const session of sessions) {
            const sessionId = normalizeSessionTargetId(session.id);
            const serverId = normalizeSessionTargetId(session.serverId)
                ?? resolveServerIdForSessionIdFromLocalCache(sessionId ?? '');
            if (!sessionId || !serverId) continue;
            const key = `${serverId}\u0000${sessionId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            options.push(Object.freeze({
                sessionId,
                serverId,
                label: getSessionName(session),
            }));
        }
        return Object.freeze(options);
    }, [sessionListItems, sessionListRowRenderablesByKey, sessions]);
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
    const setTargetKind = React.useCallback((nextKind: PluginEventAutomationTargetKind) => {
        if (editTarget && nextKind !== initialTargetKind) return;
        setTargetKindState(nextKind);
        advanceRevision();
    }, [editTarget, initialTargetKind]);
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

    const chooseEvent = React.useCallback((event: DaemonContributionRegistryProjectionAutomationEligibleEventV1) => {
        const current = eligibleEvents.find((candidate) => sameEligibleEvent(candidate, event)) ?? null;
        if (!current) return;
        setSelectedEvent(current);
        setConfiguredSetup(null);
        setSourceStatus('idle');
        setSelectedWatcherOrigin(null);
        setFilterClauses([]);
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
        const watcher = event
            ? watcherCandidates.find((candidate) => (
                isPluginMachineExecutionOriginCandidateSelectable(candidate)
                && sameWatcherMaterialization(candidate.materialization, initialEditSeed.watcherMaterializationRef)
            )) ?? null
            : null;
        const watcherOrigin = watcher ? composePluginMachineExecutionOriginV1(watcher.materialization) : null;
        const authoringDraft = event && watcherOrigin
            ? createPluginEventAutomationAuthoringDraft({
                eligibleEvent: event,
                setupResult: initialEditSeed.source,
                watcherOrigin,
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
            setSourceStatus('settingUp');
            const configured = await configurePluginEventAutomationSetup({
                eligibleEvent: currentEvent,
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
            setSourceStatus('configured');
            advanceRevision();
        })();
    }, [
        accountLifetime,
        eligibleEvents,
        filter.valid,
        filter.value,
        maximumObservationAgeMs.valid,
        maximumObservationAgeMs.value,
        resolveExecutionOrigin,
        setupScope,
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
        targetKindLocked: editTarget !== null,
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
        chooseEvent,
        configureSource,
        createDraft,
        editTarget,
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
