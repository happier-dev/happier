import * as React from 'react';

import { resolvePreferredMachineId } from '@/components/settings/pickers/resolvePreferredMachineId';
import { normalizeOptionalParam } from '@/profileRouteParams';
import type { Machine, Session } from '@/sync/domains/state/storageTypes';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { getRecentPathsForMachine } from '@/utils/sessions/recentPaths';

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

export function useNewSessionMachinePathState(params: Readonly<{
    machines: ReadonlyArray<Machine>;
    recentMachinePaths: unknown;
    sessions?: ReadonlyArray<Session | string> | null | undefined;
    machineIdParam: unknown;
    pathParam: unknown;
    persistedMachineId?: unknown;
    persistedPath?: unknown;
}>): Readonly<{
    selectedMachineId: string | null;
    setSelectedMachineId: React.Dispatch<React.SetStateAction<string | null>>;
    selectedPath: string;
    setSelectedPath: React.Dispatch<React.SetStateAction<string>>;
    setDraftSelectedPath: (path: string) => void;
    getRequestedPath: () => string;
    getBestPathForMachine: (machineId: string | null) => string;
}> {
    const recentMachinePaths = React.useMemo((): RecentMachinePathsList => {
        return Array.isArray(params.recentMachinePaths) ? (params.recentMachinePaths as any[]).slice() as any : [];
    }, [params.recentMachinePaths]);

    const resolveMachineId = React.useCallback((preferredMachineId: string | null): string | null => {
        const preferredOnlineMachineId = resolvePreferredMachineId({
            machines: params.machines,
            preferredMachineId,
            recentMachinePaths,
            onlineOnly: true,
        });
        if (preferredOnlineMachineId) return preferredOnlineMachineId;
        return resolvePreferredMachineId({
            machines: params.machines,
            preferredMachineId,
            recentMachinePaths,
        });
    }, [params.machines, recentMachinePaths]);

    const getBestPathForMachine = React.useCallback((machineId: string | null): string => {
        if (!machineId) return '';
        const recent = getRecentPathsForMachine({
            machineId,
            recentMachinePaths,
            sessions: params.sessions,
        });
        if (recent.length > 0) return recent[0]!;
        const machine = params.machines.find((m) => m.id === machineId);
        return machine?.metadata?.homeDir ?? '';
    }, [params.machines, params.sessions, recentMachinePaths]);

    const getPersistedPathForMachine = React.useCallback((machineId: string | null): string => {
        if (!machineId) return '';
        const persistedMachineId = normalizeMachineIdParam(params.persistedMachineId);
        if (!persistedMachineId || persistedMachineId !== machineId) {
            return '';
        }
        return normalizePathParam(params.persistedPath);
    }, [params.persistedMachineId, params.persistedPath]);

    const resolvePersistedMachineId = React.useCallback((): string | null => {
        const persistedMachineId = normalizeMachineIdParam(params.persistedMachineId);
        if (!persistedMachineId) return null;
        return resolveMachineId(persistedMachineId);
    }, [params.persistedMachineId, resolveMachineId]);

    const [selectedMachineId, setSelectedMachineIdState] = React.useState<string | null>(() => {
        return resolvePersistedMachineId() ?? resolveMachineId(null);
    });
    const hasUserSelectedMachineRef = React.useRef(false);
    const selectedMachineOnlineSeenByIdRef = React.useRef<Map<string, boolean>>(new Map());
    const lastAppliedPersistedMachineIdRef = React.useRef<string>('');

    const setSelectedMachineId = React.useCallback<React.Dispatch<React.SetStateAction<string | null>>>((next) => {
        hasUserSelectedMachineRef.current = true;
        setSelectedMachineIdState((current) => typeof next === 'function' ? next(current) : next);
    }, []);

    const [selectedPath, setSelectedPathState] = React.useState<string>(() => {
        const trimmedPath = normalizePathParam(params.pathParam);
        if (trimmedPath) return trimmedPath;
        const persistedPath = getPersistedPathForMachine(selectedMachineId);
        if (persistedPath) return persistedPath;
        return getBestPathForMachine(selectedMachineId);
    });
    const selectedPathDraftRef = React.useRef<string>(selectedPath);
    const hasUserEditedPathRef = React.useRef(false);
    const lastAppliedMachineParamRef = React.useRef<string>('');
    const lastAppliedPathParamRef = React.useRef<string>('');
    const applyCommittedSelectedPath = React.useCallback((nextPath: string) => {
        selectedPathDraftRef.current = nextPath;
        setSelectedPathState(nextPath);
    }, []);

    const setSelectedPath = React.useCallback<React.Dispatch<React.SetStateAction<string>>>((next) => {
        hasUserEditedPathRef.current = true;
        setSelectedPathState((current) => {
            const resolved = typeof next === 'function' ? next(current) : next;
            selectedPathDraftRef.current = resolved;
            return resolved;
        });
    }, []);
    const setDraftSelectedPath = React.useCallback((path: string) => {
        hasUserEditedPathRef.current = true;
        selectedPathDraftRef.current = path;
    }, []);
    const getRequestedPath = React.useCallback(() => {
        return selectedPathDraftRef.current;
    }, []);

    const hasMachine = React.useCallback((machineId: string | null): boolean => {
        if (!machineId) return false;
        return params.machines.some((machine) => machine.id === machineId);
    }, [params.machines]);

    // Handle machine route param from picker screens (main's navigation pattern)
    React.useEffect(() => {
        const machineId = normalizeMachineIdParam(params.machineIdParam);
        if (!machineId) {
            lastAppliedMachineParamRef.current = '';
            return;
        }
        // Only mark the param "applied" once we've actually applied it. This prevents the initial
        // render from consuming the param before machine snapshots hydrate.
        if (machineId === lastAppliedMachineParamRef.current) {
            return;
        }
        if (!hasMachine(machineId)) {
            return;
        }

        lastAppliedMachineParamRef.current = machineId;
        if (machineId === selectedMachineId) return;
        hasUserSelectedMachineRef.current = true;
        setSelectedMachineIdState(machineId);
        hasUserEditedPathRef.current = false;
        const trimmedPath = normalizePathParam(params.pathParam);
        applyCommittedSelectedPath(trimmedPath || getPersistedPathForMachine(machineId) || getBestPathForMachine(machineId));
    }, [applyCommittedSelectedPath, getBestPathForMachine, getPersistedPathForMachine, hasMachine, params.machineIdParam, params.pathParam, selectedMachineId]);

    React.useEffect(() => {
        const routeMachineId = normalizeMachineIdParam(params.machineIdParam);
        if (routeMachineId) {
            lastAppliedPersistedMachineIdRef.current = '';
            return;
        }
        if (hasUserSelectedMachineRef.current) {
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
        if (reconciledPersistedMachineId === selectedMachineId) {
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
        resolvePersistedMachineId,
        selectedMachineId,
    ]);

    // Ensure a machine is pre-selected once machines have loaded (wizard expects this).
    React.useEffect(() => {
        if (selectedMachineId !== null) return;
        if (params.machines.length === 0) return;
        const machineIdToUse = resolveMachineId(null);
        const trimmedPath = normalizePathParam(params.pathParam);

        hasUserSelectedMachineRef.current = false;
        setSelectedMachineIdState(machineIdToUse);
        hasUserEditedPathRef.current = false;
        applyCommittedSelectedPath(trimmedPath || getPersistedPathForMachine(machineIdToUse) || getBestPathForMachine(machineIdToUse));
    }, [applyCommittedSelectedPath, getBestPathForMachine, getPersistedPathForMachine, params.machines, params.pathParam, resolveMachineId, selectedMachineId]);

    // Keep selection valid when machine snapshots change (server/account switch, revoke, reconnect).
    React.useEffect(() => {
        if (selectedMachineId === null) return;
        if (hasMachine(selectedMachineId)) return;

        const machineIdToUse = resolveMachineId(null);
        if (machineIdToUse === selectedMachineId) return;

        hasUserSelectedMachineRef.current = false;
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
        if (hasUserSelectedMachineRef.current) return;
        if (normalizeMachineIdParam(params.machineIdParam)) return;
        if (selectedMachineOnlineSeenByIdRef.current.get(selectedMachineId) === true) return;

        const machineIdToUse = resolveMachineId(selectedMachineId);
        if (!machineIdToUse || machineIdToUse === selectedMachineId) return;

        hasUserSelectedMachineRef.current = false;
        setSelectedMachineIdState(machineIdToUse);

        if (hasUserEditedPathRef.current) return;
        const trimmedPath = normalizePathParam(params.pathParam);
        hasUserEditedPathRef.current = false;
        applyCommittedSelectedPath(trimmedPath || getPersistedPathForMachine(machineIdToUse) || getBestPathForMachine(machineIdToUse));
    }, [applyCommittedSelectedPath, getBestPathForMachine, getPersistedPathForMachine, params.machineIdParam, params.pathParam, resolveMachineId, selectedMachineId]);

    // Handle path route param from picker screens (main's navigation pattern)
    React.useEffect(() => {
        const trimmedPath = normalizePathParam(params.pathParam);
        const routeMachineId = normalizeMachineIdParam(params.machineIdParam);

        if (routeMachineId && !hasMachine(routeMachineId)) {
            return;
        }

        if (trimmedPath === lastAppliedPathParamRef.current) {
            return;
        }

        lastAppliedPathParamRef.current = trimmedPath;
        if (trimmedPath && trimmedPath !== selectedPath) {
            hasUserEditedPathRef.current = false;
            applyCommittedSelectedPath(trimmedPath);
        }
    }, [applyCommittedSelectedPath, hasMachine, params.machineIdParam, params.pathParam, selectedPath]);

    React.useEffect(() => {
        if (!selectedMachineId) {
            return;
        }
        if (normalizePathParam(params.pathParam)) {
            return;
        }
        if (hasUserEditedPathRef.current) {
            return;
        }

        const persistedPath = getPersistedPathForMachine(selectedMachineId);
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
    }, [applyCommittedSelectedPath, getBestPathForMachine, getPersistedPathForMachine, params.pathParam, selectedMachineId, selectedPath]);

    return {
        selectedMachineId,
        setSelectedMachineId,
        selectedPath,
        setSelectedPath,
        setDraftSelectedPath,
        getRequestedPath,
        getBestPathForMachine,
    };
}
