import * as React from 'react';

import { machineResourcesGet } from '@/sync/ops/machineResources';
import { machineResourcesStore } from '@/sync/domains/machines/resources/machineResourcesStore';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { startRuntimeActiveGatedInterval } from '@/utils/runtime/isRuntimeActive';

export const MACHINE_RESOURCES_POLL_INTERVAL_MS = 30_000;

const inFlightMachineIds = new Set<string>();

function sampleMachineResources(machineId: string): void {
    if (inFlightMachineIds.has(machineId)) return;
    inFlightMachineIds.add(machineId);
    machineResourcesStore.markLoading(machineId);
    void machineResourcesGet(machineId)
        .then((result) => {
            if (result.ok) {
                machineResourcesStore.mergeSnapshot(machineId, result.snapshot);
            } else {
                machineResourcesStore.markError(machineId);
            }
        })
        .catch(() => {
            machineResourcesStore.markError(machineId);
        })
        .finally(() => {
            inFlightMachineIds.delete(machineId);
        });
}

/**
 * Pull-mode sampling for the machine-resource gauges: one fresh daemon snapshot per fetch, no
 * history. The interval runs through the canonical runtime-lifecycle gate (web
 * `visibilitychange` / native `AppState`), so polling pauses while the host is hidden or
 * backgrounded and catches up immediately when it becomes visible again and the sample is
 * overdue. Only online machines are sampled. Concurrent samples for the same machine are
 * deduped in-flight (shared across mounted strip instances); the returned `refresh` forces one
 * immediate extra sample (used when the detail popover opens).
 */
export function useMachineResourcesPolling(input: Readonly<{
    enabled: boolean;
    machines: readonly Machine[];
}>): (machineId: string) => void {
    const machinesRef = React.useRef(input.machines);
    machinesRef.current = input.machines;

    React.useEffect(() => {
        if (!input.enabled) return;

        const pollOnlineMachines = () => {
            for (const machine of machinesRef.current) {
                if (isMachineOnline(machine)) sampleMachineResources(machine.id);
            }
        };

        pollOnlineMachines();
        return startRuntimeActiveGatedInterval(pollOnlineMachines, MACHINE_RESOURCES_POLL_INTERVAL_MS);
    }, [input.enabled]);

    return sampleMachineResources;
}
