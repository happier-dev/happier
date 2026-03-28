import * as React from 'react';

import { resolvePreferredMachineId } from '@/components/settings/pickers/resolvePreferredMachineId';
import { normalizeOptionalParam } from '@/profileRouteParams';
import type { Machine } from '@/sync/domains/state/storageTypes';
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
    machineIdParam: unknown;
    pathParam: unknown;
}>): Readonly<{
    selectedMachineId: string | null;
    setSelectedMachineId: React.Dispatch<React.SetStateAction<string | null>>;
    selectedPath: string;
    setSelectedPath: React.Dispatch<React.SetStateAction<string>>;
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
            sessions: null,
        });
        if (recent.length > 0) return recent[0]!;
        const machine = params.machines.find((m) => m.id === machineId);
        return machine?.metadata?.homeDir ?? '';
    }, [params.machines, recentMachinePaths]);

    const [selectedMachineId, setSelectedMachineIdState] = React.useState<string | null>(() => {
        return resolveMachineId(null);
    });
    const hasUserSelectedMachineRef = React.useRef(false);
    const selectedMachineOnlineSeenByIdRef = React.useRef<Map<string, boolean>>(new Map());

    const setSelectedMachineId = React.useCallback<React.Dispatch<React.SetStateAction<string | null>>>((next) => {
        hasUserSelectedMachineRef.current = true;
        setSelectedMachineIdState((current) => typeof next === 'function' ? next(current) : next);
    }, []);

    const [selectedPath, setSelectedPathState] = React.useState<string>(() => {
        const trimmedPath = normalizePathParam(params.pathParam);
        if (trimmedPath) return trimmedPath;
        return getBestPathForMachine(selectedMachineId);
    });
    const hasUserEditedPathRef = React.useRef(false);
    const lastAppliedMachineParamRef = React.useRef<string>('');
    const lastAppliedPathParamRef = React.useRef<string>('');

    const setSelectedPath = React.useCallback<React.Dispatch<React.SetStateAction<string>>>((next) => {
        hasUserEditedPathRef.current = true;
        setSelectedPathState((current) => typeof next === 'function' ? next(current) : next);
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
        setSelectedPathState(trimmedPath || getBestPathForMachine(machineId));
    }, [getBestPathForMachine, hasMachine, params.machineIdParam, params.pathParam, selectedMachineId]);

    // Ensure a machine is pre-selected once machines have loaded (wizard expects this).
    React.useEffect(() => {
        if (selectedMachineId !== null) return;
        if (params.machines.length === 0) return;
        const machineIdToUse = resolveMachineId(null);
        const trimmedPath = normalizePathParam(params.pathParam);

        hasUserSelectedMachineRef.current = false;
        setSelectedMachineIdState(machineIdToUse);
        hasUserEditedPathRef.current = false;
        setSelectedPathState(trimmedPath || getBestPathForMachine(machineIdToUse));
    }, [getBestPathForMachine, params.machines, params.pathParam, resolveMachineId, selectedMachineId]);

    // Keep selection valid when machine snapshots change (server/account switch, revoke, reconnect).
    React.useEffect(() => {
        if (selectedMachineId === null) return;
        if (hasMachine(selectedMachineId)) return;

        const machineIdToUse = resolveMachineId(null);
        if (machineIdToUse === selectedMachineId) return;

        hasUserSelectedMachineRef.current = false;
        setSelectedMachineIdState(machineIdToUse);
        hasUserEditedPathRef.current = false;
        setSelectedPathState(getBestPathForMachine(machineIdToUse));
    }, [getBestPathForMachine, hasMachine, resolveMachineId, selectedMachineId]);

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
        setSelectedPathState(trimmedPath || getBestPathForMachine(machineIdToUse));
    }, [getBestPathForMachine, params.machineIdParam, params.pathParam, resolveMachineId, selectedMachineId]);

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
            setSelectedPathState(trimmedPath);
        }
    }, [hasMachine, params.machineIdParam, params.pathParam, selectedPath]);

    React.useEffect(() => {
        if (!selectedMachineId) {
            return;
        }
        if (selectedPath.trim().length > 0) {
            return;
        }
        if (hasUserEditedPathRef.current) {
            return;
        }

        const bestPath = getBestPathForMachine(selectedMachineId);
        if (!bestPath) {
            return;
        }

        setSelectedPathState(bestPath);
    }, [getBestPathForMachine, selectedMachineId, selectedPath]);

    return {
        selectedMachineId,
        setSelectedMachineId,
        selectedPath,
        setSelectedPath,
        getBestPathForMachine,
    };
}
