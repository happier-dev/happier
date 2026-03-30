import type { Machine, MachineMetadata } from '@/sync/domains/state/storageTypes';
import { normalizeNonEmptyString } from '@/utils/strings/normalizeNonEmptyString';

export interface MachineDisplayMetadata {
    displayName?: string | null;
    host?: string | null;
    homeDir?: string | null;
}

export interface MachineDisplayRenderable {
    id: string;
    updatedAt: number;
    active: boolean;
    activeAt: number;
    revokedAt?: number | null;
    metadataVersion: number;
    metadata: MachineDisplayMetadata | null;
}

export function buildMachineDisplayMetadata(metadata: MachineMetadata | null | undefined): MachineDisplayMetadata | null {
    if (!metadata) return null;
    return {
        displayName: typeof metadata.displayName === 'string' ? metadata.displayName : null,
        host: typeof metadata.host === 'string' ? metadata.host : null,
        homeDir: typeof metadata.homeDir === 'string' ? metadata.homeDir : null,
    };
}

export function buildMachineDisplayRenderableFromMachine(machine: Machine): MachineDisplayRenderable {
    return {
        id: machine.id,
        updatedAt: machine.updatedAt,
        active: machine.active,
        activeAt: machine.activeAt,
        revokedAt: machine.revokedAt ?? null,
        metadataVersion: machine.metadataVersion,
        metadata: buildMachineDisplayMetadata(machine.metadata),
    };
}

export function getMachineDisplaySubtitle(machine: MachineDisplayRenderable | undefined, machineId: string): string {
    const displayName = typeof machine?.metadata?.displayName === 'string' ? machine.metadata.displayName.trim() : '';
    if (displayName) return displayName;
    const host = typeof machine?.metadata?.host === 'string' ? machine.metadata.host.trim() : '';
    if (host) return host;
    return machine?.id ?? machineId;
}

export function resolveBestMachineDisplayRenderableForHost(
    machines: Record<string, MachineDisplayRenderable>,
    hostInput: string,
): MachineDisplayRenderable | null {
    const host = normalizeNonEmptyString(hostInput);
    if (!host) return null;

    let best: MachineDisplayRenderable | null = null;
    for (const machine of Object.values(machines)) {
        const machineHost = normalizeNonEmptyString(machine.metadata?.host);
        if (!machineHost || machineHost !== host) continue;
        if (!best) {
            best = machine;
            continue;
        }

        if (machine.metadataVersion !== best.metadataVersion) {
            if (machine.metadataVersion > best.metadataVersion) {
                best = machine;
            }
            continue;
        }

        if (machine.id.localeCompare(best.id) > 0) {
            best = machine;
        }
    }

    return best;
}
