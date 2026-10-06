import { WorkspaceRefV1Schema } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import type { WorkspaceRefV1 } from '@happier-dev/protocol';

import { getPathRemainderWithinBase } from '@/session/handoff/paths/sessionHandoffPathNormalization';

function normalizeIdentifier(value: string): string {
    return value.trim();
}

/** Resolve an Account-settings workspace identity only when the id is unique. */
export function resolveWorkspaceRefById(
    workspaceRefs: readonly WorkspaceRefV1[],
    workspaceRefId: string,
): WorkspaceRefV1 | null {
    const id = normalizeIdentifier(workspaceRefId);
    if (!id) return null;
    const matches = workspaceRefs.filter((ref) => normalizeIdentifier(ref.id) === id);
    return matches.length === 1 ? matches[0] ?? null : null;
}

export function resolveWorkspaceRefForMachineRoot(
    workspaceRefs: readonly WorkspaceRefV1[],
    scope: Readonly<{ machineId: string; rootPath: string }>,
): WorkspaceRefV1 | null {
    const machineId = normalizeIdentifier(scope.machineId);
    const rootPath = scope.rootPath.trim();
    if (!machineId || !rootPath) return null;
    const matches = workspaceRefs.filter((ref) => (
        normalizeIdentifier(ref.machineId) === machineId
        && getPathRemainderWithinBase(ref.rootPath, rootPath) === ''
    ));
    return matches.length === 1 ? matches[0] ?? null : null;
}

/**
 * Canonical Account-settings materialization for a daemon-resolved workspace
 * scope. Callers must supply an already-authorized canonical root; this owner
 * only assigns/reuses its stable Account identity.
 */
export function materializeWorkspaceRefForMachineRoot(
    workspaceRefs: readonly WorkspaceRefV1[],
    input: Readonly<{
        serverId: string;
        machineId: string;
        rootPath: string;
        label?: string;
        nowMs: number;
        createId: () => string;
    }>,
): Readonly<{ workspaceRefs: readonly WorkspaceRefV1[]; workspaceRef: WorkspaceRefV1; created: boolean }> {
    const serverId = normalizeIdentifier(input.serverId);
    const machineId = normalizeIdentifier(input.machineId);
    const rootPath = input.rootPath.trim();
    if (!serverId || !machineId || !rootPath) {
        throw Object.assign(new Error('Workspace scope is incomplete'), { code: 'workspace_ref_invalid' });
    }
    const matches = workspaceRefs.filter((ref) => (
        normalizeIdentifier(ref.serverId) === serverId
        && normalizeIdentifier(ref.machineId) === machineId
        && getPathRemainderWithinBase(ref.rootPath, rootPath) === ''
    ));
    if (matches.length > 1) {
        throw Object.assign(new Error('Workspace scope has multiple Account identities'), { code: 'workspace_ref_ambiguous' });
    }
    const existing = matches[0];
    if (existing) return Object.freeze({ workspaceRefs, workspaceRef: existing, created: false });

    const parsed = WorkspaceRefV1Schema.safeParse({
        id: input.createId(),
        serverId,
        machineId,
        rootPath,
        ...(input.label?.trim() ? { label: input.label.trim() } : {}),
        createdAtMs: input.nowMs,
    });
    if (!parsed.success) {
        throw Object.assign(new Error('Workspace scope could not be materialized'), { code: 'workspace_ref_invalid' });
    }
    const next = Object.freeze([...workspaceRefs, parsed.data]);
    return Object.freeze({ workspaceRefs: next, workspaceRef: parsed.data, created: true });
}
