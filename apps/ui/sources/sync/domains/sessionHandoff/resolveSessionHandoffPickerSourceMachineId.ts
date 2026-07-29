import { readExternalSessionLink } from '../session/external/readExternalSessionLink';
import { normalizeSessionHandoffMachineId, type SessionHandoffMachineMetadataLike } from './normalizeSessionHandoffMachineId';

export function resolveSessionHandoffPickerSourceMachineId(input: Readonly<{
    sourceMachineId?: string | null;
    sessionMetadata?: SessionHandoffMachineMetadataLike;
}>): string | null {
    return (
        normalizeSessionHandoffMachineId(input.sessionMetadata?.machineId)
        ?? normalizeSessionHandoffMachineId(readExternalSessionLink(input.sessionMetadata)?.machineId)
        ?? normalizeSessionHandoffMachineId(input.sourceMachineId)
        ?? null
    );
}
