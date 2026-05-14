import { normalizeWorkspaceRootPath } from '@/sync/domains/workspaces/workspaceScope';

import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionFolderWorkspaceRefV1 } from './types';

function normalizeString(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized ? normalized : null;
}

export function normalizeSessionFolderWorkspaceRef(value: unknown): SessionFolderWorkspaceRefV1 | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    const serverId = normalizeString(record.serverId);

    if (record.t === 'workspaceRef') {
        const workspaceRefId = normalizeString(record.workspaceRefId);
        return workspaceRefId ? { t: 'workspaceRef', serverId, workspaceRefId } : null;
    }

    if (record.t === 'workspaceScope') {
        const rootPath = normalizeWorkspaceRootPath(record.rootPath);
        if (!rootPath) return null;
        return {
            t: 'workspaceScope',
            serverId,
            machineId: normalizeString(record.machineId),
            rootPath,
        };
    }

    return null;
}

export function buildSessionFolderWorkspaceRefKey(workspace: SessionFolderWorkspaceRefV1): string {
    if (workspace.t === 'workspaceRef') {
        return `workspaceRef:${workspace.serverId ?? 'local'}:${workspace.workspaceRefId}`;
    }
    return `workspaceScope:${workspace.serverId ?? 'local'}:${workspace.machineId ?? 'unknown'}:${workspace.rootPath}`;
}

export function compareSessionFolderWorkspaceRefs(a: SessionFolderWorkspaceRefV1, b: SessionFolderWorkspaceRefV1): boolean {
    return buildSessionFolderWorkspaceRefKey(a) === buildSessionFolderWorkspaceRefKey(b);
}

export function resolveDurableWorkspaceRefForSessionListHeader(
    header: Extract<SessionListIndexItem, { type: 'header' }>,
): SessionFolderWorkspaceRefV1 | null {
    const scope = header.workspaceScopeHint;
    if (!scope) return null;
    return normalizeSessionFolderWorkspaceRef({
        t: 'workspaceScope',
        serverId: scope.serverId || header.serverId || null,
        machineId: scope.machineId,
        rootPath: scope.rootPath,
    });
}
