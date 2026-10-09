import { useSessionListRuntimeNowMs, useSessionListRuntimeWake } from '@/hooks/session/sessionListRuntimeClock';
import { readMachineStatusNextRefreshAtMs } from '@/utils/sessions/machineUtils';

/** Presence surfaces request their grace expiry from the existing shared runtime clock. */
export function useMachinePresenceNowMs(machines: readonly Parameters<typeof readMachineStatusNextRefreshAtMs>[0][]): number {
    const clockNowMs = useSessionListRuntimeNowMs(machines.length > 0);
    const nowMs = Math.max(clockNowMs, Date.now());
    let next: number | null = null;
    for (const machine of machines) {
        const at = readMachineStatusNextRefreshAtMs(machine, nowMs);
        if (at !== null) next = next === null ? at : Math.min(next, at);
    }
    useSessionListRuntimeWake(next, machines.length > 0);
    return nowMs;
}
