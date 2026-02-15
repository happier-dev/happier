import * as React from 'react';

import type { Machine } from '@/sync/domains/state/storageTypes';
import { getRecentPathsForMachine } from '@/utils/sessions/recentPaths';

type RecentMachinePathsList = Array<{ machineId: string; path: string }>;

function normalizeMachineIdParam(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim() : '';
}

function normalizePathParam(raw: unknown): string {
    return typeof raw === 'string' ? raw.trim() : '';
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
        if (params.machines.length > 0) {
            if (recentMachinePaths.length > 0) {
                for (const recent of recentMachinePaths) {
                    if (params.machines.find((m) => m.id === recent.machineId)) {
                        return recent.machineId;
                    }
                }
            }
            return params.machines[0]!.id;
        }
        return null;
    });

    const [selectedPath, setSelectedPath] = React.useState<string>(() => {
        return getBestPathForMachine(selectedMachineId);
    });

    // Handle machine route param from picker screens (main's navigation pattern)
    React.useEffect(() => {
        const machineId = normalizeMachineIdParam(params.machineIdParam);
        if (!machineId) return;
        if (!params.machines.some((m) => m.id === machineId)) return;
        if (machineId === selectedMachineId) return;
        setSelectedMachineId(machineId);
        setSelectedPath(getBestPathForMachine(machineId));
    }, [getBestPathForMachine, params.machineIdParam, params.machines, selectedMachineId]);

    // Ensure a machine is pre-selected once machines have loaded (wizard expects this).
    React.useEffect(() => {
        if (selectedMachineId !== null) return;
        if (params.machines.length === 0) return;

        let machineIdToUse: string | null = null;
        if (recentMachinePaths.length > 0) {
            for (const recent of recentMachinePaths) {
                if (params.machines.find((m) => m.id === recent.machineId)) {
                    machineIdToUse = recent.machineId;
                    break;
                }
            }
        }
        if (!machineIdToUse) {
            machineIdToUse = params.machines[0]!.id;
        }

        setSelectedMachineId(machineIdToUse);
        setSelectedPath(getBestPathForMachine(machineIdToUse));
    }, [getBestPathForMachine, params.machines, recentMachinePaths, selectedMachineId]);

    // Handle path route param from picker screens (main's navigation pattern)
    React.useEffect(() => {
        const trimmedPath = normalizePathParam(params.pathParam);
        if (trimmedPath && trimmedPath !== selectedPath) {
            setSelectedPath(trimmedPath);
        }
    }, [params.pathParam, selectedPath]);

    return {
        selectedMachineId,
        setSelectedMachineId,
        selectedPath,
        setSelectedPath,
        getBestPathForMachine,
    };
}
