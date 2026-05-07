import { normalizeFileSystemPath } from '@/sync/domains/fileSystem/normalizeFileSystemPath';

export type WorkspaceScopeBase = Readonly<{
    serverId: string;
    machineId: string;
    rootPath: string;
}>;

export type WorkspaceCacheKey = string;

function normalizeId(raw: unknown): string {
    return String(raw ?? '').trim();
}

function collapseRepeatedSlashesPreservingUncPrefix(path: string): string {
    const trimmed = path.trim();
    if (!trimmed) return '';

    if (trimmed.startsWith('//')) {
        return `//${trimmed.slice(2).replace(/\/{2,}/g, '/')}`;
    }

    const driveCollapsed = trimmed.replace(/^([a-z]:)\/{2,}/i, (_match, drive: string) => `${drive}/`);
    return driveCollapsed.replace(/\/{2,}/g, '/');
}

export function normalizeWorkspaceRootPath(value: unknown): string | null {
    const rawRootPath = normalizeFileSystemPath(value);
    return rawRootPath ? collapseRepeatedSlashesPreservingUncPrefix(rawRootPath) : null;
}

export function normalizeWorkspaceScopeBase(input: WorkspaceScopeBase): WorkspaceScopeBase | null {
    const serverId = normalizeId(input.serverId);
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
