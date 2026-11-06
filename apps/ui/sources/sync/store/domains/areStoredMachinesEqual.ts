import { retainDeep } from '@/sync/domains/state/structuralSharing';
import type { Machine } from '../../domains/state/storageTypes';
import { areSessionValuesDeepEqual } from './areStoredSessionsEqual';
import { hasCurrentMachineContent } from '../../domains/machines/resolveServerScopedMachines';
import { isMachineOnline } from '@/utils/sessions/machineUtils';

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
    // A version-zero socket placeholder has no daemon observation yet.
    // A positive version still carries the legacy invalidation signal even
    // when its content is unavailable or predates the explicit revision.
    if (!previousState && (previous.daemonStateVersion ?? 0) === 0) return false;
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
    return areStoredMachineValuesEqual(previous, next, true);
}

/** Heartbeat timestamps are published through the machine-presence slice, not semantic inventory. */
export function areStoredMachineSemanticsEqual(
    previous: Machine | null | undefined,
    next: Machine | null | undefined,
): boolean {
    return areStoredMachineValuesEqual(previous, next, false, true, false);
}

type MachineContentAuthority = Pick<Machine, 'id' | 'dataEncryptionKey' | 'keyBasis' | 'installationId'
    | 'installationPublicKey' | 'contentPublicKeyFingerprint' | 'access' | 'isShared' | 'revokedAt'
    | 'replacedByMachineId' | 'replacedAt'>;

/** Content versions are meaningful only within this admitted installation/access/key basis. */
export function haveSameMachineContentAuthority(previous: MachineContentAuthority, next: MachineContentAuthority): boolean {
    return previous.id === next.id
        && (previous.dataEncryptionKey ?? null) === (next.dataEncryptionKey ?? null)
        && (previous.keyBasis ? previous.keyBasis.dataEncryptionKey : previous.dataEncryptionKey ?? null)
            === (next.keyBasis ? next.keyBasis.dataEncryptionKey : next.dataEncryptionKey ?? null)
        && (previous.installationId ?? null) === (next.installationId ?? null)
        && (previous.installationPublicKey ?? null) === (next.installationPublicKey ?? null)
        && (previous.contentPublicKeyFingerprint ?? null) === (next.contentPublicKeyFingerprint ?? null)
        && (previous.revokedAt ?? null) === (next.revokedAt ?? null)
        && (previous.replacedByMachineId ?? null) === (next.replacedByMachineId ?? null)
        && (previous.replacedAt ?? null) === (next.replacedAt ?? null)
        && Boolean(previous.isShared) === Boolean(next.isShared)
        && (previous.access?.custodian.accountId ?? null) === (next.access?.custodian.accountId ?? null)
        && (previous.access?.role ?? null) === (next.access?.role ?? null)
        && (previous.access?.resourceMode ?? null) === (next.access?.resourceMode ?? null)
        && (previous.access?.accessState ?? null) === (next.access?.accessState ?? null);
}

/** One inventory retention rule for full-row ingress and later hydration. */
export function retainMachineRecord(previous: Machine | null | undefined, next: Machine): Machine {
    if (!previous || previous.storageMode !== next.storageMode || !haveSameMachineContentAuthority(previous, next)) return next;
    if (areStoredMachineSemanticsEqual(previous, next)) return previous;
    let retained = next;
    // Exact-field readers share the admitted siblings even when another field in the same decoded
    // blob advances. Whole-row version authority stays above.
    const retainField = <Key extends keyof Machine>(key: Key) => {
        const field = retainDeep(previous[key], next[key]);
        if (field === next[key]) return;
        if (retained === next) retained = { ...next };
        retained[key] = field;
    };
    for (const key of ['metadata', 'daemonState', 'availability', 'access', 'keyBasis', 'operationProtocolCapabilities', 'managedMachineRef'] as const) {
        retainField(key);
    }
    return retained;
}

/** Resource publications do not change launch choices. Content/key readiness still does. */
export function areMachineLaunchInputsEqual(previous: Machine, next: Machine): boolean {
    const nowMs = Date.now();
    return areStoredMachineValuesEqual(previous, next, false, false)
        && isMachineOnline(previous, nowMs) === isMachineOnline(next, nowMs)
        && hasCurrentMachineContent(previous) === hasCurrentMachineContent(next);
}

