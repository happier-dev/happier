import type { ActionId } from '@happier-dev/protocol';

export function isExecutionRunsFeatureAction(actionId: ActionId): boolean {
    return actionId === 'review.start'
        || actionId.startsWith('execution.run.')
        || actionId.startsWith('subagents.')
        || actionId === 'voice_agent.start';
}
