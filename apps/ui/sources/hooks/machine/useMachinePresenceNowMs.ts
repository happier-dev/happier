import * as React from 'react';
import { subscribeMachineActivity } from '@/sync/domains/machines/machineActivity';
import { resolveMachinePresence } from '@/sync/domains/machines/reachability/machinePresence';
import { sessionListRuntimeClock } from '@/hooks/session/sessionListRuntimeClock';
import { readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';

/** Preserve callers' sampled instant, waking only for authoritative presence changes. */
export function useMachinePresenceNowMs(machines: readonly Parameters<typeof readMachineStatusNextRefreshAtMs>[0][]): number {
    const source = React.useMemo(() => {
        let previous: string | undefined;
        let sampledAtMs = Date.now();
        const getSnapshot = () => {
            const nowMs = Date.now();
            const presence = machines.map(machine => resolveMachinePresence(machine, nowMs)).join(',');
            if (previous !== undefined && previous !== presence) sampledAtMs = Math.max(nowMs, sampledAtMs + 1);
            previous = presence;
            return sampledAtMs;
        };
        return { getSnapshot, subscribe: (listener: () => void) => {
            const token = {};
            const reconcileDeadline = () => {
                let next: number | null = null;
                for (const machine of machines) {
                    const deadline = readMachineStatusNextRefreshAtMs(machine, Date.now());
                    if (deadline !== null) next = next === null ? deadline : Math.min(next, deadline);
                }
                if (next === null) sessionListRuntimeClock.clearWake(token);
                else sessionListRuntimeClock.requestWake(token, next);
            };
            const stops = machines.map(machine => subscribeMachineActivity(machine, () => { reconcileDeadline(); listener(); }));
            const stopClock = sessionListRuntimeClock.subscribeWake(token, () => {
                sampledAtMs = Date.now();
                reconcileDeadline();
                listener();
            });
            reconcileDeadline();
            return () => { for (const stop of stops) stop(); stopClock(); };
        } };
    }, [machines]);
    return React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}
