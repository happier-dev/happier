import * as React from 'react';

import { resolvePreferredMachineId } from '@/components/settings/pickers/resolvePreferredMachineId';
import { normalizeOptionalParam } from '@/profileRouteParams';
import type { Machine } from '@/sync/domains/state/storageTypes';
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

    const [selectedMachineId, setSelectedMachineId] = React.useState<string | null>(() => {
        return resolveMachineId(null);
    });

    const [selectedPath, setSelectedPathState] = React.useState<string>(() => {
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
        // render from consuming the param before machine snapshots hydrate (critical for QA/e2e).
        if (machineId === lastAppliedMachineParamRef.current) {
            return;
        }
        if (!hasMachine(machineId)) {
            return;
        }

        lastAppliedMachineParamRef.current = machineId;
        if (machineId === selectedMachineId) return;
        setSelectedMachineId(machineId);
        hasUserEditedPathRef.current = false;
        setSelectedPathState(getBestPathForMachine(machineId));
    }, [getBestPathForMachine, hasMachine, params.machineIdParam, selectedMachineId]);

    // Ensure a machine is pre-selected once machines have loaded (wizard expects this).
    React.useEffect(() => {
        if (selectedMachineId !== null) return;
        if (params.machines.length === 0) return;
        const machineIdToUse = resolveMachineId(null);

        setSelectedMachineId(machineIdToUse);
        hasUserEditedPathRef.current = false;
        setSelectedPathState(getBestPathForMachine(machineIdToUse));
    }, [getBestPathForMachine, params.machines, resolveMachineId, selectedMachineId]);

    // Keep selection valid when machine snapshots change (server/account switch, revoke, reconnect).
    React.useEffect(() => {
        if (selectedMachineId === null) return;
        if (hasMachine(selectedMachineId)) return;

        const machineIdToUse = resolveMachineId(null);
        if (machineIdToUse === selectedMachineId) return;

        setSelectedMachineId(machineIdToUse);
        hasUserEditedPathRef.current = false;
        setSelectedPathState(getBestPathForMachine(machineIdToUse));
    }, [getBestPathForMachine, hasMachine, resolveMachineId, selectedMachineId]);

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
