import type { Machine } from '@/sync/domains/state/storageTypes';

import { normalizeKnownProjectMachineId } from '@/sync/runtime/orchestration/projectManager';
import { findMachineInCollection, type MachineCollection } from './machineCollection';
import { normalizeMachineIdentityString, type MachineTargetResolution } from './machineIdentityTypes';
import { resolveCanonicalMachineId } from './resolveCanonicalMachineId';

function chooseBasePath(input: Readonly<{
    sessionActive?: boolean | null;
    sessionPath?: string | null;
    projectPath?: string | null;
    projectMachineId?: string | null;
    originMachineId?: string | null;
    targetMachineId?: string | null;
}>): string | null {
    const sessionPath = normalizeMachineIdentityString(input.sessionPath);
    const projectPath = normalizeMachineIdentityString(input.projectPath);
    const projectMachineId = normalizeMachineIdentityString(input.projectMachineId);
    const originMachineId = normalizeMachineIdentityString(input.originMachineId);
    const targetMachineId = normalizeMachineIdentityString(input.targetMachineId);

    if (input.sessionActive === true && sessionPath) return sessionPath;
    if (
        projectPath
        && (
            !projectMachineId
            || !targetMachineId
            || projectMachineId === targetMachineId
            || projectMachineId === originMachineId
        )
    ) {
        return projectPath;
    }
    return sessionPath;
}

function resolveStableOriginMachineId(input: Readonly<{
    sessionMachineId?: string | null;
    projectMachineId?: string | null;
}>): string | null {
    const sessionMachineId = normalizeMachineIdentityString(input.sessionMachineId);
    if (sessionMachineId) return sessionMachineId;
    return normalizeKnownProjectMachineId(input.projectMachineId);
}

export function resolveSessionDisplayTarget(input: Readonly<{
    sessionActive?: boolean | null;
    sessionMachineId?: string | null;
    sessionPath?: string | null;
    projectMachineId?: string | null;
    projectPath?: string | null;
    machines: MachineCollection<Machine>;
}>): MachineTargetResolution | null {
    const originMachineId = resolveStableOriginMachineId(input);
    if (!originMachineId) return null;

    const canonical = resolveCanonicalMachineId(originMachineId, input.machines);
    const machineId = canonical?.reason === 'missingReplacementTarget'
        ? originMachineId
        : canonical?.machineId ?? originMachineId;
    const basePath = chooseBasePath({
        sessionActive: input.sessionActive,
        sessionPath: input.sessionPath,
        projectPath: input.projectPath,
        projectMachineId: input.projectMachineId,
        originMachineId,
        targetMachineId: machineId,
    });
    if (!basePath) return null;

    return {
        machineId,
        basePath,
        originMachineId,
        replaced: Boolean(canonical && canonical.machineId !== originMachineId),
    };
}

export function resolveSessionRpcTarget(input: Readonly<{
    sessionActive?: boolean | null;
    sessionMachineId?: string | null;
    sessionPath?: string | null;
    projectMachineId?: string | null;
    projectPath?: string | null;
    machines: MachineCollection<Machine>;
}>): MachineTargetResolution | null {
    const displayTarget = resolveSessionDisplayTarget(input);
    if (!displayTarget) return null;

    const machine = findMachineInCollection(input.machines, displayTarget.machineId);
    if (!machine) return null;
    if (machine.revokedAt && machine.revokedAt > 0) return null;
    if ('replacedByMachineId' in machine && machine.replacedByMachineId) return null;
    if (machine.active !== true) return null;

    return displayTarget;
}
