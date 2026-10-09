import * as React from 'react';
import type {
    MachinePoolSelectionOriginV1,
    SessionAuthoringExecutionTargetV2,
    SessionDirectoryIntentV1,
} from '@happier-dev/protocol';

import { resolvePreferredLaunchMachineId } from '@/components/settings/pickers/resolvePreferredMachineId';
import { normalizeOptionalParam } from '@/profileRouteParams';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { resolveDefaultDirectoryForMachine } from '@/utils/sessions/machineDefaultDirectory';
import { useStableRecentPathsResolver } from '@/utils/sessions/useStableRecentPathsForMachine';
import type { ManagedMachineSelectionDraft } from '@/sync/domains/state/newSessionManagedMachineDraft';
import { resolveManagedMachineArchiveChoiceAvailability, type ManagedMachineArchiveChoiceAvailability } from '@/components/sessions/new/components/machineSelection/managedMachineSelection';

type RecentMachinePathsList = Array<{ machineId: string; path: string }>;

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
 * Where a New Session draft starts before any live reconciliation: a requested (route/seeded)
 * machine, else the draft's persisted target, else the Account's preferred launch machine; and
 * the requested folder, else the draft's folder on that machine, else the machine's default one.
 */
export function resolveNewSessionInitialPlacement(input: Readonly<{
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
        path = (machineId && persistedMachineId === machineId ? persistedPath : '')
            || resolveDefaultDirectoryForMachine({
                machineId,
                machines: input.machines,
                recentPaths: input.resolveRecentPathsForMachine(machineId),
            });
    }
    return { keepsPersistedTarget, machineId, path };
}

