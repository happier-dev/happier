import type { Machine } from '../../domains/state/storageTypes';
import { areSessionValuesDeepEqual } from './areStoredSessionsEqual';

export function hasMachineDaemonStateAdvanced(
    previous: Machine | null | undefined,
    next: Machine,
): boolean {
    return typeof next.daemonStateVersion === 'number'
        && next.daemonStateVersion > (previous?.daemonStateVersion ?? 0);
}

export function areStoredMachinesEqual(
    previous: Machine | null | undefined,
    next: Machine | null | undefined,
): boolean {
    if (previous === next) return true;
    if (!previous || !next) return previous === next;
    return previous.id === next.id
        && previous.seq === next.seq
        && previous.createdAt === next.createdAt
        && previous.updatedAt === next.updatedAt
        && previous.active === next.active
        && previous.activeAt === next.activeAt
        && (previous.revokedAt ?? null) === (next.revokedAt ?? null)
        && previous.metadataVersion === next.metadataVersion
        && previous.daemonStateVersion === next.daemonStateVersion
        && (previous.replacedByMachineId ?? null) === (next.replacedByMachineId ?? null)
        && (previous.replacedAt ?? null) === (next.replacedAt ?? null)
        && (previous.replacementReason ?? null) === (next.replacementReason ?? null)
        && (previous.replacementSource ?? null) === (next.replacementSource ?? null)
        && (previous.replacementActorUserId ?? null) === (next.replacementActorUserId ?? null)
        && (previous.installationId ?? null) === (next.installationId ?? null)
        && (previous.contentPublicKeyFingerprint ?? null) === (next.contentPublicKeyFingerprint ?? null)
        && areSessionValuesDeepEqual(previous.metadata ?? null, next.metadata ?? null)
        && areSessionValuesDeepEqual(previous.daemonState ?? null, next.daemonState ?? null);
}
