import type { Machine } from '../../domains/state/storageTypes';
import { areSessionValuesDeepEqual } from './areStoredSessionsEqual';

export function hasMachineDaemonStateAdvanced(
    previous: Machine | null | undefined,
    next: Machine,
): boolean {
    return typeof next.daemonStateVersion === 'number'
        && next.daemonStateVersion > (previous?.daemonStateVersion ?? 0);
}

function readDaemonState(value: unknown): Readonly<Record<string, unknown>> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readContributionRegistryProjectionRevision(state: Readonly<Record<string, unknown>> | null): number | null {
    const revision = state?.contributionRegistryProjectionRevision;
    return typeof revision === 'number' && Number.isInteger(revision) && revision >= 0 ? revision : null;
}

/** The machine writer owns projection currentness for every Home's readers. */
export function hasMachineContributionRegistryProjectionChanged(
    previous: Machine | null | undefined,
    next: Machine,
): boolean {
    // The first inventory observation reports the endpoint an early reader
    // already asked; it is not itself a replacement or registry adoption.
    if (!previous || !hasMachineDaemonStateAdvanced(previous, next)) return false;
    const previousState = readDaemonState(previous.daemonState);
    const nextState = readDaemonState(next.daemonState);
    const previousRevision = readContributionRegistryProjectionRevision(previousState);
    const nextRevision = readContributionRegistryProjectionRevision(nextState);
    // Older daemon publications have only the broad version signal. Retain
    // that behavior until both observations carry the explicit revision.
    if (previousRevision === null || nextRevision === null) return true;
    return previousRevision !== nextRevision
        || ['runtimeId', 'pid', 'startedAt', 'httpPort', 'status'].some((field) => (
            previousState?.[field] !== nextState?.[field]
        ));
}

export function areStoredMachinesEqual(
    previous: Machine | null | undefined,
    next: Machine | null | undefined,
): boolean {
    if (previous === next) return true;
    if (!previous || !next) return previous === next;
    return previous.id === next.id
        && previous.kind === next.kind
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
        && (previous.operationProtocolCapabilitiesRevision ?? null) === (next.operationProtocolCapabilitiesRevision ?? null)
        && areSessionValuesDeepEqual(previous.operationProtocolCapabilities ?? null, next.operationProtocolCapabilities ?? null)
        && (previous.storageMode ?? null) === (next.storageMode ?? null)
        && (previous.dataEncryptionKey ?? null) === (next.dataEncryptionKey ?? null)
        && areSessionValuesDeepEqual(previous.keyBasis ?? null, next.keyBasis ?? null)
        && areSessionValuesDeepEqual(previous.access ?? null, next.access ?? null)
        && areSessionValuesDeepEqual(previous.availability ?? null, next.availability ?? null)
        && areSessionValuesDeepEqual(previous.metadata ?? null, next.metadata ?? null)
        && areSessionValuesDeepEqual(previous.daemonState ?? null, next.daemonState ?? null);
}
