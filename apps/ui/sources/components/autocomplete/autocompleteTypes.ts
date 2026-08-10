import type * as React from 'react';
import type { ComposerStructuredInputMentionPayload } from '@/components/sessions/agentInput/structuredInputMentions';
import type { PromptInvocationSuggestionMetadata } from '@/sync/domains/input/slashCommands/promptInvocationSuggestion';
import type { ComposerSuggestionKindId } from './composerSuggestionGrammar';

export type AutocompleteSuggestion = Readonly<{
    /** The registry kind that produced this candidate. */
    kind: ComposerSuggestionKindId;
    key: string;
    text: string;
    label?: string;
    description?: string;
    component?: React.ElementType;
    rowHeight?: number;
    /**
     * Structured payload carried into the composer mention list on selection.
     * This is the canonical composer mention shape minus its positional fields —
     * it is deliberately NOT a second declaration of the same union.
     */
    structuredInput?: ComposerStructuredInputMentionPayload;
    promptInvocation?: PromptInvocationSuggestionMetadata;
}>;
