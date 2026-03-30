import type { ActionId } from '@happier-dev/protocol';

export function resolveExecutionRunActionDefaultPermissionMode(actionId: ActionId): string | null {
    if (actionId === 'review.start' || actionId === 'subagents.plan.start') {
        return 'read-only';
    }
    if (actionId === 'subagents.delegate.start') {
        return 'safe-yolo';
    }
    return null;
}
