import { ValueSync } from '@/utils/sessions/sync';
import * as React from 'react';
import {
    getAutocompleteSuggestionIdentity,
    type AutocompleteSuggestion,
    type AutocompleteSuggestionUpdate,
} from './autocompleteTypes';

/**
 * Resolves the suggestion list for the active composer token and owns which
 * candidate is selected.
 *
 * Two contracts live here:
 *
 * - **Selection tracks candidate identity, never a numeric index (INV-6/D-11).**
 *   The picker is sectioned, so a single keystroke can change how many rows the
 *   Files section contributes and push the Plugins section down. An index-based
 *   selection silently lands on a different row when that happens. The tracked
 *   identity is the candidate the *user* moved onto (`pinnedKey`) and it survives
 *   the keystroke that changes the query — that is the case D-11 names. An
 *   `autoSelectFirst` highlight is not a choice and is never pinned, so typing one
 *   more character still re-selects the best match.
 * - **One `AbortController` per query (D-15).** `ValueSync` runs its command
 *   serially: without an abort, a superseded query would keep the queue for the
 *   full duration of its slowest kind before the next keystroke even started.
 */
export type ActiveSuggestionsHandler =
    (
        query: string,
        signal: AbortSignal,
        publish: AutocompleteSuggestionUpdate,
    ) => Promise<AutocompleteSuggestion[]>;

interface SuggestionOptions {
    autoSelectFirst?: boolean; // If true, automatically select first item when suggestions appear
    wrapAround?: boolean;      // If true, wrap around when reaching top/bottom
}

type ActiveSuggestionState = Readonly<{
    query: string | null;
    suggestions: AutocompleteSuggestion[];
    selected: number;
    /** The candidate the user explicitly moved onto, or null while the highlight is automatic. */
    pinnedKey: string | null;
    /** A partial snapshot does not currently contain the user's pinned candidate. */
    selectionPending: boolean;
}>;

function sameSuggestionSnapshot(
    left: readonly AutocompleteSuggestion[],
    right: readonly AutocompleteSuggestion[],
): boolean {
    return left.length === right.length && left.every((suggestion, index) => suggestion === right[index]);
}

function unchangedSuggestionState(
    previous: ActiveSuggestionState,
    next: ActiveSuggestionState,
): ActiveSuggestionState {
    return previous.query === next.query
        && previous.selected === next.selected
        && previous.pinnedKey === next.pinnedKey
        && previous.selectionPending === next.selectionPending
        && sameSuggestionSnapshot(previous.suggestions, next.suggestions)
        ? previous
        : next;
}

function reconcileSuggestionSnapshot(params: Readonly<{
    previous: ActiveSuggestionState;
    query: string;
    suggestions: AutocompleteSuggestion[];
    complete: boolean;
    autoSelectFirst: boolean;
}>): ActiveSuggestionState {
    const { previous, query, suggestions, complete, autoSelectFirst } = params;
    if (previous.pinnedKey !== null) {
        const selected = suggestions.findIndex(
            (suggestion) => getAutocompleteSuggestionIdentity(suggestion) === previous.pinnedKey,
        );
        if (selected !== -1) {
            return unchangedSuggestionState(previous, {
                query,
                suggestions,
                selected,
                pinnedKey: previous.pinnedKey,
                selectionPending: false,
            });
        }
        if (!complete) {
            // Do not silently turn an explicit reference choice into whichever
            // earlier section happened to settle first. Arrow navigation is still
            // an intentional new choice; Enter remains inert until then.
            return unchangedSuggestionState(previous, {
                query,
                suggestions,
                selected: -1,
                pinnedKey: previous.pinnedKey,
                selectionPending: true,
            });
        }
    }

    // Nothing pinned, or a final snapshot proves the pinned candidate is gone.
    // Within one query the previous position is still meaningful; across a query
    // change the list restarts at the best match.
    const previousSelected = previous.query === query ? previous.selected : -1;
    const selected = Math.min(previousSelected, suggestions.length - 1);
    return unchangedSuggestionState(previous, {
        query,
        suggestions,
        selected: selected < 0 && suggestions.length > 0 && autoSelectFirst ? 0 : selected,
        pinnedKey: null,
        selectionPending: false,
    });
}

