import type { ActionId } from '@happier-dev/protocol';

import type { ExecutionRunActionPermissionMode } from './executionRunActionPermissionMode';

export function resolveExecutionRunActionAllowedPermissionModes(actionId: ActionId): readonly ExecutionRunActionPermissionMode[] | null {
    if (actionId === 'review.start' || actionId === 'subagents.plan.start') {
        return ['read_only'];
    }
    return null;
}
