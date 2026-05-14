import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { useMachine } from '@/sync/domains/state/storage';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import { resolveSessionMachineReachability } from '@/components/sessions/model/resolveSessionMachineReachability';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';

export function useSessionReachableMachineTarget(sessionId: string): { machineId: string; basePath: string } | null {
    const resolvedSessionId = normalizeSessionId(sessionId);
    return useSessionMachineTarget(resolvedSessionId);
}

export function useSessionMachineReachability(sessionId: string): Readonly<{
    machineReachable: boolean;
    machineOnline: boolean;
    machineRpcTargetAvailable: boolean;
}> {
    const machineTarget = useSessionReachableMachineTarget(sessionId);
    const resolvedMachineId = machineTarget?.machineId ?? null;

    const resolvedMachine = useMachine(resolvedMachineId ?? '');

    const machineOnline = resolvedMachine ? isMachineOnline(resolvedMachine) : false;
    const machineReachable = resolveSessionMachineReachability({
        machineIsKnown: Boolean(resolvedMachine),
        machineIsOnline: machineOnline,
    });

    const machineRpcTargetAvailable = Boolean(machineTarget?.basePath);

    return { machineReachable, machineOnline, machineRpcTargetAvailable };
}
