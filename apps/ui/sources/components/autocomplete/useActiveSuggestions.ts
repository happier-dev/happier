import { ValueSync } from '@/utils/sessions/sync';
import * as React from 'react';
import type { AutocompleteSuggestion } from './autocompleteTypes';

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
    (query: string, signal: AbortSignal) => Promise<AutocompleteSuggestion[]>;

interface SuggestionOptions {
    autoSelectFirst?: boolean; // If true, automatically select first item when suggestions appear
    wrapAround?: boolean;      // If true, wrap around when reaching top/bottom
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
    const [state, setState] = React.useState<{
        query: string | null;
        suggestions: AutocompleteSuggestion[];
        selected: number,
        /** The candidate the user explicitly moved onto, or null while the highlight is automatic. */
        pinnedKey: string | null,
    }>({
        query: null,
        suggestions: [],
        selected: -1,
        pinnedKey: null
    });
    const activeSyncRef = React.useRef<ValueSync<string | null> | null>(null);
    const inFlightRef = React.useRef<AbortController | null>(null);

    const moveUp = React.useCallback(() => {
        setState((prev) => {
            if (prev.suggestions.length === 0) return prev;

            // At top or nothing selected: wrap to the bottom, or stay on the first row.
            const next = prev.selected <= 0
                ? (wrapAround ? prev.suggestions.length - 1 : 0)
                : prev.selected - 1;
            return { ...prev, selected: next, pinnedKey: prev.suggestions[next]?.key ?? null };
        });
    }, [wrapAround]);

    const moveDown = React.useCallback(() => {
        setState((prev) => {
            if (prev.suggestions.length === 0) return prev;

            // At bottom: wrap to the top, or stay on the last row. Nothing selected: select first.
            const next = prev.selected >= prev.suggestions.length - 1
                ? (wrapAround ? 0 : prev.suggestions.length - 1)
                : prev.selected < 0 ? 0 : prev.selected + 1;
            return { ...prev, selected: next, pinnedKey: prev.suggestions[next]?.key ?? null };
        });
    }, [wrapAround]);

    // Sync query to suggestions
    const sync = React.useMemo(() => {
        let ownSync!: ValueSync<string | null>;
        ownSync = new ValueSync<string | null>(async (nextQuery) => {
            if (!nextQuery) {
                setState((prev) => (
                    prev.query === null && prev.suggestions.length === 0
                        && prev.selected === -1 && prev.pinnedKey === null
                        ? prev
                        : { query: null, suggestions: [], selected: -1, pinnedKey: null }
                ));
                return;
            }
            const controller = new AbortController();
            inFlightRef.current = controller;
            let suggestions: AutocompleteSuggestion[];
            try {
                suggestions = await handler(nextQuery, controller.signal);
            } finally {
                if (inFlightRef.current === controller) {
                    inFlightRef.current = null;
                }
            }
            // A superseded query never reaches state, even if its work completed.
            if (controller.signal.aborted || activeSyncRef.current !== ownSync) {
                return;
            }
            setState((prev) => {
                // The user's pick follows the candidate across every settlement,
                // including the keystroke that changed the query (D-11/INV-6).
                if (prev.pinnedKey !== null) {
                    const nextIndex = suggestions.findIndex((s) => s.key === prev.pinnedKey);
                    if (nextIndex !== -1) {
                        // The same candidate, wherever the sections moved it to.
                        return { query: nextQuery, suggestions, selected: nextIndex, pinnedKey: prev.pinnedKey };
                    }
                }

                // Nothing pinned, or the pinned candidate is gone. Within one query the
                // previous position is still meaningful (a section shrank underneath the
                // highlight); across a query change it is not, so the list restarts at the
                // best match.
                const previousSelected = prev.query === nextQuery ? prev.selected : -1;
                const clampedSelection = Math.min(previousSelected, suggestions.length - 1);
                return {
                    query: nextQuery,
                    suggestions,
                    selected: clampedSelection < 0 && suggestions.length > 0 && autoSelectFirst ? 0 : clampedSelection,
                    pinnedKey: null
                };
            });
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
        return [[], -1, moveUp, moveDown] as const;
    }

    // Return state suggestions
    return [state.suggestions, state.selected, moveUp, moveDown] as const;
}
