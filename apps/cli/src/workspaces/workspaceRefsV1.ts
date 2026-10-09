import { WorkspaceRefV1WriteSchema, type WorkspaceAddressV1, type WorkspaceProjectFactsV1, type WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveWorkspaceRefV1, enrichWorkspaceRefV1, resolveWorkspaceProjectKeyV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

import { getPathRemainderWithinBase } from '@/session/handoff/paths/sessionHandoffPathNormalization';

function normalizeIdentifier(value: string): string {
    return value.trim();
}

/** Resolve an Account Project workspace identity only when the qualified address is unique. */
export function resolveWorkspaceRefById(
    workspaceRefs: readonly WorkspaceRefV1[],
    workspaceRefId: string,
    serverId?: string,
): WorkspaceRefV1 | null {
    const result = resolveWorkspaceRefV1(workspaceRefs, { id: workspaceRefId, ...(serverId !== undefined ? { serverId } : {}) });
    return result.kind === 'resolved' ? result.ref : null;
}

export function resolveWorkspaceRefForMachineRoot(
    workspaceRefs: readonly WorkspaceRefV1[],
    scope: Readonly<{ serverId?: string; machineId: string; rootPath: string }>,
): WorkspaceRefV1 | null {
    const result = resolveWorkspaceRefV1(workspaceRefs, { ...scope, serverId: scope.serverId ?? '' }, {
        rootsEqual: (left, right) => getPathRemainderWithinBase(left, right) === '',
    });
    return result.kind === 'resolved' ? result.ref : null;
}

/**
 * Canonical Account Project ref materialization for a daemon-resolved workspace
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
        /** Host-proven native parent; only a newly accepted child may inherit its current anchor. */
        parentWorkspace?: WorkspaceAddressV1;
        nowMs: number;
        createId: () => string;
    }> & Pick<WorkspaceProjectFactsV1, 'repositoryIdentity' | 'source'>,
): Readonly<{ workspaceRefs: readonly WorkspaceRefV1[]; workspaceRef: WorkspaceRefV1; created: boolean }> {
    const serverId = normalizeIdentifier(input.serverId);
    const machineId = normalizeIdentifier(input.machineId);
    const rootPath = input.rootPath.trim();
    if (!serverId || !machineId || !rootPath) {
        throw Object.assign(new Error('Workspace scope is incomplete'), { code: 'workspace_ref_invalid' });
    }
    const resolution = resolveWorkspaceRefV1(workspaceRefs, { serverId, machineId, rootPath }, {
        rootsEqual: (left, right) => getPathRemainderWithinBase(left, right) === '',
    });
    if (resolution.kind === 'ambiguous') {
        throw Object.assign(new Error('Workspace scope has multiple Account identities'), { code: 'workspace_ref_ambiguous' });
    }
    if (resolution.kind === 'invalid') throw Object.assign(new Error(resolution.reason), { code: 'workspace_ref_invalid' });
    const facts = {
        ...(input.repositoryIdentity ? { repositoryIdentity: input.repositoryIdentity } : {}),
        ...(input.source ? { source: input.source } : {}),
    };
    if (resolution.kind === 'resolved') {
        const existing = resolution.ref;
        const workspaceRef = WorkspaceRefV1WriteSchema.parse(enrichWorkspaceRefV1(existing, facts));
        const next = workspaceRefs.map(ref => ref === existing ? workspaceRef : ref);
        return Object.freeze({ workspaceRefs: Object.freeze(next), workspaceRef, created: false });
    }

    const id = input.createId();
    let parentProjectKey: string | undefined;
    if (input.parentWorkspace) {
        const parent = resolveWorkspaceRefV1(workspaceRefs, { serverId, id: input.parentWorkspace.workspaceId });
        if (input.parentWorkspace.serverId !== serverId || parent.kind !== 'resolved'
            || resolveWorkspaceRefV1([parent.ref], input.parentWorkspace).kind !== 'resolved') {
            throw Object.assign(new Error('Parent workspace is no longer current'), { code: 'workspace_ref_not_ready' });
        }
        parentProjectKey = parent.ref.projectKey ?? parent.ref.id;
    }
    const parsed = WorkspaceRefV1WriteSchema.safeParse({
        id,
        ...facts,
        projectKey: parentProjectKey ?? resolveWorkspaceProjectKeyV1(workspaceRefs, { serverId, id, ...facts }),
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