export function useNewSessionMachinePathState(params: Readonly<{
    serverId: string | null;
    persistedManagedMachineSelection?: ManagedMachineSelectionDraft | null;
    /** Reviewed intent from a fresh picker return, distinct from retained paid recovery. */
    requestedManagedMachineSelection?: ManagedMachineSelectionDraft | null;
    persistedExecutionTarget?: SessionAuthoringExecutionTargetV2 | null;
    /** Fresh one-shot handoff identity for an explicit rich picker target. */
    executionTargetRequestKey?: string | null;
    routeSelectionOrigin?: MachinePoolSelectionOriginV1;
    machines: ReadonlyArray<Machine>;
    recentMachinePaths: unknown;
    sessions?: ReadonlyArray<Session | string> | null | undefined;
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
    managedMachineSelection: ManagedMachineSelectionDraft | null;
    managedMachineArchiveChoiceAvailability: ManagedMachineArchiveChoiceAvailability | null;
    setManagedMachineTarget: (draft: ManagedMachineSelectionDraft, serverId?: string) => void;
    /** Enrollment changes execution placement, not the reviewed recipe or authored folder. */
    adoptManagedMachineTarget: (machineId: string) => void;
    setManagedMachineArchiveEffect: (effect: ManagedMachineSelectionDraft['archiveEffect']) => void;
    cancelManagedMachineTarget: () => void;
    selectedMachineId: string | null;
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
}> {
    const recentMachinePaths = React.useMemo((): RecentMachinePathsList => {
        return Array.isArray(params.recentMachinePaths) ? (params.recentMachinePaths as any[]).slice() as any : [];
    }, [params.recentMachinePaths]);
    const resolveRecentPathsForMachine = useStableRecentPathsResolver({
        recentMachinePaths,
        sessions: params.sessions,
        cacheScopeKey: params.cacheScopeKey,
    });

    const resolveMachineId = React.useCallback((preferredMachineId: string | null): string | null => (
        resolvePreferredLaunchMachineId({ machines: params.machines, preferredMachineId, recentMachinePaths })
    ), [params.machines, recentMachinePaths]);

    const getBestPathForMachine = React.useCallback((machineId: string | null): string => (
        resolveDefaultDirectoryForMachine({
            machineId,
            machines: params.machines,
            recentPaths: resolveRecentPathsForMachine(machineId),
        })
    ), [params.machines, resolveRecentPathsForMachine]);

    const getPersistedPathForMachine = React.useCallback((machineId: string | null): string => {
        if (!machineId) return '';
        const persistedMachineId = params.persistedExecutionTarget?.kind === 'machine'
            ? params.persistedExecutionTarget.target.machineId
            : normalizeMachineIdParam(params.persistedMachineId);
        if (!persistedMachineId || persistedMachineId !== machineId) {
            return '';
        }
        return normalizePathParam(params.persistedPath);
    }, [params.persistedExecutionTarget, params.persistedMachineId, params.persistedPath]);

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
        serverId: params.serverId,
        machines: params.machines,
        recentMachinePaths,
        resolveRecentPathsForMachine,
        machineIdParam: params.machineIdParam,
        pathParam: params.pathParam,
        persistedExecutionTarget: params.persistedExecutionTarget,
        persistedMachineId: params.persistedMachineId,
        persistedPath: params.persistedPath,
    }));
    const [executionTarget, setExecutionTarget] = React.useState<SessionAuthoringExecutionTargetV2 | null>(() => (
        (params.requestedManagedMachineSelection || params.persistedManagedMachineSelection) && !normalizeMachineIdParam(params.machineIdParam)
            ? null : initialPlacement.keepsPersistedTarget
            ? params.persistedExecutionTarget ?? null
            : machineTarget(initialPlacement.machineId)
    ));
    const [managedMachineSelectionState, setManagedMachineSelection] = React.useState<ManagedMachineSelectionDraft | null>(
        () => normalizeMachineIdParam(params.machineIdParam) ? null : params.requestedManagedMachineSelection ?? params.persistedManagedMachineSelection ?? null,
    );
    const resolveArchiveChoiceAvailability = React.useCallback((draft: ManagedMachineSelectionDraft) => (
        resolveManagedMachineArchiveChoiceAvailability({ draft,
            controller: params.machines.find(machine => machine.id === draft.receipt.controller.machineId) })
    ), [params.machines]);
    const managedMachineArchiveChoiceAvailability = React.useMemo(() => managedMachineSelectionState
        ? resolveArchiveChoiceAvailability(managedMachineSelectionState) : null,
    [managedMachineSelectionState, resolveArchiveChoiceAvailability]);
    // A foreign controller cannot host this Account's automatic rule. The paid
    // recipe stays usable and Keep leaves manual power/delete authority intact.
    const managedMachineSelection = React.useMemo(() => managedMachineSelectionState
        && managedMachineSelectionState.archiveEffect !== 'keep'
        && managedMachineArchiveChoiceAvailability?.reason === 'shared_unsupported'
        ? { ...managedMachineSelectionState, archiveEffect: 'keep' as const } : managedMachineSelectionState,
    [managedMachineSelectionState, managedMachineArchiveChoiceAvailability]);
    const managedSelectionServerRef = React.useRef(params.serverId);
    const selectedMachineId = executionTarget?.kind === 'machine' ? executionTarget.target.machineId : null;
    const agentCatalogMachineId = (managedMachineSelection !== null && selectedMachineId === null) || executionTarget?.kind === 'temporary_computer'
        ? resolveMachineId(resolvePersistedMachineId())
        : selectedMachineId;
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
    const hasUserSelectedMachineRef = React.useRef(Boolean(params.requestedManagedMachineSelection));
    const hasCommittedExactTargetRef = React.useRef(
        normalizeMachineIdParam(params.machineIdParam).length > 0
        || normalizeMachineIdParam(params.persistedMachineId).length > 0
        || params.persistedExecutionTarget != null
        || Boolean(params.requestedManagedMachineSelection),
    );
    const selectedMachineOnlineSeenByIdRef = React.useRef<Map<string, boolean>>(new Map());
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
        params.requestedManagedMachineSelection && !normalizeMachineIdParam(params.machineIdParam)
            ? normalizePathParam(params.pathParam) || normalizePathParam(params.persistedPath) || initialPlacement.path
            : initialPlacement.path
    ));
    const selectedPathDraftRef = React.useRef<string>(selectedPath);
    const hasUserEditedPathRef = React.useRef(false);
    const lastAppliedMachineParamRef = React.useRef<Readonly<{ machineId: string; scopeKey: string | null }> | null>(null);
    const lastAppliedPathParamRef = React.useRef<string>('');
    const applyCommittedSelectedPath = React.useCallback((nextPath: string) => {
        selectedPathDraftRef.current = nextPath;
        setSelectedPathState(nextPath);
    }, []);

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
            applyCommittedSelectedPath(
                getPersistedPathForMachine(target.machineId) || getBestPathForMachine(target.machineId),
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
        setExecutionTarget(machineTarget(machineId));
    }, [machineTarget]);
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
        // Choosing a folder is choosing to have one.
        setDirectoryKindState('path');
        hasCommittedExactTargetRef.current = executionTargetRef.current !== null;
        setSelectedPathState((current) => {
            const resolved = typeof next === 'function' ? next(current) : next;
            selectedPathDraftRef.current = resolved;
            return resolved;
        });
    }, []);

    const setDraftSelectedPath = React.useCallback((path: string) => {
        hasUserEditedPathRef.current = true;
        hasCommittedExactTargetRef.current = executionTargetRef.current !== null;
        selectedPathDraftRef.current = path;
    }, []);

    const getRequestedPath = React.useCallback(() => {
        return directoryKindRef.current === 'managed' ? '' : selectedPathDraftRef.current;
    }, []);

    const setDirectoryIntent = React.useCallback((intent: SessionDirectoryIntentV1) => {
        if (fixedDirectoryIntent) return;
        if (intent.kind === 'managed') {
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
        return params.machines.some((machine) => machine.id === machineId);
    }, [params.machines]);

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
            if (!hasUserEditedPathRef.current) applyCommittedSelectedPath(normalizePathParam(params.persistedPath));
            return;
        }

        if (params.persistedExecutionTarget?.kind === 'temporary_computer') {
            hasCommittedExactTargetRef.current = true;
            setExecutionTarget(params.persistedExecutionTarget);
            if (!hasUserEditedPathRef.current) {
                applyCommittedSelectedPath(normalizePathParam(params.persistedPath));
            }
            return;
        }

        const reconciledPersistedMachineId = resolvePersistedMachineId();
        if (!reconciledPersistedMachineId) {
            lastAppliedPersistedMachineIdRef.current = '';
            return;
        }
        if (reconciledPersistedMachineId === lastAppliedPersistedMachineIdRef.current) {
            return;
        }

        lastAppliedPersistedMachineIdRef.current = reconciledPersistedMachineId;
        hasCommittedExactTargetRef.current = true;
        if (reconciledPersistedMachineId === selectedMachineIdRef.current) {
            return;
        }

        setSelectedMachineIdState(reconciledPersistedMachineId);
        hasUserEditedPathRef.current = false;
        applyCommittedSelectedPath(
            getPersistedPathForMachine(reconciledPersistedMachineId) || getBestPathForMachine(reconciledPersistedMachineId),
        );
    }, [
        applyCommittedSelectedPath,
        getBestPathForMachine,
        getPersistedPathForMachine,
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
        if (hasUserSelectedMachineRef.current) return;
        if (params.machines.length === 0) return;
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
    }, [applyCommittedSelectedPath, executionTarget, managedMachineSelection, getBestPathForMachine, getPersistedPathForMachine, params.machines, params.pathParam, params.persistedExecutionTarget, resolveMachineId, setSelectedMachineIdState]);

    // Keep selection valid when machine snapshots change (server/account switch, revoke, reconnect).
    React.useEffect(() => {
        if (selectedMachineId === null) return;
        if (hasMachine(selectedMachineId)) return;
        if (hasCommittedExactTargetRef.current) return;

        const machineIdToUse = resolveMachineId(null);
        if (machineIdToUse === selectedMachineId) return;

        hasUserSelectedMachineRef.current = false;
        hasCommittedExactTargetRef.current = false;
        setSelectedMachineIdState(machineIdToUse);
        hasUserEditedPathRef.current = false;
        applyCommittedSelectedPath(getPersistedPathForMachine(machineIdToUse) || getBestPathForMachine(machineIdToUse));
    }, [applyCommittedSelectedPath, getBestPathForMachine, getPersistedPathForMachine, hasMachine, resolveMachineId, selectedMachineId]);

    React.useEffect(() => {
        if (!selectedMachineId) return;
        const machine = params.machines.find((m) => m.id === selectedMachineId);
        if (!machine) return;
        if (!isMachineOnline(machine)) return;
        selectedMachineOnlineSeenByIdRef.current.set(selectedMachineId, true);
    }, [params.machines, selectedMachineId]);

    // If we implicitly selected an offline machine, upgrade to the best available online machine
    // once machine snapshots hydrate. Keep explicit user/route choices stable.
    React.useEffect(() => {
        if (selectedMachineId === null) return;
        if (hasCommittedExactTargetRef.current) return;
        if (hasUserSelectedMachineRef.current) return;
        if (normalizeMachineIdParam(params.machineIdParam)) return;
        if (selectedMachineOnlineSeenByIdRef.current.get(selectedMachineId) === true) return;

        const machineIdToUse = resolveMachineId(selectedMachineId);
        if (!machineIdToUse || machineIdToUse === selectedMachineId) return;

        hasUserSelectedMachineRef.current = false;
        hasCommittedExactTargetRef.current = false;
        setSelectedMachineIdState(machineIdToUse);

        if (hasUserEditedPathRef.current) return;
        const trimmedPath = normalizePathParam(params.pathParam);
        hasUserEditedPathRef.current = false;
        applyCommittedSelectedPath(trimmedPath || getPersistedPathForMachine(machineIdToUse) || getBestPathForMachine(machineIdToUse));
    }, [applyCommittedSelectedPath, getBestPathForMachine, getPersistedPathForMachine, params.machineIdParam, params.pathParam, resolveMachineId, selectedMachineId]);

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
    }, [applyCommittedSelectedPath, fixedDirectoryIntent, getBestPathForMachine, getPersistedPathForMachine, params.pathParam, selectedMachineId, selectedPath]);

    const effectivePath = fixedDirectoryIntent
        ? (fixedDirectoryIntent.kind === 'path' ? fixedDirectoryIntent.path : '')
        : directoryKind === 'managed' ? '' : selectedPath;
    const directoryIntent = React.useMemo<SessionDirectoryIntentV1 | null>(() => {
        if (fixedDirectoryIntent) return fixedDirectoryIntent;
        if (directoryKind === 'managed') return { kind: 'managed' };
        const path = selectedPath.trim();
        return path ? { kind: 'path', path } : null;
    }, [directoryKind, fixedDirectoryIntent, selectedPath]);

    return {
        executionTarget,
        managedMachineSelection,
        managedMachineArchiveChoiceAvailability,
        setManagedMachineTarget,
        adoptManagedMachineTarget,
        setManagedMachineArchiveEffect,
        cancelManagedMachineTarget,
        selectedMachineId,
        agentCatalogMachineId,
        setSelectedMachineId,
        setSelectedMachineTarget,
        setTemporaryComputerTarget,
        selectedPath: effectivePath,
        rememberedPath: selectedPath,
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
