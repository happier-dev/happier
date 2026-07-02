export type ClaudeSdkPermissionPolicy =
    | 'no_tools'
    | 'read_only'
    | 'workspace_write'
    | 'parent_session_prompt';

export function resolveClaudeExecutionRunPermissionPolicy(raw: unknown): ClaudeSdkPermissionPolicy {
    const mode = String(raw ?? '').trim();
    if (!mode) return 'read_only';
    if (mode === 'no_tools' || mode === 'read_only' || mode === 'workspace_write') return mode;
    if (mode === 'read-only') return 'read_only';
    if (
        mode === 'safe-yolo'
        || mode === 'yolo'
        || mode === 'acceptEdits'
        || mode === 'bypassPermissions'
        || mode === 'workspace-write'
        || mode === 'auto'
    ) {
        return 'parent_session_prompt';
    }
    return 'read_only';
}
