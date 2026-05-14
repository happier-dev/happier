import type { Machine } from '@/sync/domains/state/storageTypes';

export type MachineReplacementSource = 'automatic' | 'manual' | string;

export type MachineWithReplacement = Machine & Readonly<{
    replacedByMachineId?: string | null;
    replacedAt?: number | string | null;
    replacementReason?: string | null;
    replacementSource?: MachineReplacementSource | null;
    replacementActorUserId?: string | null;
    installationId?: string | null;
    contentPublicKeyFingerprint?: string | null;
}>;

export type CanonicalMachineResolution = Readonly<{
    machineId: string;
    reason: 'direct' | 'replacement' | 'missingReplacementTarget';
    chain: readonly string[];
}>;

export type MachineTargetResolution = Readonly<{
    machineId: string;
    basePath: string;
    originMachineId: string;
    replaced: boolean;
}>;

export function normalizeMachineIdentityString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function isMachineReplaced(
    machine: Readonly<{ replacedByMachineId?: string | null; replacedAt?: unknown }> | null | undefined,
): boolean {
    return Boolean(normalizeMachineIdentityString(machine?.replacedByMachineId));
}
