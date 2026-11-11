import * as React from 'react';
import { readMachineAgentIsolationPolicyV1, resolveMachineAgentExecutionPlacementV1 } from '@happier-dev/protocol/machines/agentIsolationV1';
import type {
    MachinePoolSelectionOriginV1} from '@happier-dev/protocol/machines/pools/v1';
import type {
    SessionAuthoringExecutionTargetV2} from '@happier-dev/protocol/sessions/authoring/fieldCatalog';
import type {
    SessionDirectoryIntentV1,
} from '@happier-dev/protocol/sessions/creation/sessionDirectoryIntentV1';
import { resolveManagedSessionDefaults, type ManagedSessionDefaultsContext, type ManagedSessionPlacementV1, type ResolvedManagedSessionDefaults } from '@happier-dev/protocol/teams/managedDefaults';

import { resolvePreferredLaunchMachineId } from '@/components/settings/pickers/resolvePreferredMachineId';
import { resolveMachineDestinationPurposeEligibility } from '@/components/sessions/new/components/machineSelection/buildMachineDestinationModel';
import { normalizeOptionalParam } from '@/profileRouteParams';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineReachable } from '@/sync/domains/machines/reachability/machineReachability';
import { useMachinePresenceSnapshot } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { useServerScopedLaunchMachine } from '@/sync/store/hooks';
import { isMachineVisibleForSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { getMachineDisplayName, getMachineSentenceName } from '@/utils/sessions/machineDisplayNames';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveDefaultDirectoryForMachine, resolveMachineHomeDirectory } from '@/utils/sessions/machineDefaultDirectory';
import { useMachineOwnIsolationStatus } from '@/hooks/machine/useMachineOwnIsolationStatus';
import { useNewSessionDirectoryPreflight, type NewSessionDirectoryPreflight } from './useNewSessionDirectoryPreflight';
import { formatPathRelativeToHome } from '@/utils/sessions/formatPathRelativeToHome';
import { useStableRecentPathsResolver, type RecentPathSessionsInput } from '@/utils/sessions/useStableRecentPathsForMachine';
import { useNewSessionPlacementSessions } from './useNewSessionPlacementSessions';
import { useNewSessionMachineDisplay } from './useNewSessionMachineDisplay';
import type { ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { resolveManagedMachineArchiveChoiceAvailability, type ManagedMachineArchiveChoiceAvailability } from '@/components/sessions/new/components/machineSelection/managedMachineSelection';

type RecentMachinePathsList = Array<{ machineId: string; path: string }>;
const NO_MACHINE_DEADLINES: readonly Machine[] = [];
const readNoMachineDeadlines = () => NO_MACHINE_DEADLINES;

function normalizeMachineIdParam(raw: unknown): string {
    const normalized = normalizeOptionalParam(
        typeof raw === 'string' || Array.isArray(raw) ? raw : undefined,
    );
    return typeof normalized === 'string' ? normalized.trim() : '';
}

function normalizePathParam(raw: unknown): string {
    const normalized = normalizeOptionalParam(
        typeof raw === 'string' || Array.isArray(raw) ? raw : undefined,
    );
    return typeof normalized === 'string' ? normalized.trim() : '';
}

export type NewSessionInitialPlacement = Readonly<{
    /** The draft's own persisted target is kept as-is (it may be a Temporary computer or none). */
    keepsPersistedTarget: boolean;
    machineId: string | null;
    path: string;
}>;

/**
 * The draft's folder when it belongs on `machineId`. A folder persisted with a Machine belongs
 * only to that Machine; a folder persisted with no target at all (a `currentTarget` seed) names
 * the folder on whichever Machine New Session resolves, so it is never replaced by that
 * Machine's recent folder.
 */
function readPersistedPathForMachine(input: Readonly<{
    persistedExecutionTarget?: SessionAuthoringExecutionTargetV2 | null;
    persistedMachineId?: unknown;
    persistedPath?: unknown;
}>, machineId: string | null): string {
    if (!machineId) return '';
    if (input.persistedExecutionTarget !== undefined && input.persistedExecutionTarget?.kind !== 'machine') return '';
    const persistedMachineId = input.persistedExecutionTarget?.kind === 'machine'
        ? input.persistedExecutionTarget.target.machineId
        : normalizeMachineIdParam(input.persistedMachineId);
    if (persistedMachineId && persistedMachineId !== machineId) return '';
    return normalizePathParam(input.persistedPath);
}

export type NewSessionPlacementForPersistence = Readonly<{
    placementExplicit?: boolean;
    executionTarget: SessionAuthoringExecutionTargetV2 | null | undefined;
    selectedMachineId: string | null;
    managedMachineSelection: ManagedMachineSelectionDraft | null;
    selectedPath: string;
}>;

/**
 * Where a New Session draft starts before any live reconciliation: a requested (route/seeded)
 * machine, else the draft's persisted target, else the Account's preferred launch machine; and
 * the requested folder, else the draft's folder on that machine, else the machine's default one.
 */
export function resolveNewSessionInitialPlacement(input: Readonly<{
    isBot?: boolean;
    scope?: Parameters<typeof isMachineReachable>[0];
    serverId: string | null;
    machines: ReadonlyArray<Machine>;
    recentMachinePaths: ReadonlyArray<Readonly<{ machineId: string; path: string }>>;
    resolveRecentPathsForMachine: (machineId: string | null) => ReadonlyArray<string>;
    machineIdParam?: unknown;
    pathParam?: unknown;
    persistedExecutionTarget?: SessionAuthoringExecutionTargetV2 | null;
    persistedMachineId?: unknown;
    persistedPath?: unknown;
}>): NewSessionInitialPlacement {
    const requestedMachineId = normalizeMachineIdParam(input.machineIdParam);
    const persistedMachineId = input.persistedExecutionTarget?.kind === 'machine'
        ? input.persistedExecutionTarget.target.machineId
        : normalizeMachineIdParam(input.persistedMachineId);
    const keepsPersistedTarget = !requestedMachineId && input.persistedExecutionTarget !== undefined;
    // An ordinary machine target needs a Home to live on; without one nothing is selected.
    const machineId = keepsPersistedTarget
        ? (input.persistedExecutionTarget?.kind === 'machine' ? input.persistedExecutionTarget.target.machineId : null)
        : input.serverId
            ? requestedMachineId || persistedMachineId || resolvePreferredLaunchMachineId({
                scope: input.scope,
                machines: input.machines,
                recentMachinePaths: input.recentMachinePaths,
                preferredMachineId: null,
            })
            : null;

    const requestedPath = normalizePathParam(input.pathParam);
    const persistedPath = normalizePathParam(input.persistedPath);
    let path = requestedPath;
    if (!path && keepsPersistedTarget && input.persistedExecutionTarget?.kind === 'temporary_computer') {
        path = persistedPath;
    } else if (!path) {
        path = readPersistedPathForMachine(input, machineId)
            || resolveDefaultDirectoryForMachine({
                machineId,
                machines: input.machines,
                recentPaths: input.isBot ? [] : input.resolveRecentPathsForMachine(machineId),
            });
    }
    return { keepsPersistedTarget, machineId, path };
}

export function useNewSessionMachinePathState(params: Readonly<{
    /** Creation kind from the ordinary seeded draft; Bots start at home rather than a recent folder. */
    isBot?: boolean;
    serverId: string | null;
    managedDefaults?: ManagedSessionDefaultsContext;
    persistedManagedMachineSelection?: ManagedMachineSelectionDraft | null;
    /** Reviewed intent from a fresh picker return, distinct from retained paid recovery. */
    requestedManagedMachineSelection?: ManagedMachineSelectionDraft | null;
    persistedExecutionTarget?: SessionAuthoringExecutionTargetV2 | null;
    persistedPlacementExplicit?: boolean;
    /** Fresh one-shot handoff identity for an explicit rich picker target. */
    executionTargetRequestKey?: string | null;
    routeSelectionOrigin?: MachinePoolSelectionOriginV1;
    machines: ReadonlyArray<Machine> | (() => ReadonlyArray<Machine>);
    recentMachinePaths: unknown;
    sessions?: RecentPathSessionsInput;
    machineIdParam: unknown;
    pathParam: unknown;
    /** Explicit intent returned by a pushed folder picker; separate from its remembered path. */
    directoryKindParam?: 'path' | 'managed' | null;
    persistedMachineId?: unknown;
    persistedPath?: unknown;
    /** The draft's (or seeding surface's) no-folder choice; absent means the folder. */
    initialDirectoryKind?: 'path' | 'managed' | null;
    /**
     * A surface that decides the directory itself (the embed's new chat passes `{kind:'managed'}`).
     * The intent is then constant, no default folder is resolved, and the folder controls render
     * nothing: callers read `directoryIntentFixed`.
     */
    fixedDirectoryIntent?: SessionDirectoryIntentV1;
    cacheScopeKey?: string | null;
}>): Readonly<{
    executionTarget: SessionAuthoringExecutionTargetV2 | null;
    /** Autosave keeps authored choices so reopening can resolve current managed defaults. */
    placementForPersistence: NewSessionPlacementForPersistence;
    /** A preset must pass through the existing configurator before it has a reviewed creation receipt. */
    managedPlacementPreset: Extract<ManagedSessionPlacementV1, { kind: 'preset' }> | null;
    /** Which managed layer placed that preset, so the composer can say where the choice came from. */
    managedPlacementSource: ResolvedManagedSessionDefaults['placement']['source'] | null;
    managedMachineSelection: ManagedMachineSelectionDraft | null;
    managedMachineArchiveChoiceAvailability: ManagedMachineArchiveChoiceAvailability | null;
    setManagedMachineTarget: (draft: ManagedMachineSelectionDraft, serverId?: string) => void;
    /** Enrollment changes execution placement, not the reviewed recipe or authored folder. */
    adoptManagedMachineTarget: (machineId: string) => void;
    setManagedMachineArchiveEffect: (effect: ManagedMachineSelectionDraft['archiveEffect']) => void;
    cancelManagedMachineTarget: () => void;
    selectedMachineId: string | null;
    selectedMachine: Machine | null;
    selectedMachineDisplay: ReturnType<typeof useNewSessionMachineDisplay>;
    selectedMachineSentenceName: string | null;
    /**
     * The machine whose open Agent catalog this screen shows.
     *
     * It is the selected machine for an ordinary machine target. A Temporary
     * computer has no machine of its own, and an Agent still has to be chosen
     * for it, so the catalog comes from the creator's focused — or most
     * recently used — machine, resolved through the same preferred-machine
     * owner the screen already uses for its default target.
     */
    agentCatalogMachineId: string | null;
    setSelectedMachineId: React.Dispatch<React.SetStateAction<string | null>>;
    setSelectedMachineTarget: (target: Readonly<{
        machineId: string | null;
        selectionOrigin?: MachinePoolSelectionOriginV1 | null;
        path?: string;
    }>) => void;
    setTemporaryComputerTarget: (target: Readonly<{
        serverId: string;
        artifactTarget: Extract<SessionAuthoringExecutionTargetV2, { kind: 'temporary_computer' }>['artifactTarget'];
        workspace: Extract<SessionAuthoringExecutionTargetV2, { kind: 'temporary_computer' }>['workspace'];
        /** Absolute instant; omitted means the default, Never. */
        packageExpiresAt?: number;
    }>) => void;
    /**
     * The folder the session will run in, or `''` when there is none (no folder chosen, or not
     * resolved yet). Folder-scoped features (checkout, file suggestions, MCP, SCM) read this.
     */
    selectedPath: string;
    machineHomeDir: string;
    ownIsolation: ReturnType<typeof useMachineOwnIsolationStatus>;
    /** The folder the draft remembers, kept while there is no folder so choosing it again restores it. */
    rememberedPath: string;
    /** `managed`: no folder; the target machine keeps a private one for the session. */
    directoryKind: 'path' | 'managed';
    /** The intent the session is created with; `null` while a folder intent has no path yet. */
    directoryIntent: SessionDirectoryIntentV1 | null;
    /** True when a surface fixed the intent; the folder and checkout controls render nothing. */
    directoryIntentFixed: boolean;
    /** The one directory-intent writer: every removal and restoration path calls it. */
    setDirectoryIntent: (intent: SessionDirectoryIntentV1) => void;
    setSelectedPath: React.Dispatch<React.SetStateAction<string>>;
    setDraftSelectedPath: (path: string) => void;
    getRequestedPath: () => string;
    getBestPathForMachine: (machineId: string | null) => string;
    directoryPreflight: NewSessionDirectoryPreflight;
    managedWake: 'asleep' | 'starting' | undefined;
}> {
    const { binding } = useServerCredentialAccountScopeBinding(params.serverId);
    const scope = binding?.isCurrent() ? binding.scope : null;
    const liveInventory = typeof params.machines === 'function';
    const readMachines = React.useCallback(() => typeof params.machines === 'function' ? params.machines() : params.machines,
        [params.machines]);
    const recentMachinePaths = React.useMemo((): RecentMachinePathsList => {
        return Array.isArray(params.recentMachinePaths) ? (params.recentMachinePaths as any[]).slice() as any : [];
    }, [params.recentMachinePaths]);
    const resolveRecentPathsForMachine = useStableRecentPathsResolver({
        recentMachinePaths,
        sessions: params.sessions,
        cacheScopeKey: params.cacheScopeKey,
    });

    const resolveMachineId = React.useCallback((preferredMachineId: string | null): string | null => (
        resolvePreferredLaunchMachineId({
            scope,
            machines: readMachines().filter(machine => isMachineReachable(scope, machine)),
            preferredMachineId,
            recentMachinePaths,
        })
    ), [readMachines, scope, recentMachinePaths]);

    const getPersistedPathForMachine = React.useCallback((machineId: string | null): string => readPersistedPathForMachine({
        persistedExecutionTarget: params.persistedExecutionTarget,
        persistedMachineId: params.persistedMachineId,
        persistedPath: params.persistedPath,
    }, machineId), [params.persistedExecutionTarget, params.persistedMachineId, params.persistedPath]);

    const resolvePersistedMachineId = React.useCallback((): string | null => {
        const persistedMachineId = params.persistedExecutionTarget?.kind === 'machine'
            ? params.persistedExecutionTarget.target.machineId
            : normalizeMachineIdParam(params.persistedMachineId);
        if (!persistedMachineId) return null;
        return persistedMachineId;
    }, [params.persistedExecutionTarget, params.persistedMachineId]);

    const machineTarget = React.useCallback((
        machineId: string | null,
        selectionOriginOverride?: MachinePoolSelectionOriginV1 | null,
    ): SessionAuthoringExecutionTargetV2 | null => {
        if (!machineId || !params.serverId) return null;
        if (selectionOriginOverride !== undefined) {
            return {
                kind: 'machine',
                target: { serverId: params.serverId, machineId },
                ...(selectionOriginOverride ? { selectionOrigin: selectionOriginOverride } : {}),
            };
        }
        if (params.routeSelectionOrigin && normalizeMachineIdParam(params.machineIdParam) === machineId) {
            return {
                kind: 'machine',
                target: { serverId: params.serverId, machineId },
                selectionOrigin: params.routeSelectionOrigin,
            };
        }
        const persisted = params.persistedExecutionTarget;
        return persisted?.kind === 'machine'
            && persisted.target.serverId === params.serverId
            && persisted.target.machineId === machineId
            ? persisted
            : { kind: 'machine', target: { serverId: params.serverId, machineId } };
    }, [params.machineIdParam, params.persistedExecutionTarget, params.routeSelectionOrigin, params.serverId]);
    // A route/seeded machine is an exact target. Do not pair its directory
    // with a persisted or preferred machine while that target hydrates.
    const [initialPlacement] = React.useState(() => resolveNewSessionInitialPlacement({
        scope,
        isBot: params.isBot,
        serverId: params.serverId,
        machines: readMachines(),
        recentMachinePaths,
        resolveRecentPathsForMachine,
        machineIdParam: params.machineIdParam,
        pathParam: params.pathParam,
        persistedExecutionTarget: params.persistedExecutionTarget,
        persistedMachineId: params.persistedMachineId,
        persistedPath: params.persistedPath,
    }));
    const hasUserSelectedMachineRef = React.useRef(Boolean(params.requestedManagedMachineSelection
        || params.executionTargetRequestKey));
    const hasCommittedExactTargetRef = React.useRef(
        normalizeMachineIdParam(params.machineIdParam).length > 0
        || normalizeMachineIdParam(params.persistedMachineId).length > 0
        || params.persistedExecutionTarget != null
        || Boolean(params.requestedManagedMachineSelection ?? params.persistedManagedMachineSelection),
    );
    const [authoredExecutionTarget, setExecutionTarget] = React.useState<SessionAuthoringExecutionTargetV2 | null>(() => (
        (params.requestedManagedMachineSelection || params.persistedManagedMachineSelection) && !normalizeMachineIdParam(params.machineIdParam)
            ? null : initialPlacement.keepsPersistedTarget
            ? params.persistedExecutionTarget ?? null
            : machineTarget(initialPlacement.machineId)
    ));
    const [managedMachineSelectionState, setManagedMachineSelection] = React.useState<ManagedMachineSelectionDraft | null>(
        () => normalizeMachineIdParam(params.machineIdParam) ? null : params.requestedManagedMachineSelection ?? params.persistedManagedMachineSelection ?? null,
    );
    const authoredPreset = managedMachineSelectionState?.selection.kind === 'preset'
        ? managedMachineSelectionState.selection : null;
    // Retained targets stay exact for hydration/recovery, but only choices made
    // in this draft (including route/picker handoffs) outrank managed defaults.
    const hasExplicitPlacement = params.persistedPlacementExplicit === true
        || hasUserSelectedMachineRef.current || Boolean(normalizeMachineIdParam(params.machineIdParam));
    // Placement is independent of the Agent target; the shared resolver owns every layer's precedence.
    const placementDecision = React.useMemo(() => resolveManagedSessionDefaults({ ...params.managedDefaults, agentTargetKey: '',
        explicitChoices: hasExplicitPlacement && authoredExecutionTarget?.kind === 'machine'
            ? { placement: { kind: 'machine', target: authoredExecutionTarget.target } }
            : hasExplicitPlacement && authoredPreset
                ? { placement: { kind: 'preset', homeId: authoredPreset.homeId, presetId: authoredPreset.id } }
                : undefined,
    }).placement, [params.managedDefaults, hasExplicitPlacement, authoredExecutionTarget, authoredPreset]);
    // Temporary computers and one-off reviewed configurations have no managed-default wire shape.
    const preservesExplicitTarget = hasExplicitPlacement && placementDecision.lock === null
        && authoredExecutionTarget?.kind !== 'machine' && authoredPreset === null;
    const managedMachineDefault = placementDecision.value?.kind === 'machine' ? placementDecision.value : null;
    const isMemberManagedPlacement = placementDecision.source === 'team' || placementDecision.source === 'group';
    const managedMachineDefaultIsVisible = !isMemberManagedPlacement
        || managedMachineDefault === null
        || readMachines().length === 0
        || readMachines().some(machine => machine.id === managedMachineDefault.target.machineId);
    // A stored Team/Group default is intent only. If its Machine is absent from
    // this member's inventory, let the member's own choice remain effective.
    const effectivePlacement = preservesExplicitTarget || !managedMachineDefaultIsVisible
        ? undefined : placementDecision.value;
    const matchingReviewedPreset = effectivePlacement?.kind === 'preset'
        && authoredPreset?.homeId === effectivePlacement.homeId && authoredPreset.id === effectivePlacement.presetId;
    const executionTarget = effectivePlacement?.kind === 'machine'
        ? authoredExecutionTarget?.kind === 'machine'
            && authoredExecutionTarget.target.serverId === effectivePlacement.target.serverId
            && authoredExecutionTarget.target.machineId === effectivePlacement.target.machineId
            ? authoredExecutionTarget : { kind: 'machine' as const, target: effectivePlacement.target }
        : effectivePlacement?.kind === 'preset' && !matchingReviewedPreset ? null : authoredExecutionTarget;
    const managedPlacementPreset = effectivePlacement?.kind === 'preset' && !matchingReviewedPreset
        ? effectivePlacement : null;
    const controllerSnapshot = useServerScopedLaunchMachine(params.serverId,
        liveInventory ? managedMachineSelectionState?.receipt.controller?.machineId ?? '' : '');
    const resolveArchiveChoiceAvailability = React.useCallback((draft: ManagedMachineSelectionDraft) => {
        const pair = draft.receipt.controller;
        return resolveManagedMachineArchiveChoiceAvailability({ draft,
            controller: pair ? readMachines().find(machine => machine.id === pair.machineId
                && machine.installationId === pair.installationId) : undefined });
    }, [readMachines]);
    const managedMachineArchiveChoiceAvailability = React.useMemo(() => managedMachineSelectionState
        ? resolveArchiveChoiceAvailability(managedMachineSelectionState) : null,
    [controllerSnapshot, managedMachineSelectionState, resolveArchiveChoiceAvailability]);
    // A foreign controller cannot host this Account's automatic rule. The paid
    // recipe stays usable and Keep leaves manual power/delete authority intact.
    const reviewedManagedMachineSelection = effectivePlacement
        && placementDecision.source !== 'explicit' && !matchingReviewedPreset ? null : managedMachineSelectionState;
    const managedMachineSelection = React.useMemo(() => reviewedManagedMachineSelection
        && reviewedManagedMachineSelection.archiveEffect !== 'keep'
        && managedMachineArchiveChoiceAvailability?.reason === 'shared_unsupported'
        ? { ...reviewedManagedMachineSelection, archiveEffect: 'keep' as const } : reviewedManagedMachineSelection,
    [reviewedManagedMachineSelection, managedMachineArchiveChoiceAvailability]);
    const managedSelectionServerRef = React.useRef(params.serverId);
    const selectedMachineId = executionTarget?.kind === 'machine' ? executionTarget.target.machineId : null;
    // Machine ids, folders and catalogs are Home-scoped. Keep the qualified target while its Home's inputs are unavailable.
    const selectedTargetInCurrentHome = executionTarget?.kind !== 'machine'
        || areServerProfileIdentifiersEquivalent(executionTarget.target.serverId, params.serverId);
    const scopedSelectedMachineId = selectedTargetInCurrentHome ? selectedMachineId : null;
    const selectedMachineSnapshot = useServerScopedLaunchMachine(params.serverId, liveInventory ? scopedSelectedMachineId ?? '' : '');
    const selectedMachine = !selectedTargetInCurrentHome ? null : liveInventory
        ? selectedMachineSnapshot && isMachineVisibleForSelection(selectedMachineSnapshot) ? selectedMachineSnapshot : null
        : readMachines().find(machine => machine.id === selectedMachineId) ?? null;
    const isolationPolicy = readMachineAgentIsolationPolicyV1(selectedMachine?.metadata);
    const destination = resolveMachineDestinationPurposeEligibility('session', undefined, selectedMachine ?? undefined, scope);
    const managedWake = destination.eligible ? destination.managedWake : undefined;
    const memberPlacement = isolationPolicy.status === 'ready' && resolveMachineAgentExecutionPlacementV1({
        policy: isolationPolicy.policy, platform: selectedMachine?.metadata?.platform ?? '',
    }) === 'member';
    const ownIsolation = useMachineOwnIsolationStatus({ machineId: selectedMachineId, machine: selectedMachine, serverId: params.serverId,
        enabled: selectedMachine?.isShared === true || memberPlacement });
    const machineHomeDir = resolveMachineHomeDirectory({ machine: selectedMachine, ownStatus: ownIsolation.status });
    const getBestPathForMachine = React.useCallback((machineId: string | null): string => (
        resolveDefaultDirectoryForMachine({ machineId, machines: readMachines(),
            recentPaths: params.isBot ? [] : resolveRecentPathsForMachine(machineId),
            ownStatus: machineId === selectedMachineId ? ownIsolation.status : undefined,
        })
    ), [params.isBot, readMachines, resolveRecentPathsForMachine, selectedMachineId, ownIsolation.status]);
    const selectedMachineDisplay = useNewSessionMachineDisplay(scope, scopedSelectedMachineId, selectedMachine);
    // A selected name can acquire a disambiguating suffix when another Machine
    // appears. Observe that one primitive, not the fleet objects, and schedule no
    // presence deadlines for a label which is independent of reachability.
    const readSelectedMachineSentenceName = React.useCallback(() => {
        if (!selectedTargetInCurrentHome) return null;
        const machines = readMachines();
        const machine = machines.find(row => row.id === selectedMachineId);
        if (selectedMachineDisplay?.metadata && !machine?.metadata) return getMachineSentenceName(selectedMachineDisplay);
        return machine ? getMachineSentenceName(machine, getMachineDisplayName(machine, machines)) : null;
    }, [readMachines, selectedMachineId, selectedMachineDisplay, selectedTargetInCurrentHome]);
    const nameTargets = React.useMemo(() => liveInventory && scopedSelectedMachineId ? [{ serverId: params.serverId }] : [],
        [liveInventory, params.serverId, scopedSelectedMachineId]);
    const selectedMachineSentenceName = useMachinePresenceSnapshot(readNoMachineDeadlines, readSelectedMachineSentenceName, nameTargets);
    const executionTargetRef = React.useRef(executionTarget);
    executionTargetRef.current = executionTarget;
    const setSelectedMachineIdState = React.useCallback((machineId: string | null) => {
        setManagedMachineSelection(null);
        setExecutionTarget((current) => {
            const next = machineTarget(machineId);
            return current?.kind === 'machine'
                && next?.kind === 'machine'
                && current.target.serverId === next.target.serverId
                && current.target.machineId === next.target.machineId
                && current.selectionOrigin?.poolId === next.selectionOrigin?.poolId
                ? current
                : next;
        });
    }, [machineTarget, params.serverId]);
    const selectedMachineIdRef = React.useRef<string | null>(selectedMachineId);
    selectedMachineIdRef.current = selectedMachineId;
    // Observe the destination decision, through the existing Home-scoped presence
    // lifecycle. An authored target needs no automatic placement observation;
    // its admission owner keeps observing that exact Machine's availability.
    const needsCatalogFallback = managedPlacementPreset !== null || (managedMachineSelection !== null && selectedMachineId === null)
        || executionTarget?.kind === 'temporary_computer';
    const observesPreferredMachine = needsCatalogFallback
        || (!effectivePlacement && !hasCommittedExactTargetRef.current && !hasUserSelectedMachineRef.current);
    const readPlacementMachines = React.useCallback(() => observesPreferredMachine ? readMachines() : [],
        [observesPreferredMachine, readMachines]);
    const readPreferredMachine = React.useCallback(() => observesPreferredMachine
        ? resolveMachineId(needsCatalogFallback ? resolvePersistedMachineId() : selectedMachineId)
        : null,
    [needsCatalogFallback, observesPreferredMachine, resolveMachineId, resolvePersistedMachineId, selectedMachineId]);
    const placementPresenceTargets = React.useMemo(() => observesPreferredMachine ? [{ serverId: params.serverId }] : [],
        [observesPreferredMachine, params.serverId]);
    const preferredMachineId = useMachinePresenceSnapshot(readPlacementMachines, readPreferredMachine, placementPresenceTargets);
    const agentCatalogMachineId = needsCatalogFallback ? preferredMachineId : scopedSelectedMachineId;
    const lastAppliedPersistedMachineIdRef = React.useRef<string>('');
    const lastAppliedExecutionTargetRequestKeyRef = React.useRef<string | null>(
        params.executionTargetRequestKey ?? null,
    );
    const lastAppliedRouteOriginPoolIdRef = React.useRef<string | null>(null);

    // Keyed by value so a caller's inline `{kind:'managed'}` never re-runs the owner's effects.
    const fixedDirectoryKind = params.fixedDirectoryIntent?.kind ?? null;
    const fixedDirectoryPath = params.fixedDirectoryIntent?.kind === 'path' ? params.fixedDirectoryIntent.path : null;
    const fixedDirectoryIntent = React.useMemo<SessionDirectoryIntentV1 | null>(() => (
        fixedDirectoryKind === 'managed' ? { kind: 'managed' }
            : fixedDirectoryKind === 'path' && fixedDirectoryPath ? { kind: 'path', path: fixedDirectoryPath }
                : null
    ), [fixedDirectoryKind, fixedDirectoryPath]);
    const [directoryKindState, setDirectoryKindState] = React.useState<'path' | 'managed'>(
        () => ((params.directoryKindParam ?? params.initialDirectoryKind) === 'managed' ? 'managed' : 'path'),
    );
    const directoryKind = fixedDirectoryIntent ? fixedDirectoryIntent.kind : directoryKindState;
    const directoryKindRef = React.useRef(directoryKind);
    directoryKindRef.current = directoryKind;
    const [selectedPath, setSelectedPathState] = React.useState<string>(() => (
        (params.requestedManagedMachineSelection || params.persistedManagedMachineSelection) && !normalizeMachineIdParam(params.machineIdParam)
            ? normalizePathParam(params.pathParam) || normalizePathParam(params.persistedPath) || initialPlacement.path
            : initialPlacement.path
    ));
    const selectedPathDraftRef = React.useRef<string>(selectedPath);
    const hasUserEditedPathRef = React.useRef(Boolean(params.isBot && normalizePathParam(params.persistedPath)
        && formatPathRelativeToHome(normalizePathParam(params.persistedPath),
            readMachines().find(machine => machine.id === (initialPlacement.machineId
                ?? managedMachineSelection?.receipt.controller?.machineId))?.metadata?.homeDir) !== '~'));
    // A not-yet-resolved default must observe the first history arrival. Once a
    // folder is committed, later history is read only when another is chosen.
    const unresolvedPlacementHistory = useNewSessionPlacementSessions(
        typeof params.sessions === 'function' && !fixedDirectoryIntent && selectedMachineId !== null
        && selectedPath.trim().length === 0 && !hasUserEditedPathRef.current && !normalizePathParam(params.pathParam),
    );
    const lastAppliedMachineParamRef = React.useRef<Readonly<{ machineId: string; scopeKey: string | null }> | null>(null);
    const lastAppliedPathParamRef = React.useRef<string>('');
    const applyCommittedSelectedPath = React.useCallback((nextPath: string) => {
        selectedPathDraftRef.current = nextPath;
        setSelectedPathState(nextPath);
    }, []);
    const managedPlacementMachineKey = effectivePlacement?.kind === 'machine' && placementDecision.source !== 'explicit'
        ? JSON.stringify([effectivePlacement.target.serverId, effectivePlacement.target.machineId]) : null;
    const lastManagedPlacementMachineKeyRef = React.useRef<string | null>(null);
    React.useEffect(() => {
        if (!selectedTargetInCurrentHome) return;
        const previousKey = lastManagedPlacementMachineKeyRef.current;
        if (previousKey === managedPlacementMachineKey) return;
        lastManagedPlacementMachineKeyRef.current = managedPlacementMachineKey;
        if (!managedPlacementMachineKey && previousKey === null) return;
        if (hasUserEditedPathRef.current || normalizePathParam(params.pathParam)) return;
        applyCommittedSelectedPath(getBestPathForMachine(selectedMachineId));
    }, [applyCommittedSelectedPath, getBestPathForMachine, managedPlacementMachineKey, params.pathParam, selectedMachineId, selectedTargetInCurrentHome]);

    /**
     * Is this selection a *qualified target change*?
     *
     * Only a different Home+Machine is. Re-selecting the Machine already
     * authored — or resolving that same Machine through a Pool, which adds
     * provenance and nothing else — is not, and must never reconcile the
     * authored working directory: that directory is the user's unsaved work and
     * decides where the Agent actually runs.
     */
    const isQualifiedMachineTargetChange = React.useCallback((machineId: string | null): boolean => {
        const current = executionTargetRef.current;
        if (current?.kind !== 'machine') return true;
        return current.target.serverId !== params.serverId || current.target.machineId !== machineId;
    }, [params.serverId]);

    const setSelectedMachineTarget = React.useCallback((target: Readonly<{
        machineId: string | null;
        selectionOrigin?: MachinePoolSelectionOriginV1 | null;
        /** An explicitly authored directory. Callers do not pass a default here. */
        path?: string;
    }>) => {
        hasUserSelectedMachineRef.current = true;
        setManagedMachineSelection(null);
        if (target.path !== undefined) {
            hasUserEditedPathRef.current = false;
            applyCommittedSelectedPath(target.path);
        } else if (isQualifiedMachineTargetChange(target.machineId)) {
            // The owner supplies the default, and only for a real target change.
            hasUserEditedPathRef.current = false;
            const directoryMachineId = placementDecision.lock ? selectedMachineIdRef.current : target.machineId;
            applyCommittedSelectedPath(
                getPersistedPathForMachine(directoryMachineId) || getBestPathForMachine(directoryMachineId),
            );
        }
        setExecutionTarget(() => {
            hasCommittedExactTargetRef.current = target.machineId !== null;
            return machineTarget(target.machineId, target.selectionOrigin ?? null);
        });
    }, [
        applyCommittedSelectedPath,
        getBestPathForMachine,
        getPersistedPathForMachine,
        isQualifiedMachineTargetChange,
        machineTarget,
        placementDecision.lock,
    ]);

    const setSelectedMachineId = React.useCallback<React.Dispatch<React.SetStateAction<string | null>>>((next) => {
        const machineId = typeof next === 'function'
            ? next(selectedMachineIdRef.current)
            : next;
        setSelectedMachineTarget({ machineId, selectionOrigin: null });
    }, [setSelectedMachineTarget]);

    const setTemporaryComputerTarget = React.useCallback((target: Readonly<{
        serverId: string;
        artifactTarget: Extract<SessionAuthoringExecutionTargetV2, { kind: 'temporary_computer' }>['artifactTarget'];
        workspace: Extract<SessionAuthoringExecutionTargetV2, { kind: 'temporary_computer' }>['workspace'];
        packageExpiresAt?: number;
    }>) => {
        hasUserSelectedMachineRef.current = true;
        hasCommittedExactTargetRef.current = true;
        setManagedMachineSelection(null);
        // A Temporary computer's endpoint chooses its folder; no-folder is a machine target's choice.
        setDirectoryKindState('path');
        setExecutionTarget({ kind: 'temporary_computer', ...target });
    }, []);

    const setManagedMachineTarget = React.useCallback((draft: ManagedMachineSelectionDraft, serverId?: string) => {
        hasUserSelectedMachineRef.current = true;
        hasCommittedExactTargetRef.current = true;
        managedSelectionServerRef.current = serverId ?? params.serverId;
        setManagedMachineSelection(draft);
        setExecutionTarget(null);
    }, [params.serverId]);
    const adoptManagedMachineTarget = React.useCallback((machineId: string) => {
        hasUserSelectedMachineRef.current = true;
        hasCommittedExactTargetRef.current = true;
        // An untouched Bot default belongs to its enrolled machine, never the controller.
        // An authored or restored folder remains the user's choice.
        if (params.isBot && !hasUserEditedPathRef.current
            && !normalizePathParam(params.pathParam)) {
            applyCommittedSelectedPath(getBestPathForMachine(machineId));
        }
        setExecutionTarget(machineTarget(machineId));
    }, [applyCommittedSelectedPath, getBestPathForMachine, machineTarget, params.isBot, params.pathParam]);
    const setManagedMachineArchiveEffect = React.useCallback((archiveEffect: ManagedMachineSelectionDraft['archiveEffect']) => {
        setManagedMachineSelection(current => {
            if (!current || current.archiveEffect === archiveEffect) return current;
            if (!resolveArchiveChoiceAvailability(current).supportedEffects.includes(archiveEffect)) return current;
            return { ...current, archiveEffect };
        });
    }, [resolveArchiveChoiceAvailability]);
    const cancelManagedMachineTarget = React.useCallback(() => {
        hasUserSelectedMachineRef.current = true;
        hasCommittedExactTargetRef.current = true;
        setManagedMachineSelection(null);
        setExecutionTarget(null);
    }, []);
    React.useEffect(() => {
        if (managedSelectionServerRef.current === params.serverId) return;
        managedSelectionServerRef.current = params.serverId;
        setManagedMachineSelection(null);
    }, [params.serverId]);

    const setSelectedPath = React.useCallback<React.Dispatch<React.SetStateAction<string>>>((next) => {
        hasUserEditedPathRef.current = true;
        hasUserSelectedMachineRef.current = true;
        // Choosing a folder is choosing to have one.
        setDirectoryKindState('path');
        hasCommittedExactTargetRef.current = executionTargetRef.current !== null;
        setExecutionTarget(executionTargetRef.current);
        setSelectedPathState((current) => {
            const resolved = typeof next === 'function' ? next(current) : next;
            selectedPathDraftRef.current = resolved;
            return resolved;
        });
    }, []);

    const setDraftSelectedPath = React.useCallback((path: string) => {
        hasUserEditedPathRef.current = true;
        hasUserSelectedMachineRef.current = true;
        hasCommittedExactTargetRef.current = executionTargetRef.current !== null;
        setExecutionTarget(executionTargetRef.current);
        selectedPathDraftRef.current = path;
    }, []);

    const getRequestedPath = React.useCallback(() => {
        if (!selectedTargetInCurrentHome) return '';
        // Blank picker text has not selected a replacement folder. Keep the
        // committed directory that the chip shows until another path is authored.
        return directoryKindRef.current === 'managed' ? ''
            : selectedPathDraftRef.current.trim() ? selectedPathDraftRef.current : selectedPath;
    }, [selectedPath, selectedTargetInCurrentHome]);

    const setDirectoryIntent = React.useCallback((intent: SessionDirectoryIntentV1) => {
        if (fixedDirectoryIntent) return;
        if (intent.kind === 'managed') {
            hasUserSelectedMachineRef.current = true;
            hasCommittedExactTargetRef.current = executionTargetRef.current !== null;
            setExecutionTarget(executionTargetRef.current);
            setDirectoryKindState('managed');
            return;
        }
        setSelectedPath(intent.path);
    }, [fixedDirectoryIntent, setSelectedPath]);

    React.useEffect(() => {
        if (params.directoryKindParam === 'managed') setDirectoryIntent({ kind: 'managed' });
        else if (params.directoryKindParam === 'path') {
            const path = normalizePathParam(params.pathParam);
            if (path) setDirectoryIntent({ kind: 'path', path });
        }
    }, [params.directoryKindParam, params.pathParam, setDirectoryIntent]);

    const hasMachine = React.useCallback((machineId: string | null): boolean => {
        if (!machineId) return false;
        return readMachines().some((machine) => machine.id === machineId);
    }, [readMachines]);

    // Handle machine route param from picker screens (main's navigation pattern)
    React.useEffect(() => {
        const machineId = normalizeMachineIdParam(params.machineIdParam);
        const scopeKey = params.cacheScopeKey ?? null;
        const routeOriginPoolId = params.routeSelectionOrigin?.poolId ?? null;
        if (!machineId) {
            lastAppliedMachineParamRef.current = null;
            lastAppliedRouteOriginPoolIdRef.current = null;
            return;
        }
        // Applying an exact ID does not require a hydrated Machine row. Consume
        // the route value once so reconnect cannot undo a later user selection.
        const previousRouteTarget = lastAppliedMachineParamRef.current;
        if (
            machineId === previousRouteTarget?.machineId
            && scopeKey === previousRouteTarget.scopeKey
            && routeOriginPoolId === lastAppliedRouteOriginPoolIdRef.current
        ) {
            return;
        }
        lastAppliedMachineParamRef.current = { machineId, scopeKey };
        lastAppliedRouteOriginPoolIdRef.current = routeOriginPoolId;
        if (
            (!previousRouteTarget || previousRouteTarget.scopeKey === scopeKey)
            && !isQualifiedMachineTargetChange(machineId)
        ) {
            // The same Home+Machine came back, possibly with new Pool provenance.
            // Let the origin update and leave the authored folder alone; the same
            // decision the in-place pickers make. Whether the local Machine row has
            // hydrated does not change what the target is.
            setSelectedMachineIdState(machineId);
            return;
        }
        if (!hasMachine(machineId)) {
            // A fresh route target is authoritative before its row hydrates;
            // the consumed qualified route above prevents stale reconnects.
            hasUserEditedPathRef.current = false;
            applyCommittedSelectedPath(
                normalizePathParam(params.pathParam)
                || getPersistedPathForMachine(machineId)
                || getBestPathForMachine(machineId),
            );
            hasCommittedExactTargetRef.current = true;
            setSelectedMachineIdState(machineId);
            return;
        }
        hasUserSelectedMachineRef.current = true;
        hasCommittedExactTargetRef.current = true;
        setSelectedMachineIdState(machineId);
        hasUserEditedPathRef.current = false;
        const trimmedPath = normalizePathParam(params.pathParam);
        applyCommittedSelectedPath(trimmedPath || getPersistedPathForMachine(machineId) || getBestPathForMachine(machineId));
    }, [applyCommittedSelectedPath, getBestPathForMachine, getPersistedPathForMachine, hasMachine, isQualifiedMachineTargetChange, params.cacheScopeKey, params.machineIdParam, params.pathParam, params.routeSelectionOrigin, setSelectedMachineIdState]);

    React.useEffect(() => {
        const requestKey = params.executionTargetRequestKey ?? null;
        if (requestKey === null || requestKey === lastAppliedExecutionTargetRequestKeyRef.current) {
            return;
        }
        lastAppliedExecutionTargetRequestKeyRef.current = requestKey;
        if (params.requestedManagedMachineSelection) {
            setManagedMachineTarget(params.requestedManagedMachineSelection);
            return;
        }
        if (params.persistedExecutionTarget === undefined) return;

        hasUserSelectedMachineRef.current = true;
        hasCommittedExactTargetRef.current = params.persistedExecutionTarget !== null;
        setManagedMachineSelection(null);
        setExecutionTarget(params.persistedExecutionTarget);
        if (params.persistedExecutionTarget?.kind === 'temporary_computer' && !hasUserEditedPathRef.current) {
            applyCommittedSelectedPath(normalizePathParam(params.persistedPath));
        }
    }, [applyCommittedSelectedPath, params.executionTargetRequestKey, params.requestedManagedMachineSelection, params.persistedExecutionTarget, params.persistedPath, setManagedMachineTarget]);

    React.useEffect(() => {
        const routeMachineId = normalizeMachineIdParam(params.machineIdParam);
        if (routeMachineId) {
            lastAppliedPersistedMachineIdRef.current = '';
            return;
        }
        if (hasUserSelectedMachineRef.current) {
            return;
        }

        if (params.persistedManagedMachineSelection) {
            hasCommittedExactTargetRef.current = true;
            setManagedMachineSelection(params.persistedManagedMachineSelection);
            setExecutionTarget(null);
            if (!hasUserEditedPathRef.current && !effectivePlacement) applyCommittedSelectedPath(normalizePathParam(params.persistedPath));
            return;
        }

        if (params.persistedExecutionTarget?.kind === 'temporary_computer') {
            hasCommittedExactTargetRef.current = true;
            setExecutionTarget(params.persistedExecutionTarget);
            if (!hasUserEditedPathRef.current && !effectivePlacement) {
                applyCommittedSelectedPath(normalizePathParam(params.persistedPath));
            }
            return;
        }

        const reconciledPersistedMachineId = resolvePersistedMachineId();
        if (!reconciledPersistedMachineId) {
            lastAppliedPersistedMachineIdRef.current = '';
            return;
        }
        // Reopening a draft restores authored placement, including an absent or offline
        // Machine. Availability controls Start; only an explicit choice changes its target.
        if (reconciledPersistedMachineId === lastAppliedPersistedMachineIdRef.current) {
            return;
        }

        lastAppliedPersistedMachineIdRef.current = reconciledPersistedMachineId;
        hasCommittedExactTargetRef.current = true;
        if (reconciledPersistedMachineId === selectedMachineIdRef.current) {
            return;
        }

        setSelectedMachineIdState(reconciledPersistedMachineId);
        // The effective managed target already owns its default directory above.
        // Restoring the fallback must not overwrite that target's folder.
        if (effectivePlacement) return;
        hasUserEditedPathRef.current = false;
        applyCommittedSelectedPath(
            getPersistedPathForMachine(reconciledPersistedMachineId) || getBestPathForMachine(reconciledPersistedMachineId),
        );
    }, [
        applyCommittedSelectedPath,
        getBestPathForMachine,
        getPersistedPathForMachine,
        effectivePlacement,
        params.machineIdParam,
        params.persistedExecutionTarget,
        params.persistedManagedMachineSelection,
        params.persistedPath,
        resolvePersistedMachineId,
        setSelectedMachineIdState,
    ]);

    // Ensure a machine is pre-selected once machines have loaded (wizard expects this).
    React.useEffect(() => {
        if (executionTarget !== null || managedMachineSelection !== null) return;
        if (managedPlacementPreset) return;
        if (hasUserSelectedMachineRef.current) return;
        if (readMachines().length === 0) return;
        if (normalizeMachineIdParam(params.machineIdParam)) return;
        // Let persisted reconciliation own hydration when its preferred machine is available.
        // Otherwise this fallback can enqueue a competing selection in the same effect flush,
        // causing the persisted effect to run again against a stale selectedMachineId.
        if (resolvePersistedMachineId() !== null) return;
        if (params.persistedExecutionTarget !== undefined) return;
        const machineIdToUse = resolveMachineId(null);
        const trimmedPath = normalizePathParam(params.pathParam);

        hasUserSelectedMachineRef.current = false;
        hasCommittedExactTargetRef.current = false;
        setSelectedMachineIdState(machineIdToUse);
        hasUserEditedPathRef.current = false;
        applyCommittedSelectedPath(trimmedPath || getPersistedPathForMachine(machineIdToUse) || getBestPathForMachine(machineIdToUse));
    }, [applyCommittedSelectedPath, executionTarget, managedMachineSelection, managedPlacementPreset, getBestPathForMachine, getPersistedPathForMachine, readMachines, params.pathParam, params.persistedExecutionTarget, params.serverId, preferredMachineId, resolveMachineId, setSelectedMachineIdState]);

    // Keep selection valid when machine snapshots change (server/account switch, revoke, reconnect).
    React.useEffect(() => {
        if (selectedMachineId === null) return;
        if (effectivePlacement) return;
        if (hasMachine(selectedMachineId)) return;
        if (hasCommittedExactTargetRef.current) return;

        const machineIdToUse = resolveMachineId(null);
        if (machineIdToUse === selectedMachineId) return;

        hasUserSelectedMachineRef.current = false;
        hasCommittedExactTargetRef.current = false;
        setSelectedMachineIdState(machineIdToUse);
        hasUserEditedPathRef.current = false;
        applyCommittedSelectedPath(getPersistedPathForMachine(machineIdToUse) || getBestPathForMachine(machineIdToUse));
    }, [applyCommittedSelectedPath, effectivePlacement, getBestPathForMachine, getPersistedPathForMachine, hasMachine, resolveMachineId, selectedMachine, selectedMachineId]);

    // An automatic default follows current reachability, including a machine that was
    // online earlier. Explicit user/route choices and authored directories stay exact.
    React.useEffect(() => {
        if (selectedMachineId === null) return;
        if (effectivePlacement) return;
        if (hasCommittedExactTargetRef.current) return;
        if (hasUserSelectedMachineRef.current) return;
        if (normalizeMachineIdParam(params.machineIdParam)) return;

        const machineIdToUse = resolveMachineId(selectedMachineId);
        if (!machineIdToUse || machineIdToUse === selectedMachineId) return;

        hasUserSelectedMachineRef.current = false;
        hasCommittedExactTargetRef.current = false;
        setSelectedMachineIdState(machineIdToUse);

        if (hasUserEditedPathRef.current) return;
        const trimmedPath = normalizePathParam(params.pathParam);
        hasUserEditedPathRef.current = false;
        applyCommittedSelectedPath(trimmedPath || getPersistedPathForMachine(machineIdToUse) || getBestPathForMachine(machineIdToUse));
    }, [applyCommittedSelectedPath, effectivePlacement, getBestPathForMachine, getPersistedPathForMachine, params.machineIdParam, params.pathParam, preferredMachineId, resolveMachineId, selectedMachineId]);

    // Handle path route param from picker screens (main's navigation pattern)
    React.useEffect(() => {
        const trimmedPath = normalizePathParam(params.pathParam);

        if (trimmedPath === lastAppliedPathParamRef.current) {
            return;
        }

        lastAppliedPathParamRef.current = trimmedPath;
        if (trimmedPath && params.directoryKindParam !== 'managed') setDirectoryKindState('path');
        if (trimmedPath && trimmedPath !== selectedPath) {
            hasUserEditedPathRef.current = false;
            applyCommittedSelectedPath(trimmedPath);
        }
    }, [applyCommittedSelectedPath, hasMachine, params.machineIdParam, params.pathParam, params.directoryKindParam, selectedPath]);

    React.useEffect(() => {
        // A fixed intent decides the directory; there is no default folder to resolve.
        if (!selectedTargetInCurrentHome) return;
        if (fixedDirectoryIntent) return;
        if (!selectedMachineId) {
            return;
        }
        if (normalizePathParam(params.pathParam)) {
            return;
        }
        if (hasUserEditedPathRef.current) {
            return;
        }

        const persistedPath = hasUserSelectedMachineRef.current ? '' : getPersistedPathForMachine(selectedMachineId);
        if (persistedPath) {
            if (selectedPath !== persistedPath) {
                applyCommittedSelectedPath(persistedPath);
            }
            return;
        }

        if (selectedPath.trim().length > 0) {
            return;
        }

        const bestPath = getBestPathForMachine(selectedMachineId);
        if (!bestPath) {
            return;
        }

        applyCommittedSelectedPath(bestPath);
    }, [applyCommittedSelectedPath, fixedDirectoryIntent, getBestPathForMachine, getPersistedPathForMachine, params.pathParam, selectedMachine, selectedMachineId, selectedPath, selectedTargetInCurrentHome, unresolvedPlacementHistory]);

    const effectivePath = !selectedTargetInCurrentHome ? '' : fixedDirectoryIntent
        ? (fixedDirectoryIntent.kind === 'path' ? fixedDirectoryIntent.path : '')
        : directoryKind === 'managed' ? '' : selectedPath;
    const directoryIntent = React.useMemo<SessionDirectoryIntentV1 | null>(() => {
        if (!selectedTargetInCurrentHome) return null;
        if (fixedDirectoryIntent) return fixedDirectoryIntent;
        if (directoryKind === 'managed') return { kind: 'managed' };
        const path = selectedPath.trim();
        return path ? { kind: 'path', path } : null;
    }, [directoryKind, fixedDirectoryIntent, selectedPath, selectedTargetInCurrentHome]);
    const scopedDirectoryPreflight = useNewSessionDirectoryPreflight({ machineId: scopedSelectedMachineId, binding,
        // The accepted-input owner wakes first, then prepares/validates this exact directory.
        enabled: !managedWake && memberPlacement && !ownIsolation.launchPreparable && directoryIntent?.kind === 'path',
        requesterReady: ownIsolation.status?.protection === 'member_separated',
        path: directoryIntent?.kind === 'path' ? directoryIntent.path : '',
    });
    const directoryPreflight: NewSessionDirectoryPreflight = selectedTargetInCurrentHome
        ? scopedDirectoryPreflight : { ready: false, code: 'unavailable' };

    const hasAuthoredDirectory = hasUserEditedPathRef.current || Boolean(normalizePathParam(params.pathParam));
    const hasRetainedPlacement = hasCommittedExactTargetRef.current || hasExplicitPlacement;
    const placementForPersistence = React.useMemo<NewSessionPlacementForPersistence>(() => ({
        ...(hasExplicitPlacement ? { placementExplicit: true } : {}),
        executionTarget: hasRetainedPlacement ? authoredExecutionTarget : undefined,
        selectedMachineId: hasRetainedPlacement && authoredExecutionTarget?.kind === 'machine'
            ? authoredExecutionTarget.target.machineId : null,
        managedMachineSelection: hasRetainedPlacement ? managedMachineSelectionState : null,
        selectedPath: hasAuthoredDirectory ? selectedPath
            : hasRetainedPlacement && authoredExecutionTarget?.kind === 'machine'
                ? getPersistedPathForMachine(authoredExecutionTarget.target.machineId)
                : hasRetainedPlacement && managedMachineSelectionState ? normalizePathParam(params.persistedPath) : '',
    }), [authoredExecutionTarget, getPersistedPathForMachine, hasAuthoredDirectory, hasExplicitPlacement, hasRetainedPlacement,
        managedMachineSelectionState, params.persistedPath, selectedPath]);

    return {
        executionTarget,
        placementForPersistence,
        managedPlacementPreset,
        managedPlacementSource: managedPlacementPreset ? placementDecision.source : null,
        managedMachineSelection,
        managedMachineArchiveChoiceAvailability,
        setManagedMachineTarget,
        adoptManagedMachineTarget,
        setManagedMachineArchiveEffect,
        cancelManagedMachineTarget,
        selectedMachineId,
        selectedMachine,
        selectedMachineDisplay,
        selectedMachineSentenceName,
        machineHomeDir,
        ownIsolation,
        directoryPreflight,
        managedWake,
        agentCatalogMachineId,
        setSelectedMachineId,
        setSelectedMachineTarget,
        setTemporaryComputerTarget,
        selectedPath: effectivePath,
        rememberedPath: selectedTargetInCurrentHome ? selectedPath : '',
        directoryKind,
        directoryIntent,
        directoryIntentFixed: fixedDirectoryIntent !== null,
        setDirectoryIntent,
        setSelectedPath,
        setDraftSelectedPath,
        getRequestedPath,
        getBestPathForMachine,
    };
}
