import type { Machine, MachineAvailability, MachineMetadata } from '@/sync/domains/state/storageTypes';
import { readMachinePresenceProtocolV1 } from '@happier-dev/protocol/machines/machineReachabilityV1';
import { linkMachineActivity } from './machineActivity';
import { areSnapshotProjectionsEquivalent } from '@/sync/domains/state/structuralSharing';

export interface MachineDisplayMetadata {
    displayName?: string | null;
    host?: string | null;
    homeDir?: string | null;
    platform?: string | null;
    /** The machine's published CPU architecture (platform fit for registry agents). */
    arch?: string | null;
    agentInventory?: MachineMetadata['agentInventory'];
}

export interface MachineDisplayRenderable {
    id: string;
    /** An identity-only choice has no Machine record; its inert fields are not presence facts. */
    presence?: null;
    isShared?: Machine['isShared'];
    /** Names only: a managed Machine is told apart by its short id, never its generated host. */
    managedMachineRef?: Machine['managedMachineRef'];
    managedInputRuntime?: Machine['managedInputRuntime'];
    access?: Machine['access'];
    kind?: Machine['kind'];
    updatedAt: number;
    active: boolean;
    activeAt: number;
    presenceProtocolVersion?: 1;
    operationProtocolCapabilities?: Machine['operationProtocolCapabilities'];
    operationProtocolCapabilitiesRevision?: Machine['operationProtocolCapabilitiesRevision'];
    revokedAt?: number | null;
    replacedByMachineId?: string | null;
    replacedAt?: number | string | null;
    replacementReason?: string | null;
    replacementSource?: string | null;
    replacementActorUserId?: string | null;
    availability?: MachineAvailability;
    metadataVersion: number;
    metadata: MachineDisplayMetadata | null;
}

export function buildMachineDisplayMetadata(metadata: MachineMetadata | null | undefined): MachineDisplayMetadata | null {
    if (!metadata) return null;
    return {
        displayName: typeof metadata.displayName === 'string' ? metadata.displayName : null,
        host: typeof metadata.host === 'string' ? metadata.host : null,
        homeDir: typeof metadata.homeDir === 'string' ? metadata.homeDir : null,
        platform: typeof metadata.platform === 'string' ? metadata.platform : null,
        ...(typeof metadata.arch === 'string' ? { arch: metadata.arch } : {}),
        ...(metadata.agentInventory ? { agentInventory: metadata.agentInventory } : {}),
    };
}

// Published Machine records, including their presence fields, are immutable.
const machineDisplays = new WeakMap<Machine, MachineDisplayRenderable>();

export function buildMachineDisplayRenderableFromMachine(machine: Machine, lastKnown?: MachineDisplayRenderable): MachineDisplayRenderable {
    const previous = machineDisplays.get(machine);
    if (previous && machine.metadata !== null) return previous;
    // Retained labels are presentation, never opened Machine content or launch authority.
    const retainedMetadata = machine.metadata === null && machine.availability === undefined
        && lastKnown?.id === machine.id && lastKnown.availability?.kind !== 'locked'
        ? lastKnown.metadata : null;
    const next = {
        id: machine.id,
        ...(machine.isShared !== undefined ? { isShared: machine.isShared } : {}),
        ...(machine.managedMachineRef ? { managedMachineRef: machine.managedMachineRef } : {}),
        ...(machine.managedInputRuntime !== undefined ? { managedInputRuntime: machine.managedInputRuntime } : {}),
        ...(machine.access ? { access: machine.access } : {}),
        kind: machine.kind,
        updatedAt: machine.updatedAt,
        active: machine.active,
        activeAt: machine.activeAt,
        ...(machine.presenceProtocolVersion === 1 ? { presenceProtocolVersion: 1 as const } : {}),
        ...(machine.operationProtocolCapabilities ? { operationProtocolCapabilities: machine.operationProtocolCapabilities } : {}),
        ...(machine.operationProtocolCapabilitiesRevision !== undefined
            ? { operationProtocolCapabilitiesRevision: machine.operationProtocolCapabilitiesRevision } : {}),
        revokedAt: machine.revokedAt ?? null,
        replacedByMachineId: machine.replacedByMachineId ?? null,
        replacedAt: machine.replacedAt ?? null,
        replacementReason: machine.replacementReason ?? null,
        replacementSource: machine.replacementSource ?? null,
        replacementActorUserId: machine.replacementActorUserId ?? null,
        ...(machine.availability ? { availability: machine.availability } : {}),
        metadataVersion: machine.metadataVersion,
        metadata: buildMachineDisplayMetadata(machine.metadata) ?? retainedMetadata,
    };
    if (previous && areMachineDisplayRenderablesEqual(previous, next)) return previous;
    machineDisplays.set(machine, next);
    linkMachineActivity(machine, next);
    return next;
}

