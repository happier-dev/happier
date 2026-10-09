import { randomUUID } from '@/platform/randomUUID';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { WorkspaceRefV1WriteSchema, type WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveWorkspaceRefV1, enrichWorkspaceRefV1, resolveWorkspaceProjectKeyV1, projectWorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { resolveProjectAccountWorkspaceRefRemovalV1 } from '@happier-dev/protocol/projects/projectAccountSnapshotV1';

import type { WorkspaceScopeBase } from './workspaceScope';
import { normalizeWorkspaceRootPath, normalizeWorkspaceScopeBase } from './workspaceScope';
import type { WorkspaceRefV1 } from './workspaceRefModel';

function normalizeOptionalLabel(raw: unknown): string | null {
    if (raw == null) return null;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
}

export function findWorkspaceRefByScope(
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>,
    scope: WorkspaceScopeBase,
): WorkspaceRefV1 | null {
    const result = resolveWorkspaceRefByScope(workspaceRefs, scope);
    return result.kind === 'resolved' ? result.ref : null;
}

export const workspaceRefResolutionContextV1 = {
    normalizeServerId: resolveServerProfileScopeIdForIdentifier,
    normalizeRootPath: (path: string) => normalizeWorkspaceRootPath(path),
};

const resolutionContext = workspaceRefResolutionContextV1;

/** Accepted Project anchors, not optional repository/Source enrichment, associate checkouts. */
export function sameWorkspaceProject(left: WorkspaceRefV1, right: WorkspaceRefV1): boolean {
    const a = projectWorkspaceRefV1(left);
    const b = projectWorkspaceRefV1(right);
    return resolveServerProfileScopeIdForIdentifier(a.serverId) === resolveServerProfileScopeIdForIdentifier(b.serverId)
        && a.projectKey === b.projectKey;
}

export function resolveWorkspaceRefByScope(workspaceRefs: readonly WorkspaceRefV1[], scope: WorkspaceScopeBase) {
    return resolveWorkspaceRefV1(workspaceRefs, scope, resolutionContext);
}

/** Resolve accepted checkout authority; never manufacture a ref from a selected root. */
export function resolveProjectCheckoutWorkspaceRef(
    workspaceRefs: readonly WorkspaceRefV1[],
    projectRef: WorkspaceRefV1,
    rootPath: string,
): WorkspaceRefV1 | null {
    const selected = resolveWorkspaceRefByScope(workspaceRefs, {
        serverId: projectRef.serverId, machineId: projectRef.machineId, rootPath,
    });
    return selected.kind === 'resolved' && sameWorkspaceProject(selected.ref, projectRef) ? selected.ref : null;
}

export function resolveWorkspaceRefById(workspaceRefs: readonly WorkspaceRefV1[], id: string, serverId?: string) {
    return resolveWorkspaceRefV1(workspaceRefs, { id, ...(serverId !== undefined ? { serverId } : {}) }, resolutionContext);
}

export function resolveWorkspaceRefByAddress(workspaceRefs: readonly WorkspaceRefV1[], address: WorkspaceAddressV1) {
    return resolveWorkspaceRefV1(workspaceRefs, address, resolutionContext);
}

export function upsertWorkspaceRefByScope(
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>,
    input: Readonly<{
        scope: WorkspaceScopeBase;
        nowMs: number;
        patch: Partial<Pick<WorkspaceRefV1, 'label' | 'lastOpenedAtMs' | 'repositoryIdentity' | 'source'>>;
    }>,
): WorkspaceRefV1[] {
    const normalized = normalizeWorkspaceScopeBase(input.scope);
    if (!normalized) return [...workspaceRefs];

    const resolution = resolveWorkspaceRefByScope(workspaceRefs, normalized);
    if (resolution.kind === 'ambiguous') throw Object.assign(new Error('Workspace scope is ambiguous'), { code: 'workspace_ref_ambiguous' });
    const existing = resolution.kind === 'resolved' ? resolution.ref : null;

    // Remembering an open does not enrich or normalize an accepted structural row.
    if (existing && input.patch.label === undefined && input.patch.repositoryIdentity === undefined && input.patch.source === undefined) {
        const next = input.patch.lastOpenedAtMs === undefined ? existing : { ...existing, lastOpenedAtMs: input.patch.lastOpenedAtMs };
        return workspaceRefs.map(ref => ref === existing ? next : ref);
    }

    const base = existing ?? {
        id: randomUUID(),
        serverId: normalized.serverId,
        machineId: normalized.machineId,
        rootPath: normalized.rootPath,
        label: null,
        createdAtMs: Math.floor(input.nowMs),
        lastOpenedAtMs: null,
    };

    const facts = {
        ...(input.patch.repositoryIdentity ? { repositoryIdentity: input.patch.repositoryIdentity } : {}),
        ...(input.patch.source ? { source: input.patch.source } : {}),
    };
    const next = WorkspaceRefV1WriteSchema.parse({
        ...enrichWorkspaceRefV1(base, facts),
        projectKey: existing ? existing.projectKey ?? existing.id : resolveWorkspaceProjectKeyV1(workspaceRefs, { ...base, ...facts }, resolutionContext),
        label: input.patch.label !== undefined ? normalizeOptionalLabel(input.patch.label) : base.label ?? null,
        lastOpenedAtMs: input.patch.lastOpenedAtMs !== undefined ? input.patch.lastOpenedAtMs : base.lastOpenedAtMs ?? null,
    });

    return existing ? workspaceRefs.map(ref => ref === existing ? next : ref) : [...workspaceRefs, next];
}

export type WorkspaceRefRelationshipReference = Readonly<{
    relationshipId: string;
    alphaWorkspaceRefId: string;
    betaWorkspaceRefId: string;
}>;

export type WorkspaceRefRemoval =
    | Readonly<{ ok: true; workspaceRefs: WorkspaceRefV1[] }>
    | Readonly<{ ok: false; code: 'workspace_ref_ambiguous' | 'workspace_ref_invalid' }>
    | Readonly<{ ok: false; code: 'workspace_ref_in_use'; relationshipIds: readonly string[] }>;

export type WorkspaceRefAccountRemovalResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; code: 'workspace_ref_ambiguous' | 'workspace_ref_invalid' }>
    | Readonly<{ ok: false; code: 'workspace_ref_in_use'; relationshipIds: readonly string[] }>
    | Readonly<{ ok: false; code: 'workspace_settings_unreadable' }>;

