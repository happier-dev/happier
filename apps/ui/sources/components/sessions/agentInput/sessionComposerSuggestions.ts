import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import type { ComposerSuggestionKindId } from '@/components/autocomplete/composerSuggestionKinds';
import { getSuggestions } from '@/components/autocomplete/suggestions';
import { resolveSessionFileSuggestionScope } from '@/sync/ops/resolveSessionFileSuggestionScope';

/**
 * How a composer attached to an EXISTING session asks for suggestions.
 *
 * There are three such hosts (session view, automation composer, participant composer) and they
 * differ in exactly one thing: their eligible-kind subset (R-9). Everything else — including
 * which machine and folder the file search is addressed to — is a property of the session, not
 * of the host, so it is decided here once.
 *
 * That is deliberate rather than tidy. `workspace` is optional on `getSuggestions` (the
 * new-session composer legitimately has no folder yet), so a host that resolved the scope
 * itself could silently stop passing it and the only symptom would be an empty `@` picker.
 * A mutation study proved that exact regression invisible: setting `workspace: null` at all
 * four hosts left 264 tests across 15 files green. Hosts cannot forget what they never pass.
 */
export function resolveSessionComposerSuggestions(
    sessionId: string,
    query: string,
    options: Readonly<{
        kinds: readonly ComposerSuggestionKindId[];
        signal: AbortSignal;
    }>,
): Promise<AutocompleteSuggestion[]> {
    return getSuggestions(sessionId, query, {
        kinds: options.kinds,
        // Files are workspace state, not session state: the session supplies the machine and
        // the folder, and the search is addressed by those. Resolved per call, not captured,
        // so a session that only becomes reachable mid-composition starts offering files
        // without needing the host to rerender.
        workspace: resolveSessionFileSuggestionScope(sessionId),
        signal: options.signal,
    });
}