export function areMachineFactsEqual(previous: Machine, next: Machine): boolean {
    return areStoredMachineValuesEqual(previous, next, true, false)
        && hasCurrentMachineContent(previous) === hasCurrentMachineContent(next);
}

function areMachineLaunchKeyBasesEqual(previous: Machine['keyBasis'], next: Machine['keyBasis']): boolean {
    if (!previous || !next) return previous === next;
    // Daemon revisions also advance for resources. Content readiness is checked
    // separately; the owner envelope and metadata revision still affect launch.
    return previous.dataEncryptionKey === next.dataEncryptionKey
        && previous.metadataVersion === next.metadataVersion;
}

function areDaemonLaunchInputsEqual(previous: unknown, next: unknown): boolean {
    if (previous === next) return true;
    const left = readDaemonState(previous);
    const right = readDaemonState(next);
    if (!left || !right) return areSessionValuesDeepEqual(previous ?? null, next ?? null);
    const keys = Object.keys(left).filter(key => key !== 'resources' && key !== 'managedActivity');
    return keys.length === Object.keys(right).filter(key => key !== 'resources' && key !== 'managedActivity').length
        && keys.every(key => Object.hasOwn(right, key) && areSessionValuesDeepEqual(left[key], right[key]));
}

function areStoredMachineValuesEqual(
    previous: Machine | null | undefined,
    next: Machine | null | undefined,
    includeHeartbeatTimestamps: boolean,
    includeResources = true,
    includeActiveState = true,
): boolean {
    if (previous === next) return true;
    if (!previous || !next) return previous === next;
    return previous.id === next.id
        && areSessionValuesDeepEqual(previous.managedMachineRef, next.managedMachineRef)
        && previous.kind === next.kind
        && (!includeResources || previous.seq === next.seq)
        && previous.createdAt === next.createdAt
        && (!includeHeartbeatTimestamps || previous.updatedAt === next.updatedAt)
        && (!includeActiveState || previous.active === next.active)
        && previous.presenceProtocolVersion === next.presenceProtocolVersion
        && (!includeHeartbeatTimestamps || previous.activeAt === next.activeAt)
        && (previous.revokedAt ?? null) === (next.revokedAt ?? null)
        && previous.metadataVersion === next.metadataVersion
        && (!includeResources || previous.daemonStateVersion === next.daemonStateVersion)
        && (previous.replacedByMachineId ?? null) === (next.replacedByMachineId ?? null)
        && (previous.replacedAt ?? null) === (next.replacedAt ?? null)
        && (previous.replacementReason ?? null) === (next.replacementReason ?? null)
        && (previous.replacementSource ?? null) === (next.replacementSource ?? null)
        && (previous.replacementActorUserId ?? null) === (next.replacementActorUserId ?? null)
        && (previous.installationId ?? null) === (next.installationId ?? null)
        && (previous.installationPublicKey ?? null) === (next.installationPublicKey ?? null)
        && previous.isShared === next.isShared
        && (previous.contentPublicKeyFingerprint ?? null) === (next.contentPublicKeyFingerprint ?? null)
        && (previous.operationProtocolCapabilitiesRevision ?? null) === (next.operationProtocolCapabilitiesRevision ?? null)
        && areSessionValuesDeepEqual(previous.operationProtocolCapabilities ?? null, next.operationProtocolCapabilities ?? null)
        && (previous.storageMode ?? null) === (next.storageMode ?? null)
        && (previous.dataEncryptionKey ?? null) === (next.dataEncryptionKey ?? null)
        && (includeResources
            ? areSessionValuesDeepEqual(previous.keyBasis ?? null, next.keyBasis ?? null)
            : areMachineLaunchKeyBasesEqual(previous.keyBasis, next.keyBasis))
        && areSessionValuesDeepEqual(previous.access ?? null, next.access ?? null)
        && areSessionValuesDeepEqual(previous.availability ?? null, next.availability ?? null)
        && areSessionValuesDeepEqual(previous.metadata ?? null, next.metadata ?? null)
        && (includeResources
            ? areSessionValuesDeepEqual(previous.daemonState ?? null, next.daemonState ?? null)
            : areDaemonLaunchInputsEqual(previous.daemonState, next.daemonState));
}
