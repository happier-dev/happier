import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';

export type ExecutionRunActionPermissionMode = 'read_only' | 'default' | 'workspace_write' | 'yolo';

export function toExecutionRunActionPermissionMode(mode: PermissionMode): ExecutionRunActionPermissionMode {
    if (mode === 'read-only' || mode === 'plan') return 'read_only';
    if (mode === 'safe-yolo' || mode === 'acceptEdits') return 'workspace_write';
    if (mode === 'yolo' || mode === 'bypassPermissions') return 'yolo';
    return 'default';
}

export function normalizeExecutionRunActionPermissionMode(value: unknown): unknown {
    if (value === 'read_only' || value === 'default' || value === 'workspace_write' || value === 'yolo') {
        return value;
    }
    if (
        value === 'read-only'
        || value === 'plan'
        || value === 'safe-yolo'
        || value === 'acceptEdits'
        || value === 'bypassPermissions'
    ) {
        return toExecutionRunActionPermissionMode(value);
    }
    return value;
}
