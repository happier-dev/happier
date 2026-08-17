import type {
    AutocompleteSuggestion,
    AutocompleteSuggestionUpdate,
} from '@/components/autocomplete/autocompleteTypes';
import type {
    ComposerReferenceSearchHost,
    ComposerSuggestionKindId,
} from '@/components/autocomplete/composerSuggestionKinds';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import type { PluginContributedActionDescriptor } from '@/components/plugins/actions/pluginContributedActionController';
import { resolveWorkspaceTargetForSession } from '@/sync/domains/session/resolveWorkspaceTargetForSession';

/**
 * How a composer attached to an EXISTING session asks for suggestions.
 *
 * There are three such hosts (session view, automation composer, participant composer) and
 * they differ in exactly one thing that matters here: their eligible-kind subset (R-9).
 * Everything else — including which machine and folder the file search is addressed to — is a
 * property of the session, not of the host, so it is decided here once.
 *
 * That is deliberate rather than tidy. `workspace` is optional on `getSuggestions` (the
 * new-session composer legitimately has no folder yet), so a host that resolved the scope
 * itself could silently stop passing it and the only symptom would be an empty `@` picker
 * with no test signal anywhere. Hosts cannot forget what they never pass.
 */
export function resolveSessionComposerSuggestions(
    sessionId: string,
    query: string,
    options: Readonly<{
        kinds: readonly ComposerSuggestionKindId[];
        signal: AbortSignal;
        composerReferenceHost?: ComposerReferenceSearchHost | null;
        contributedActions?: readonly PluginContributedActionDescriptor[];
        onUpdate?: AutocompleteSuggestionUpdate;
    }>,
): Promise<AutocompleteSuggestion[]> {
    return getSuggestions(sessionId, query, {
        kinds: options.kinds,
        // Files are workspace state, not session state: the session supplies the machine and
        // the folder, and the search is addressed by those. Resolved per call, not captured,
        // so a session that only becomes resolvable mid-composition starts offering files
        // without needing the host to rerender.
        workspace: resolveWorkspaceTargetForSession(sessionId),
        signal: options.signal,
        composerReferenceHost: options.composerReferenceHost,
        contributedActions: options.contributedActions,
        onUpdate: options.onUpdate,
    });
}
