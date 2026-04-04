import { resolveWorkspaceDisplayLabel } from '@/sync/domains/workspaces/workspaceLabel';
import type { WorkspaceRefV1 } from '@/sync/domains/workspaces/workspaceRefModel';

function resolvePathBasename(rawPath: string): string | null {
    const trimmed = String(rawPath ?? '').trim().replace(/[\\/]+$/, '');
    if (!trimmed) return null;
    const parts = trimmed.split(/[/\\]/g).filter(Boolean);
    return parts.length > 0 ? (parts[parts.length - 1] ?? null) : null;
}

export function resolveWorkspaceRefDisplayName(workspaceRef: WorkspaceRefV1): string {
    return resolveWorkspaceDisplayLabel({
        scope: {
            serverId: workspaceRef.serverId,
            machineId: workspaceRef.machineId,
            rootPath: workspaceRef.rootPath,
        },
        workspaceRef,
        fallbackPathLabel: resolvePathBasename(workspaceRef.rootPath) ?? workspaceRef.rootPath,
    });
}
