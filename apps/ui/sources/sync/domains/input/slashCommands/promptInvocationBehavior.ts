import type { PromptInvocationBehaviorV1 } from '@happier-dev/protocol/prompts/library/promptInvocationsV1';

export function resolvePromptInvocationComposerSendAction(
    behavior: PromptInvocationBehaviorV1,
): 'insert' | 'send' {
    return behavior === 'insert_and_send' ? 'send' : 'insert';
}

export function shouldInsertPromptInvocationOnAutocompleteSelect(
    behavior: PromptInvocationBehaviorV1,
): boolean {
    return behavior === 'insert';
}
