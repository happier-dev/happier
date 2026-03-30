import { normalizeSessionHandoffMachineId, type SessionHandoffMachineMetadataLike } from './normalizeSessionHandoffMachineId';

export function resolveSessionHandoffSourceMachineId(input: Readonly<{
    reachableMachineId?: string | null;
    sourceMachineId?: string | null;
    sessionMetadata?: SessionHandoffMachineMetadataLike;
}>): string | null {
    return (
        normalizeSessionHandoffMachineId(input.reachableMachineId)
        ?? normalizeSessionHandoffMachineId(input.sourceMachineId)
        ?? normalizeSessionHandoffMachineId(input.sessionMetadata?.machineId)
        ?? normalizeSessionHandoffMachineId(input.sessionMetadata?.directSessionV1?.machineId)
        ?? null
    );
}
