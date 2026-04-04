import type { WorkspaceScopeBase } from '@/sync/domains/workspaces/workspaceScope';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';

export function resolveWorkspaceScopeForSession(sessionId: string): WorkspaceScopeBase | null {
    return resolveWorkspaceTargetForSession(sessionId);
}
