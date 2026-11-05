import * as React from 'react';
import { readMachineActivity, subscribeMachineActivity } from '@/sync/domains/machines/machineActivity';
import { sessionListRuntimeClock } from '@/hooks/session/sessionListRuntimeClock';
import { readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';

/** Preserve callers' sampled instant, waking only for authoritative presence changes. */
export function useMachinePresenceNowMs(machines: readonly Parameters<typeof readMachineStatusNextRefreshAtMs>[0][]): number {
    const source = React.useMemo(() => {
        let previous: string | undefined;
        let sampledAtMs = Date.now();
        const getSnapshot = () => {
            const active = machines.map(machine => readMachineActivity(machine).active ? '1' : '0').join('');
            if (previous !== undefined && previous !== active) sampledAtMs = Math.max(Date.now(), sampledAtMs + 1);
            previous = active;
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
