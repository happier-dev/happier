import { qualifyPaneScopeId, readResourcePaneScopeId } from '@/components/appShell/panes/paneScopeIdentity';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';

export function buildProjectPaneScopeId(workspaceRefId: string, serverId?: string | null, instanceKey?: string | null): string {
    const id = String(workspaceRefId ?? '').trim();
    const home = serverId?.trim() ? resolveServerProfileScopeIdForIdentifier(serverId) : null;
    const baseScopeId = home ? `project:${encodeURIComponent(home)}:${encodeURIComponent(id || 'unknown')}` : `project:${id || 'unknown'}`;
    return qualifyPaneScopeId(baseScopeId, instanceKey);
}

/** Parsing identifies a pane; current Account checkout resolution still supplies authority. */
export function parseProjectPaneScopeId(scopeId: string): Readonly<{ serverId: string; workspaceRefId: string }> | null {
    const resourceId = readResourcePaneScopeId(scopeId);
    const parts = resourceId.split(':');
    if (parts.length !== 3 || parts[0] !== 'project') return null;
    try {
        const serverId = decodeURIComponent(parts[1]);
        const workspaceRefId = decodeURIComponent(parts[2]);
        return serverId && workspaceRefId ? { serverId, workspaceRefId } : null;
    } catch { return null; }
}