export type WorkspaceRefAccountMutation =
    | Readonly<{
        kind: 'upsert';
        scope: WorkspaceScopeBase;
        nowMs: number;
        patch: Partial<Pick<WorkspaceRefV1, 'label' | 'lastOpenedAtMs' | 'repositoryIdentity' | 'source'>>;
    }>
    | Readonly<{
        kind: 'set_label';
        serverId: string;
        workspaceRefId: string;
        label: string | null;
    }>
    | Readonly<{
        kind: 'set_pinned';
        serverId: string;
        workspaceRefId: string;
        pinned: boolean;
    }>
    | Readonly<{
        kind: 'migrate_label';
        scope: WorkspaceScopeBase;
        nowMs: number;
        legacyKey: string;
        label: string;
    }>
    | Readonly<{
        kind: 'remove';
        serverId: string;
        workspaceRefId: string;
    }>;

export type WorkspaceRefAccountMutationResult = WorkspaceRefAccountRemovalResult
    | Readonly<{ ok: true; workspaceRefId: string }>
    | Readonly<{ ok: true; workspaceRefId?: string; migrated: false }>
    | Readonly<{ ok: true; workspaceRefId: string; migrated: true }>
    | Readonly<{ ok: false; code: 'workspace_ref_not_found' }>;

/**
 * A Project may own its own reference and label, but a workspace-sync
 * relationship resolves both of its endpoints through persisted `WorkspaceRef`
 * ids. Removing a referenced ref would leave the relationship pointing at an
 * endpoint the daemon can no longer resolve, so removal fails closed here and
 * the caller must stop syncing through the daemon relationship owner first.
 * A paused relationship still holds its endpoints and still blocks removal.
 */
export function resolveWorkspaceRefRemoval(
    workspaceRefs: ReadonlyArray<WorkspaceRefV1>,
    input: Readonly<{
        serverId: string;
        workspaceRefId: string;
        relationships: ReadonlyArray<WorkspaceRefRelationshipReference>;
    }>,
): WorkspaceRefRemoval {
    try {
        return { ok: true, workspaceRefs: [...resolveProjectAccountWorkspaceRefRemovalV1(
            { workspaceRefs, relationships: input.relationships }, input, resolutionContext,
        )] };
    } catch (error) {
        if (typeof error === 'object' && error !== null && 'code' in error) {
            if (error.code === 'workspace_ref_ambiguous' || error.code === 'workspace_ref_invalid') return { ok: false, code: error.code };
            if (error.code === 'workspace_ref_in_use' && 'relationshipIds' in error && Array.isArray(error.relationshipIds)) {
                return { ok: false, code: 'workspace_ref_in_use', relationshipIds: error.relationshipIds.filter((id: unknown): id is string => typeof id === 'string') };
            }
        }
        throw error;
    }
}
