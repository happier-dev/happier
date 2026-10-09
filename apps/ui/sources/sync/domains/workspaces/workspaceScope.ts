import { normalizeWorkspaceRootPathV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { resolveAbsolutePath } from '@/utils/path/pathUtils';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

export type WorkspaceScope = Readonly<{
    serverId: string;
    machineId: string;
    rootPath: string;
    sessionId?: string | null;
}>;

export type WorkspaceScopeBase = Readonly<{
    serverId: string;
    machineId: string;
    rootPath: string;
}>;

export type WorkspaceCacheKey = string;

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
    return { serverId, machineId, rootPath };
}

export function tryBuildWorkspaceCacheKey(scope: WorkspaceScopeBase): WorkspaceCacheKey | null {
    const normalized = normalizeWorkspaceScopeBase(scope);
    if (!normalized) return null;
    return `${normalized.serverId}:${normalized.machineId}:${normalized.rootPath}`;
}

export function buildWorkspaceCacheKey(scope: WorkspaceScopeBase): WorkspaceCacheKey {
    const key = tryBuildWorkspaceCacheKey(scope);
    if (!key) {
        throw new Error('Cannot build WorkspaceCacheKey from invalid scope');
    }
    return key;
}
