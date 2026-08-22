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

export {
    isMachineReplaced,
    normalizeMachineIdentityString,
    type CanonicalMachineResolution,
} from '@happier-dev/protocol';

export type MachineTargetResolution = Readonly<{
    machineId: string;
    basePath: string;
    originMachineId: string;
    replaced: boolean;
}>;
