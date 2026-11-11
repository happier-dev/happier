import { resolveSessionWorkspaceRootForMachine } from '@happier-dev/protocol/sessions/metadata/sessionWorkspaceLocationV1';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { readMachineActivity, readMachinePresenceAnswer } from '@/sync/domains/machines/machineActivity';

import { normalizeKnownProjectMachineId } from '@/sync/runtime/orchestration/projectManager';
import { findMachineInCollection, type MachineCollection } from './machineCollection';
import { normalizeMachineIdentityString, type MachineTargetResolution } from './machineIdentityTypes';
import { resolveCanonicalMachineId } from './resolveCanonicalMachineId';

export function resolveSessionBasePathForMachine(input: Readonly<{
    sessionActive?: boolean | null;
    sessionPath?: string | null;
    sessionWorkspaceMetadata?: unknown;
    projectPath?: string | null;
    projectMachineId?: string | null;
    originMachineId?: string | null;
    targetMachineId?: string | null;
}>): string | null {

    const projectPath = normalizeMachineIdentityString(input.projectPath);
    const projectMachineId = normalizeMachineIdentityString(input.projectMachineId);
    const originMachineId = normalizeMachineIdentityString(input.originMachineId);
    const targetMachineId = normalizeMachineIdentityString(input.targetMachineId);
    const sessionPath = normalizeMachineIdentityString(input.sessionPath)
        ?? (targetMachineId ? resolveSessionWorkspaceRootForMachine({
            metadata: input.sessionWorkspaceMetadata,
            machineId: targetMachineId,
            candidatePath: '',
        }).agentPath ?? null : null);

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
    sessionWorkspaceMetadata?: unknown;
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
    const basePath = resolveSessionBasePathForMachine({
        sessionActive: input.sessionActive,
        sessionPath: input.sessionPath,
        sessionWorkspaceMetadata: input.sessionWorkspaceMetadata,
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
    sessionWorkspaceMetadata?: unknown;
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
    // An unanswered inventory bit is not an offline answer. Keep the exact
    // Session target so its first RPC can establish reachability.
    if (readMachinePresenceAnswer(machine) !== false && !readMachineActivity(machine).active) return null;

    return displayTarget;
}
