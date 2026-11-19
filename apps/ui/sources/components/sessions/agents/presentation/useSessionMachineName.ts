import { useSessionReachableMachineTarget } from '@/components/sessions/model/useSessionMachineReachability';
import { getStorage, useMachine, useServerScopedMachine } from '@/sync/domains/state/storage';
import { keepHyphenatedNameTogether, readDisplayedMachineName } from '@/utils/sessions/machineDisplayNames';
import { readSessionOwnerHostName } from '@/utils/sessions/sessionUtils';

/**
 * The name of the Machine a Session runs on ("MacBook Pro"), for copy that says where agents run and
 * what they wait for. While the Machine's record is not loaded, or cannot give a name yet, it is the name the
 * Session recorded (the one its header and Work rows show); `null` only when neither is known, so copy falls
 * back to a sentence without a name rather than printing an id. The name keeps its hyphens unbroken (the label
 * owner's sentence rule), so a line wraps before "NLDW4-5-40-40" rather than inside it.
 */
export function useSessionMachineName(sessionId: string, serverId?: string | null): string | null {
    const target = useSessionReachableMachineTarget(sessionId, serverId);
    const machineId = target?.machineId ?? '';
    const scopedMachine = useServerScopedMachine(serverId, serverId ? machineId : '');
    const legacyMachine = useMachine(serverId ? '' : machineId);
    const machine = serverId ? scopedMachine : legacyMachine;
    const recordedName = getStorage()((state) => {
        const session = state.sessions[sessionId];
        return session ? readSessionOwnerHostName(session) : null;
    });
    // A record whose names are still loading, locked or unnamed has a placeholder title, not a name: copy that
    // says "on {machine}" keeps the name the Session recorded instead of printing "Loading…" or "Locked machine".
    const name = readDisplayedMachineName(machine) ?? recordedName;
    return name === null ? null : keepHyphenatedNameTogether(name);
}
