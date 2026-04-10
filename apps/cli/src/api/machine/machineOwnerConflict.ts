import type { MachineOwnerConflictMetadata } from '@happier-dev/protocol';
import { readMachineOwnerConflictSocketPayload } from '@happier-dev/protocol';

export type MachineOwnerConflictDetails = MachineOwnerConflictMetadata;

export function readMachineOwnerConflictFromSocketError(error: unknown): Readonly<{
    owner: MachineOwnerConflictDetails;
}> | null {
    const errorObject = typeof error === 'object' && error !== null ? error as Record<string, unknown> : null;
    const payload = readMachineOwnerConflictSocketPayload(errorObject?.data);
    return payload ? { owner: payload.owner } : null;
}
