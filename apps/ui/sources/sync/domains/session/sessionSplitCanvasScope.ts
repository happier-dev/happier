import type { WorkspaceTargetForSession } from './resolveWorkspaceTargetForSession';
import {
    normalizeWorkspaceRootPath,
    tryBuildWorkspaceCacheKey,
} from '@/sync/domains/workspaces/workspaceScope';

export type SessionSplitCanvasScope = Readonly<{
    workspaceCacheKey: string;
    serverId: string;
    machineId: string;
    rootPath: string;
}>;

function normalizeServerId(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

export function resolveSessionSplitCanvasScope(
    target: WorkspaceTargetForSession | null | undefined,
    options?: Readonly<{
        routeServerId?: string | null;
    }>,
): SessionSplitCanvasScope | null {
    if (!target) {
        return null;
    }

    const serverId = normalizeServerId(options?.routeServerId) || normalizeServerId(target.serverId);
    const machineId = String(target.machineId ?? '').trim();
    const rootPath = normalizeWorkspaceRootPath(target.rootPath);
    if (!serverId || !machineId || !rootPath) {
        return null;
    }

    const workspaceCacheKey = tryBuildWorkspaceCacheKey({
        serverId,
        machineId,
        rootPath,
    });
    if (!workspaceCacheKey) {
        return null;
    }

    return {
        workspaceCacheKey,
        serverId,
        machineId,
        rootPath,
    };
}

export function resolveSessionSplitCanvasScopeKey(
    scope: SessionSplitCanvasScope | null | undefined,
): string | null {
    return scope?.workspaceCacheKey ?? null;
}

export function areSessionSplitCanvasScopesCompatible(
    left: SessionSplitCanvasScope | null | undefined,
    right: SessionSplitCanvasScope | null | undefined,
): boolean {
    const leftKey = resolveSessionSplitCanvasScopeKey(left);
    const rightKey = resolveSessionSplitCanvasScopeKey(right);
    return Boolean(leftKey && rightKey && leftKey === rightKey);
}
