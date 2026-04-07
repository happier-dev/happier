import * as React from 'react';

import {
    buildMachineDoctorSnapshotTargetKey,
    type MachineDoctorSnapshotTarget,
    type MachineDoctorSnapshotState,
    useMachineDoctorSnapshot,
} from './useMachineDoctorSnapshot';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

export {
    buildMachineDoctorSnapshotTargetKey,
    type MachineDoctorSnapshotTarget,
} from './useMachineDoctorSnapshot';

export type UseMachineDoctorSnapshotCollectionInput = Readonly<{
    machineDoctorTargetsByKey?: ReadonlyMap<string, MachineDoctorSnapshotTarget>;
    prefetchMachineTargetKeys?: readonly string[];
    machineDoctorSnapshotTargets?: readonly MachineDoctorSnapshotTarget[];
    prefetchMachineDoctorSnapshotTargets?: readonly MachineDoctorSnapshotTarget[];
    machineRefs?: readonly MachineDoctorSnapshotTarget[];
    prefetchMachineRefs?: readonly MachineDoctorSnapshotTarget[];
    enabled?: boolean;
    timeoutMs?: number;
}>;

export type MachineDoctorSnapshotCollection = Readonly<{
    machineDoctorSnapshotByTargetKey: Record<string, MachineDoctorSnapshotState>;
    machineDoctorSnapshotByCollectionKey: Record<string, MachineDoctorSnapshotState>;
    getMachineDoctorSnapshotState: (target: MachineDoctorSnapshotTarget) => MachineDoctorSnapshotState | undefined;
    readMachineDoctorSnapshotState: (target: MachineDoctorSnapshotTarget) => MachineDoctorSnapshotState | null;
    seedCachedMachineDoctorSnapshots: () => void;
    fetchMachineDoctorSnapshotForTarget: (target: MachineDoctorSnapshotTarget) => Promise<void>;
    fetchMachineDoctorSnapshots: (targets: readonly MachineDoctorSnapshotTarget[]) => Promise<void>;
}>;

function mergeSeededMachineDoctorSnapshots(
    previous: Readonly<Record<string, MachineDoctorSnapshotState>>,
    seeded: Readonly<Record<string, MachineDoctorSnapshotState>>,
): Record<string, MachineDoctorSnapshotState> {
    let nextState: Record<string, MachineDoctorSnapshotState> | null = null;

    for (const [targetKey, seededState] of Object.entries(seeded)) {
        if (seededState.status !== 'ready') {
            continue;
        }
        const previousState = previous[targetKey];
        let shouldReplace = false;
        if (!previousState || previousState.status !== 'ready') {
            shouldReplace = true;
        } else if (previousState.cachedAt < seededState.cachedAt) {
            shouldReplace = true;
        }
        if (!shouldReplace) {
            continue;
        }
        if (!nextState) {
            nextState = { ...previous };
        }
        nextState[targetKey] = seededState;
    }

    return nextState ?? { ...previous };
}

