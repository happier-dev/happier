import type { Machine } from '@/sync/domains/state/storageTypes';
import { findMachineInCollection, type MachineCollection } from '@/sync/domains/machines/identity/machineCollection';
import { resolveCanonicalMachineId } from '@/sync/domains/machines/identity/resolveCanonicalMachineId';
import { resolveSessionRpcTarget } from '@/sync/domains/machines/identity/resolveSessionMachineTargets';

function normalizeNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function resolveSessionMachineRpcTarget(input: Readonly<{
    sessionId: string;
    sessionActive?: boolean | null;
    sessionMachineId?: string | null;
    sessionPath?: string | null;
    projectMachineId?: string | null;
    projectPath?: string | null;
    machines: MachineCollection<Machine>;
}>): { machineId: string; basePath: string } | null {
    const target = resolveSessionRpcTarget({
        sessionActive: input.sessionActive,
        sessionMachineId: input.sessionMachineId,
        sessionPath: input.sessionPath,
        projectMachineId: input.projectMachineId,
        projectPath: input.projectPath,
        machines: input.machines,
    });
    return target ? { machineId: target.machineId, basePath: target.basePath } : null;
}

export function resolveSessionReachableMachineId(input: Readonly<{
    machineId: string | null | undefined;
    fallbackMachineId?: string | null | undefined;
    hostHint?: string | null | undefined;
    machines: MachineCollection<Machine>;
}>): string | null {
    const machineId = normalizeNonEmptyString(input.machineId);
    const fallbackMachineId = normalizeNonEmptyString(input.fallbackMachineId);

    if (machineId?.startsWith('host:')) return null;
    if (fallbackMachineId?.startsWith('host:')) return null;

    const requestedMachineId = machineId ?? fallbackMachineId;
    if (!requestedMachineId) return null;

    const canonical = resolveCanonicalMachineId(requestedMachineId, input.machines);
    if (canonical?.reason === 'replacement') return canonical.machineId;
    if (canonical === null && findMachineInCollection(input.machines, requestedMachineId)) return null;
    return requestedMachineId;
}
