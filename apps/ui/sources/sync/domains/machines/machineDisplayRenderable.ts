import type { Machine, MachineAvailability, MachineMetadata } from '@/sync/domains/state/storageTypes';
import { linkMachineActivity } from './machineActivity';

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

// Machine content is replaced at publication. Heartbeat receipt fields may be
// updated in place, so identity alone cannot retain the projected display row.
const machineDisplays = new WeakMap<Machine, Readonly<{
    metadata: Machine['metadata'];
    updatedAt: number;
    activeAt: number;
    display: MachineDisplayRenderable;
}>>();

export function buildMachineDisplayRenderableFromMachine(machine: Machine): MachineDisplayRenderable {
    const previous = machineDisplays.get(machine);
    const display = previous?.display;
    if (previous && display && previous.metadata === machine.metadata
        && display.id === machine.id
        && display.isShared === machine.isShared
        && display.access === machine.access
        && display.kind === machine.kind
        && previous.updatedAt === machine.updatedAt
        && display.updatedAt === machine.updatedAt
        && display.active === machine.active
        && previous.activeAt === machine.activeAt
        && display.activeAt === machine.activeAt
        && display.revokedAt === (machine.revokedAt ?? null)
        && display.replacedByMachineId === (machine.replacedByMachineId ?? null)
        && display.replacedAt === (machine.replacedAt ?? null)
        && display.replacementReason === (machine.replacementReason ?? null)
        && display.replacementSource === (machine.replacementSource ?? null)
        && display.replacementActorUserId === (machine.replacementActorUserId ?? null)
        && display.availability === machine.availability
        && display.metadataVersion === machine.metadataVersion) return display;
    const next = {
        id: machine.id,
        ...(machine.isShared !== undefined ? { isShared: machine.isShared } : {}),
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
        metadata: previous && previous.metadata === machine.metadata
            ? previous.display.metadata : buildMachineDisplayMetadata(machine.metadata),
    };
    machineDisplays.set(machine, { metadata: machine.metadata,
        updatedAt: machine.updatedAt, activeAt: machine.activeAt, display: next });
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
        && previous.access?.custodian.accountId === next.access?.custodian.accountId
        && previous.access?.custodian.displayName === next.access?.custodian.displayName
        && previous.access?.role === next.access?.role
        && previous.access?.resourceMode === next.access?.resourceMode
        && previous.access?.accessState === next.access?.accessState
        && previous.kind === next.kind
        && (!includeHeartbeatTimestamps || previous.updatedAt === next.updatedAt)
        && previous.active === next.active
        && previous.presenceProtocolVersion === next.presenceProtocolVersion
        && previous.operationProtocolCapabilities === next.operationProtocolCapabilities
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