export function useMachineDoctorSnapshotCollection(input: UseMachineDoctorSnapshotCollectionInput): MachineDoctorSnapshotCollection {
    const {
        machineDoctorTargetsByKey,
        prefetchMachineTargetKeys,
        machineDoctorSnapshotTargets,
        prefetchMachineDoctorSnapshotTargets,
        machineRefs,
        prefetchMachineRefs,
        enabled = true,
        timeoutMs = 4_000,
    } = input;
    const resolvedMachineRefs = React.useMemo(() => {
        if (machineDoctorTargetsByKey) {
            return Array.from(machineDoctorTargetsByKey.entries()).map(([targetKey, target]) => ({
                ...target,
                key: targetKey,
            }));
        }
        return (machineDoctorSnapshotTargets ?? machineRefs ?? []).map((target) => ({
            ...target,
            key: buildMachineDoctorSnapshotTargetKey(target),
        }));
    }, [machineDoctorSnapshotTargets, machineDoctorTargetsByKey, machineRefs]);
    const resolvedPrefetchMachineRefs = React.useMemo(() => {
        if (machineDoctorTargetsByKey && prefetchMachineTargetKeys) {
            return prefetchMachineTargetKeys
                .map((targetKey) => {
                    const target = machineDoctorTargetsByKey.get(targetKey);
                    return target ? { ...target, key: targetKey } : null;
                })
                .filter((target): target is MachineDoctorSnapshotTarget & { key: string } => Boolean(target));
        }
        return (prefetchMachineDoctorSnapshotTargets ?? prefetchMachineRefs ?? []).map((target) => ({
            ...target,
            key: buildMachineDoctorSnapshotTargetKey(target),
        }));
    }, [machineDoctorTargetsByKey, prefetchMachineDoctorSnapshotTargets, prefetchMachineRefs, prefetchMachineTargetKeys]);

    const {
        seedMachineDoctorSnapshotState,
        fetchMachineDoctorSnapshot,
    } = useMachineDoctorSnapshot();

    const [machineDoctorSnapshotByTargetKey, setMachineDoctorSnapshotByTargetKey] = React.useState<Record<string, MachineDoctorSnapshotState>>(() => ({}));
    const normalizedMachineRefs = React.useMemo(
        () => resolvedMachineRefs.map((target) => ({
            machineId: target.machineId,
            serverId: target.serverId,
            key: target.key ?? buildMachineDoctorSnapshotTargetKey(target),
        })),
        [resolvedMachineRefs],
    );
    const normalizedPrefetchMachineRefs = React.useMemo(
        () => resolvedPrefetchMachineRefs.map((target) => ({
            machineId: target.machineId,
            serverId: target.serverId,
            key: target.key ?? buildMachineDoctorSnapshotTargetKey(target),
        })),
        [resolvedPrefetchMachineRefs],
    );
    const machineTargetsRef = React.useRef(normalizedMachineRefs);
    machineTargetsRef.current = normalizedMachineRefs;

    const machineDoctorTargetsByKeyValue = React.useMemo(() => stableJsonStringify(
        normalizedMachineRefs
            .map((target) => [target.key, target.serverId, target.machineId])
            .sort(([left], [right]) => String(left).localeCompare(String(right))),
    ), [normalizedMachineRefs]);
    const prefetchMachineTargetKeysValue = React.useMemo(() => stableJsonStringify(
        normalizedPrefetchMachineRefs
            .map((target) => [target.key, target.serverId, target.machineId])
            .sort(([left], [right]) => String(left).localeCompare(String(right))),
    ), [normalizedPrefetchMachineRefs]);

    const seedCachedMachineDoctorSnapshots = React.useCallback(() => {
        const next = seedMachineDoctorSnapshotState(machineTargetsRef.current);
        setMachineDoctorSnapshotByTargetKey((prev) => mergeSeededMachineDoctorSnapshots(prev, next));
    }, [machineDoctorTargetsByKeyValue, seedMachineDoctorSnapshotState]);

    React.useEffect(() => {
        seedCachedMachineDoctorSnapshots();
    }, [seedCachedMachineDoctorSnapshots]);

    const getMachineDoctorSnapshotState = React.useCallback((target: MachineDoctorSnapshotTarget) => (
        machineDoctorSnapshotByTargetKey[buildMachineDoctorSnapshotTargetKey(target)]
    ), [machineDoctorSnapshotByTargetKey]);
    const readMachineDoctorSnapshotState = React.useCallback((target: MachineDoctorSnapshotTarget) => (
        machineDoctorSnapshotByTargetKey[buildMachineDoctorSnapshotTargetKey(target)] ?? null
    ), [machineDoctorSnapshotByTargetKey]);

    const fetchMachineDoctorSnapshotForTarget = React.useCallback(async (target: MachineDoctorSnapshotTarget) => {
        const targetKey = buildMachineDoctorSnapshotTargetKey(target);

        setMachineDoctorSnapshotByTargetKey((prev) => {
            const previousState = prev[targetKey];
            if (previousState?.status === 'ready') {
                return prev;
            }

            return {
                ...prev,
                [targetKey]: { status: 'loading' },
            };
        });

        const nextStatus = await fetchMachineDoctorSnapshot({
            machineId: target.machineId,
            serverId: target.serverId,
            timeoutMs,
        });

        setMachineDoctorSnapshotByTargetKey((prev) => ({
            ...prev,
            [targetKey]: nextStatus,
        }));
    }, [fetchMachineDoctorSnapshot, timeoutMs]);

    const fetchMachineDoctorSnapshots = React.useCallback(async (targets: readonly MachineDoctorSnapshotTarget[]) => {
        for (const target of targets) {
            await fetchMachineDoctorSnapshotForTarget(target);
        }
    }, [fetchMachineDoctorSnapshotForTarget]);

    React.useEffect(() => {
        if (!enabled || normalizedPrefetchMachineRefs.length === 0) return;
        void fetchMachineDoctorSnapshots(normalizedPrefetchMachineRefs);
    }, [enabled, fetchMachineDoctorSnapshots, machineDoctorTargetsByKeyValue, prefetchMachineTargetKeysValue]);

    return {
        machineDoctorSnapshotByTargetKey,
        machineDoctorSnapshotByCollectionKey: machineDoctorSnapshotByTargetKey,
        getMachineDoctorSnapshotState,
        readMachineDoctorSnapshotState,
        seedCachedMachineDoctorSnapshots,
        fetchMachineDoctorSnapshotForTarget,
        fetchMachineDoctorSnapshots,
    };
}
