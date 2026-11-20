import type { WorkspaceRefResolutionContextV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { WorkspaceRefV1WriteSchema, ManagedWorkspaceRefV2WriteSchema, isManagedWorkspaceRefV2, type MachineWorkspaceRefV1, type ManagedWorkspaceRefV2, type WorkspaceAddressV2, type WorkspaceProjectFactsV1, type WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveWorkspaceRefV1, enrichWorkspaceRefV1, resolveWorkspaceProjectKeyV1, workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';

function normalizeIdentifier(value: string): string {
    return value.trim();
}

/** Resolve an Account Project workspace identity only when the qualified address is unique. */
export function resolveWorkspaceRefById(
    workspaceRefs: readonly WorkspaceRefV1[],
    workspaceRefId: string,
    serverId?: string,
    context: WorkspaceRefResolutionContextV1 = {},
): WorkspaceRefV1 | null {
    const result = resolveWorkspaceRefV1(workspaceRefs, { id: workspaceRefId, ...(serverId !== undefined ? { serverId } : {}) }, context);
    return result.kind === 'resolved' ? result.ref : null;
}

export function resolveWorkspaceRefForMachineRoot(
    workspaceRefs: readonly WorkspaceRefV1[],
    scope: Readonly<{ serverId?: string; machineId: string; rootPath: string }>,
    context: WorkspaceRefResolutionContextV1 = {},
): WorkspaceRefV1 | null {
    const result = resolveWorkspaceRefV1(workspaceRefs, { ...scope, serverId: scope.serverId ?? '' }, context);
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
        /** Host-proven native parent or copy source; only a new ref may inherit its current anchor. */
        parentWorkspace?: WorkspaceAddressV2;
        /** Main checkout root proven by the selected host SCM backend. */
        parentRootPath?: string;
        nowMs: number;
        createId: () => string;
    }> & Pick<WorkspaceProjectFactsV1, 'repositoryIdentity' | 'source'>,
): Readonly<{ workspaceRefs: readonly WorkspaceRefV1[]; workspaceRef: MachineWorkspaceRefV1; created: boolean }> {
    const serverId = normalizeIdentifier(input.serverId);
    const machineId = normalizeIdentifier(input.machineId);
    const rootPath = input.rootPath.trim();
    if (!serverId || !machineId || !rootPath) {
        throw Object.assign(new Error('Workspace scope is incomplete'), { code: 'workspace_ref_invalid' });
    }
    const resolution = resolveWorkspaceRefV1(workspaceRefs, { serverId, machineId, rootPath });
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
        // A checkout that first learns its repository joins that repository's Project (the enrichment owner decides).
        const workspaceRef = WorkspaceRefV1WriteSchema.parse(enrichWorkspaceRefV1(existing, facts, workspaceRefs));
        const next = workspaceRefs.map(ref => ref === existing ? workspaceRef : ref);
        return Object.freeze({ workspaceRefs: Object.freeze(next), workspaceRef, created: false });
    }

    let currentRefs = workspaceRefs;
    let parentWorkspace = input.parentWorkspace;
    if (!parentWorkspace && input.parentRootPath) {
        const parent = materializeWorkspaceRefForMachineRoot(currentRefs, {
            serverId, machineId, rootPath: input.parentRootPath, ...facts,
            nowMs: input.nowMs, createId: input.createId,
        });
        currentRefs = parent.workspaceRefs;
        parentWorkspace = workspaceAddressFromRefV2(parent.workspaceRef);
    }
    const id = input.createId();
    let parentProjectKey: string | undefined;
    if (parentWorkspace) {
        const parent = resolveWorkspaceRefV1(currentRefs, { serverId, id: parentWorkspace.workspaceId });
        if (parentWorkspace.serverId !== serverId || parent.kind !== 'resolved'
            || resolveWorkspaceRefV1([parent.ref], parentWorkspace).kind !== 'resolved') {
            throw Object.assign(new Error('Parent workspace is no longer current'), { code: 'workspace_ref_not_ready' });
        }
        parentProjectKey = parent.ref.projectKey ?? parent.ref.id;
    }
    const parsed = WorkspaceRefV1WriteSchema.safeParse({
        id,
        ...facts,
        projectKey: parentProjectKey ?? resolveWorkspaceProjectKeyV1(currentRefs, { serverId, id, ...facts }),
        serverId,
        machineId,
        rootPath,
        ...(input.label?.trim() ? { label: input.label.trim() } : {}),
        createdAtMs: input.nowMs,
    });
    if (!parsed.success) {
        throw Object.assign(new Error('Workspace scope could not be materialized'), { code: 'workspace_ref_invalid' });
    }
    const next = Object.freeze([...currentRefs, parsed.data]);
    return Object.freeze({ workspaceRefs: next, workspaceRef: parsed.data, created: true });
}

/** Native filesystem identity stays qualified by its managed owner, never its routing Machine. */
export function materializeWorkspaceRefForManagedRoot(
    workspaceRefs: readonly WorkspaceRefV1[],
    input: Readonly<{
        serverId: string;
        managedId: string;
        controller: ManagedWorkspaceRefV2['controller'];
        rootPath: string;
        parentWorkspace?: WorkspaceAddressV2;
        nowMs: number;
        createId: () => string;
    }>,
): Readonly<{ workspaceRefs: readonly WorkspaceRefV1[]; workspaceRef: ManagedWorkspaceRefV2; created: boolean }> {
    const serverId = input.serverId.trim();
    const managedId = input.managedId.trim();
    const rootPath = input.rootPath.trim();
    const controller = { machineId: input.controller.machineId.trim(), installationId: input.controller.installationId.trim() };
    const resolution = resolveWorkspaceRefV1(workspaceRefs, { v: 2, kind: 'managed', serverId, managedId, controller, rootPath });
    if (resolution.kind === 'ambiguous') {
        throw Object.assign(new Error('Workspace scope has multiple Account identities'), { code: 'workspace_ref_ambiguous' });
    }
    if (resolution.kind === 'invalid') throw Object.assign(new Error(resolution.reason), { code: 'workspace_ref_invalid' });
    if (resolution.kind === 'resolved' && isManagedWorkspaceRefV2(resolution.ref)) {
        return { workspaceRefs, workspaceRef: resolution.ref, created: false };
    }
    const id = input.createId();
    let projectKey = id;
    if (input.parentWorkspace) {
        const parent = resolveWorkspaceRefV1(workspaceRefs, input.parentWorkspace);
        if (input.parentWorkspace.serverId !== serverId || parent.kind !== 'resolved') {
            throw Object.assign(new Error('Parent workspace is no longer current'), { code: 'workspace_ref_not_ready' });
        }
        projectKey = parent.ref.projectKey ?? parent.ref.id;
    }
    const workspaceRef = ManagedWorkspaceRefV2WriteSchema.parse({ id, serverId, v: 2, kind: 'managed',
        managedId, controller, rootPath, projectKey, createdAtMs: input.nowMs });
    return { workspaceRefs: Object.freeze([...workspaceRefs, workspaceRef]), workspaceRef, created: true };
}
