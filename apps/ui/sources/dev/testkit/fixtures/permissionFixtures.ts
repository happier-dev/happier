import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';

export function createPermissionModeFixture(mode: PermissionMode = 'default'): PermissionMode {
    return mode;
}

export function createPermissionModeListFixture(
    modes: readonly PermissionMode[] = ['default', 'safe-yolo', 'yolo'],
): PermissionMode[] {
    return [...modes];
}
