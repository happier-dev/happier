import type * as React from 'react';
import type { ComposerStructuredInputMentionPayload } from '@/components/sessions/agentInput/structuredInputMentions';
import type { PromptInvocationSuggestionMetadata } from '@/sync/domains/input/slashCommands/promptInvocationSuggestion';
import type { PluginContributedActionDescriptor } from '@/components/plugins/actions/pluginContributedActionController';
import type { ComposerSuggestionKindId } from './composerSuggestionGrammar';

export type AutocompleteSuggestion = Readonly<{
    /** The registry kind that produced this candidate. */
    kind: ComposerSuggestionKindId;
    /**
     * Stable candidate identifier within its producing kind. The picker identity
     * is the `{ kind, key }` pair, so equal local keys from distinct sections
     * can never steal the user's selection during a refresh.
     */
    key: string;
    text: string;
    label?: string;
    /** An owner-declared section title, replacing the kind's generic heading. */
    group?: string;
    description?: string;
    /** An owner-declared icon for the primitive CommandMenu row. */
    icon?: React.ReactNode;
    component?: React.ElementType;
    rowHeight?: number;
    /**
     * Structured payload carried into the composer mention list on selection.
     * This is the canonical composer mention shape minus its positional fields —
     * it is deliberately NOT a second declaration of the same union (SB-4).
     */
    structuredInput?: ComposerStructuredInputMentionPayload;
    promptInvocation?: PromptInvocationSuggestionMetadata;
    /** An already controller-admitted external Action, never a local command handler. */
    pluginContributedAction?: PluginContributedActionDescriptor;
}>;

/**
 * A current query's aggregate snapshot. The suggestion controller owns which
 * snapshot becomes visible and whether it may still alter selection state.
 */
export type AutocompleteSuggestionUpdate = (
    suggestions: AutocompleteSuggestion[],
    status?: Readonly<{ complete: boolean }>,
) => void;

/**
 * The stable identity used by picker state and CommandMenu rows.
 *
 * `key` is deliberately local to a kind: built-ins may choose the clearest
 * identifier for their own catalog, while a future provider will receive its
 * qualified kind from the canonical registry rather than needing to encode a
 * second kind prefix into every candidate.
 */
export function getAutocompleteSuggestionIdentity(suggestion: AutocompleteSuggestion): string {
    return `${suggestion.kind}:${suggestion.key}`;
}
