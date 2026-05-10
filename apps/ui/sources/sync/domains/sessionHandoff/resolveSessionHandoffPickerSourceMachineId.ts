import { normalizeSessionHandoffMachineId, type SessionHandoffMachineMetadataLike } from './normalizeSessionHandoffMachineId';

export function resolveSessionHandoffPickerSourceMachineId(input: Readonly<{
    sourceMachineId?: string | null;
    sessionMetadata?: SessionHandoffMachineMetadataLike;
}>): string | null {
    return (
        normalizeSessionHandoffMachineId(input.sessionMetadata?.machineId)
        ?? normalizeSessionHandoffMachineId(input.sessionMetadata?.externalSessionV1?.machineId)
        ?? normalizeSessionHandoffMachineId(input.sourceMachineId)
        ?? null
    );
}