export function useActiveSuggestions(
    query: string | null,
    handler: ActiveSuggestionsHandler,
    options: SuggestionOptions = {}
) {
    const {
        autoSelectFirst = true,
        wrapAround = true
    } = options;

    // State for suggestions
    const [state, setState] = React.useState<ActiveSuggestionState>({
        query: null,
        suggestions: [],
        selected: -1,
        pinnedKey: null,
        selectionPending: false,
    });
    const stateRef = React.useRef(state);
    stateRef.current = state;
    const activeSyncRef = React.useRef<ValueSync<string | null> | null>(null);
    const inFlightRef = React.useRef<AbortController | null>(null);

    const moveUp = React.useCallback(() => {
        const previous = stateRef.current;
        if (previous.suggestions.length === 0) return;

        // At top or nothing selected: wrap to the bottom, or stay on the first row.
        const selected = previous.selected <= 0
            ? (wrapAround ? previous.suggestions.length - 1 : 0)
            : previous.selected - 1;
        const next: ActiveSuggestionState = {
            ...previous,
            selected,
            pinnedKey: previous.suggestions[selected]
                ? getAutocompleteSuggestionIdentity(previous.suggestions[selected])
                : null,
            selectionPending: false,
        };
        stateRef.current = next;
        setState(next);
    }, [wrapAround]);

    const moveDown = React.useCallback(() => {
        const previous = stateRef.current;
        if (previous.suggestions.length === 0) return;

        // At bottom: wrap to the top, or stay on the last row. Nothing selected: select first.
        const selected = previous.selected >= previous.suggestions.length - 1
            ? (wrapAround ? 0 : previous.suggestions.length - 1)
            : previous.selected < 0 ? 0 : previous.selected + 1;
        const next: ActiveSuggestionState = {
            ...previous,
            selected,
            pinnedKey: previous.suggestions[selected]
                ? getAutocompleteSuggestionIdentity(previous.suggestions[selected])
                : null,
            selectionPending: false,
        };
        stateRef.current = next;
        setState(next);
    }, [wrapAround]);

    // Sync query to suggestions
    const sync = React.useMemo(() => {
        let ownSync!: ValueSync<string | null>;
        ownSync = new ValueSync<string | null>(async (nextQuery) => {
            if (!nextQuery) {
                const previous = stateRef.current;
                if (
                    previous.query === null
                    && previous.suggestions.length === 0
                    && previous.selected === -1
                    && previous.pinnedKey === null
                    && !previous.selectionPending
                ) {
                    return;
                }
                const next: ActiveSuggestionState = {
                    query: null,
                    suggestions: [],
                    selected: -1,
                    pinnedKey: null,
                    selectionPending: false,
                };
                stateRef.current = next;
                setState(next);
                return;
            }
            const controller = new AbortController();
            inFlightRef.current = controller;
            // A handler may retain the incremental publisher after its promise
            // settles. The resolved snapshot is the terminal authority for this
            // query, so later callbacks must not overwrite it.
            let acceptsPublications = true;
            const publish: AutocompleteSuggestionUpdate = (suggestions, status) => {
                if (!acceptsPublications || controller.signal.aborted || activeSyncRef.current !== ownSync) return;
                const previous = stateRef.current;
                const next = reconcileSuggestionSnapshot({
                    previous,
                    query: nextQuery,
                    suggestions,
                    complete: status?.complete === true,
                    autoSelectFirst,
                });
                if (next === previous) return;
                stateRef.current = next;
                setState(next);
            };
            let suggestions: AutocompleteSuggestion[];
            try {
                suggestions = await handler(nextQuery, controller.signal, publish);
            } catch (error) {
                acceptsPublications = false;
                // Abort-capable providers commonly reject their promise when the
                // query is superseded. That is normal settlement, not a handler
                // failure: letting it escape would make ValueSync retry the stale
                // query and starve the newer value behind its serial queue.
                if (controller.signal.aborted || activeSyncRef.current !== ownSync) {
                    return;
                }
                throw error;
            } finally {
                if (inFlightRef.current === controller) {
                    inFlightRef.current = null;
                }
            }
            // A superseded query never reaches state, even if its work completed.
            if (controller.signal.aborted || activeSyncRef.current !== ownSync) {
                acceptsPublications = false;
                return;
            }
            publish(suggestions, { complete: true });
            acceptsPublications = false;
        });
        return ownSync;
    }, [autoSelectFirst, handler]);

    React.useEffect(() => {
        activeSyncRef.current = sync;
        return () => {
            if (activeSyncRef.current === sync) {
                activeSyncRef.current = null;
            }
            inFlightRef.current?.abort();
            inFlightRef.current = null;
            sync.stop();
        };
    }, [sync]);

    React.useEffect(() => {
        inFlightRef.current?.abort();
        sync.setValue(query);
    }, [query, sync]);

    // If no query return empty suggestions
    if (!query || state.query !== query) {
        return [[], -1, moveUp, moveDown, false] as const;
    }

    // Return state suggestions
    return [state.suggestions, state.selected, moveUp, moveDown, state.selectionPending] as const;
}
