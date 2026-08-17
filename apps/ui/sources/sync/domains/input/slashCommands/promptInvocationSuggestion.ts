import type { PromptInvocationBehaviorV1 } from '@happier-dev/protocol';

import { expandPromptTemplateInvocation } from '@/sync/domains/input/slashCommands/expandPromptTemplateInvocation';
import { shouldInsertPromptInvocationOnAutocompleteSelect } from '@/sync/domains/input/slashCommands/promptInvocationBehavior';

export type PromptInvocationSuggestionMetadata = Readonly<{
    invocationId: string;
    token: string;
    targetArtifactId: string;
    behavior: PromptInvocationBehaviorV1;
    allowArgs: boolean;
}>;

export async function resolvePromptInvocationAutocompleteSelection(params: Readonly<{
    input: string;
    selection: Readonly<{ start: number; end: number }>;
    /**
     * Only the token span is read. Kept structural so the composer-suggestion
     * registry can hand over its own span without importing `ActiveWord`.
     */
    activeWord: Readonly<{ offset: number; endOffset: number }> | undefined;
    suggestion: Readonly<{
        text: string;
        promptInvocation?: PromptInvocationSuggestionMetadata;
    }>;
}>): Promise<Readonly<{
    handled: boolean;
    text?: string;
    cursorPosition?: number;
}>> {
    const promptInvocation = params.suggestion.promptInvocation;
    if (!promptInvocation) {
        return { handled: false };
    }

    if (!shouldInsertPromptInvocationOnAutocompleteSelect(promptInvocation.behavior)) {
        return { handled: false };
    }

    const activeWord = params.activeWord;
    if (!activeWord) {
        return { handled: false };
    }

    const expanded = await expandPromptTemplateInvocation({
        targetArtifactId: promptInvocation.targetArtifactId,
        argsText: '',
    });
    const replacementStart = activeWord.offset;
    const replacementEnd = activeWord.endOffset;
    const text = `${params.input.slice(0, replacementStart)}${expanded}${params.input.slice(replacementEnd)}`;
    const cursorPosition = replacementStart + expanded.length;

    return {
        handled: true,
        text,
        cursorPosition,
    };
}
