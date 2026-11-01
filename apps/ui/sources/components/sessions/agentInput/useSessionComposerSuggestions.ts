import * as React from 'react';
import type { AgentSessionCompactionCapability } from '@happier-dev/protocol/plugins/agents';
import type { ActiveSuggestionsHandler } from '@/components/autocomplete/useActiveSuggestions';
import { listCurrentComposerReferences, type ComposerReferenceSearchHost, type ComposerSuggestionKindId } from '@/components/autocomplete/composerSuggestionKinds';
import type { ComposerSuggestionTrigger } from '@/components/autocomplete/composerSuggestionGrammar';
import type { PluginContributedActionDescriptor } from '@/components/plugins/actions/pluginContributedActionController';
import type { SkillComposerSource } from '@/sync/domains/skills/skillComposerGroups';
import { resolveSessionComposerSuggestions } from './sessionComposerSuggestions';

/** Keep each active query tied to the native source and declared references it actually consumes. */
export function useSessionComposerSuggestions(options: Readonly<{
    sessionId: string;
    kinds: readonly ComposerSuggestionKindId[];
    composerReferenceHost: ComposerReferenceSearchHost | null;
    actionController: Readonly<{ listSlashCommands(): readonly PluginContributedActionDescriptor[] }>;
    skillSource: SkillComposerSource | null;
    compaction?: AgentSessionCompactionCapability | null;
}>): Readonly<Record<ComposerSuggestionTrigger, ActiveSuggestionsHandler>> {
    const { sessionId, kinds, composerReferenceHost, actionController, skillSource, compaction } = options;
    const references = React.useMemo(() => composerReferenceHost && kinds.includes('composerReference')
        ? listCurrentComposerReferences(composerReferenceHost.projection) : [], [composerReferenceHost, kinds]);
    const atHost = references.some(({ presentation }) => presentation.triggers.includes('@')) ? composerReferenceHost : null;
    const skillHost = references.some(({ presentation }) => presentation.triggers.includes('$')) ? composerReferenceHost : null;
    const slashHost = references.some(({ presentation }) => presentation.triggers.includes('/')) ? composerReferenceHost : null;
    const at = React.useCallback<ActiveSuggestionsHandler>((query, signal, onUpdate) => resolveSessionComposerSuggestions(sessionId, query, {
        kinds, signal, onUpdate, composerReferenceHost: atHost,
    }), [sessionId, kinds, atHost]);
    const skill = React.useCallback<ActiveSuggestionsHandler>((query, signal, onUpdate) => resolveSessionComposerSuggestions(sessionId, query, {
        kinds, signal, onUpdate, composerReferenceHost: skillHost, skillSource,
    }), [sessionId, kinds, skillHost, skillSource]);
    const slash = React.useCallback<ActiveSuggestionsHandler>((query, signal, onUpdate) => resolveSessionComposerSuggestions(sessionId, query, {
        kinds, signal, onUpdate, composerReferenceHost: slashHost, contributedActions: actionController.listSlashCommands(),
        compaction,
    }), [sessionId, kinds, slashHost, actionController, compaction]);
    return React.useMemo(() => ({ '@': at, '$': skill, '/': slash }), [at, skill, slash]);
}
