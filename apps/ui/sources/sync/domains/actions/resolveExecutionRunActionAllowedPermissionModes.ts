import type { ActionId } from '@happier-dev/protocol';

import type { PermissionMode } from '@/sync/domains/permissions/permissionTypes';

export function resolveExecutionRunActionAllowedPermissionModes(actionId: ActionId): readonly PermissionMode[] | null {
    if (actionId === 'review.start' || actionId === 'subagents.plan.start') {
        return ['read-only'];
    }
    return null;
}
