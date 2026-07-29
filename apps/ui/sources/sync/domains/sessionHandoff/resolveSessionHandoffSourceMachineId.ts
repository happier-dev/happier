import { readExternalSessionLink } from '../session/external/readExternalSessionLink';
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
        ?? normalizeSessionHandoffMachineId(readExternalSessionLink(input.sessionMetadata)?.machineId)
        ?? null
    );
}
