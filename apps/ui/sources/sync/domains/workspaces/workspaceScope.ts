import { normalizeWorkspaceRootPathV1, workspaceAddressFromRefV2 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import type { WorkspaceAddressV2 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import type { WorkspaceRefV1 } from './workspaceRefModel';

export type WorkspaceScope = WorkspaceScopeBase & Readonly<{
    sessionId?: string | null;
}>;

export type WorkspaceScopeBase = Readonly<{
    serverId: string;
    machineId: string;
    rootPath: string;
    workspace?: Extract<WorkspaceAddressV2, { kind: 'managed' }>;
}>;

export type WorkspaceCacheKey = string;

export function workspaceScopeFromProject(ref: WorkspaceRefV1, activeRootPath: string): WorkspaceScopeBase {
    const address = workspaceAddressFromRefV2(ref);
    if ('kind' in address) return { serverId: ref.serverId, machineId: address.controller.machineId,
        rootPath: address.rootPath, workspace: address };
    return { serverId: ref.serverId, machineId: address.machineId, rootPath: activeRootPath };
}

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

export function normalizeWorkspaceRootPath(value: unknown, homeDir?: string): string | null {
    return normalizeWorkspaceRootPathV1(typeof value === 'string' ? resolveAbsolutePath(value.trim(), homeDir) : value);
}

export function normalizeWorkspaceScopeBase(input: WorkspaceScopeBase): WorkspaceScopeBase | null {
    const serverId = resolveServerProfileScopeIdForIdentifier(normalizeId(input.serverId));
    const machineId = normalizeId(input.machineId);
    const rootPath = normalizeWorkspaceRootPath(input.rootPath);
    if (!serverId || !machineId || !rootPath) {
        return null;
    }
    return { serverId, machineId, rootPath, ...(input.workspace ? { workspace: input.workspace } : {}) };
}

export function tryBuildWorkspaceCacheKey(scope: WorkspaceScopeBase): WorkspaceCacheKey | null {
    const normalized = normalizeWorkspaceScopeBase(scope);
    if (!normalized) return null;
    const workspace = normalized.workspace;
    if (workspace) return JSON.stringify(['managed', normalized.serverId, workspace.workspaceId, workspace.managedId,
        workspace.controller.machineId, workspace.controller.installationId, workspace.rootPath]);
    return `${normalized.serverId}:${normalized.machineId}:${normalized.rootPath}`;
}

export function buildWorkspaceCacheKey(scope: WorkspaceScopeBase): WorkspaceCacheKey {
    const key = tryBuildWorkspaceCacheKey(scope);
    if (!key) {
        throw new Error('Cannot build WorkspaceCacheKey from invalid scope');
    }
    return key;
}
