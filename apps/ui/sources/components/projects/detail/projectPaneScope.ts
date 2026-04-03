export function buildProjectPaneScopeId(workspaceRefId: string): string {
    const id = String(workspaceRefId ?? '').trim();
    return `project:${id || 'unknown'}`;
}