export function areMachineDisplayRenderablesEqual(
    previous: MachineDisplayRenderable | null | undefined,
    next: MachineDisplayRenderable | null | undefined,
): boolean {
    return areMachineDisplayValuesEqual(previous, next, true);
}

/** Presence timestamps have a separate subscription owner and do not invalidate display inventory. */
export function areMachineDisplaySemanticsEqual(
    previous: MachineDisplayRenderable | null | undefined,
    next: MachineDisplayRenderable | null | undefined,
): boolean {
    return areMachineDisplayValuesEqual(previous, next, false);
}

function areMachineDisplayValuesEqual(
    previous: MachineDisplayRenderable | null | undefined,
    next: MachineDisplayRenderable | null | undefined,
    includeHeartbeatTimestamps: boolean,
): boolean {
    if (previous === next) return true;
    if (!previous || !next) return previous === next;
    return previous.id === next.id
        && previous.isShared === next.isShared
        && (previous.managedMachineRef?.managedId ?? null) === (next.managedMachineRef?.managedId ?? null)
        && previous.managedInputRuntime?.nativeReady === next.managedInputRuntime?.nativeReady
        && previous.managedInputRuntime?.wakeState === next.managedInputRuntime?.wakeState
        && previous.access?.custodian.accountId === next.access?.custodian.accountId
        && previous.access?.custodian.displayName === next.access?.custodian.displayName
        && previous.access?.role === next.access?.role
        && previous.access?.resourceMode === next.access?.resourceMode
        && previous.access?.accessState === next.access?.accessState
        && previous.access?.reason === next.access?.reason
        && previous.kind === next.kind
        && (!includeHeartbeatTimestamps || previous.updatedAt === next.updatedAt)
        && previous.active === next.active
        && readMachinePresenceProtocolV1(previous) === readMachinePresenceProtocolV1(next)
        && areSnapshotProjectionsEquivalent(previous.operationProtocolCapabilities ?? null, next.operationProtocolCapabilities ?? null)
        && previous.operationProtocolCapabilitiesRevision === next.operationProtocolCapabilitiesRevision
        && (!includeHeartbeatTimestamps || previous.activeAt === next.activeAt)
        && (previous.revokedAt ?? null) === (next.revokedAt ?? null)
        && previous.metadataVersion === next.metadataVersion
        && (previous.replacedByMachineId ?? null) === (next.replacedByMachineId ?? null)
        && (previous.replacedAt ?? null) === (next.replacedAt ?? null)
        && (previous.replacementReason ?? null) === (next.replacementReason ?? null)
        && (previous.replacementSource ?? null) === (next.replacementSource ?? null)
        && (previous.replacementActorUserId ?? null) === (next.replacementActorUserId ?? null)
        && (previous.availability?.kind ?? 'available') === (next.availability?.kind ?? 'available')
        && (previous.availability?.kind === 'locked' ? previous.availability.reason : null)
            === (next.availability?.kind === 'locked' ? next.availability.reason : null)
        && (previous.metadata?.displayName ?? null) === (next.metadata?.displayName ?? null)
        && (previous.metadata?.host ?? null) === (next.metadata?.host ?? null)
        && (previous.metadata?.homeDir ?? null) === (next.metadata?.homeDir ?? null)
        && (previous.metadata?.platform ?? null) === (next.metadata?.platform ?? null)
        && (previous.metadata?.arch ?? null) === (next.metadata?.arch ?? null)
        && JSON.stringify(previous.metadata?.agentInventory ?? null) === JSON.stringify(next.metadata?.agentInventory ?? null);
}

export function getMachineDisplaySubtitle(machine: MachineDisplayRenderable | undefined, machineId: string): string {
    const displayName = typeof machine?.metadata?.displayName === 'string' ? machine.metadata.displayName.trim() : '';
    if (displayName) return displayName;
    const host = typeof machine?.metadata?.host === 'string' ? machine.metadata.host.trim() : '';
    if (host) return host;
    return machine?.id ?? machineId;
}
