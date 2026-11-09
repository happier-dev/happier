import { ValueSync } from '@/utils/sessions/sync';
import { useSessionRecordingVisibility } from '@/hooks/session/useSessionListRecordingPrivacy';
import * as React from 'react';
import {
    getAutocompleteSuggestionIdentity,
    type AutocompleteSuggestion,
    type AutocompleteSuggestionUpdate,
} from './autocompleteTypes';
import { isComposerSuggestionTrigger, type ComposerSuggestionKindId, type ComposerSuggestionTrigger } from './composerSuggestionGrammar';

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

/** A host may invalidate only the sources consumed by the active trigger. */
export type ActiveSuggestionsSource = ActiveSuggestionsHandler | Readonly<Record<ComposerSuggestionTrigger, ActiveSuggestionsHandler>>;

export function resolveActiveSuggestionsHandler(source: ActiveSuggestionsSource, query: string | null): ActiveSuggestionsHandler {
    if (typeof source === 'function') return source;
    const trigger = query?.charAt(0) ?? '';
    return source[isComposerSuggestionTrigger(trigger) ? trigger : '@'];
}

interface SuggestionOptions {
    autoSelectFirst?: boolean; // If true, automatically select first item when suggestions appear
    wrapAround?: boolean;      // If true, wrap around when reaching top/bottom
}

export type ActiveSuggestionKindSelection = (kind: ComposerSuggestionKindId) => Readonly<{
    /** The selected row's index in the complete suggestion snapshot. */
    selected: number;
    selectionPending: boolean;
}>;

type ActiveSuggestionState = Readonly<{
    source: object | null;
    query: string | null;
    suggestions: AutocompleteSuggestion[];
    selected: number;
    /** The candidate the user explicitly moved onto, or null while the highlight is automatic. */
    pinnedKey: string | null;
    /** A partial snapshot does not currently contain the user's pinned candidate. */
    selectionPending: boolean;
    /** The final answer for `query` is empty: "no matches", not "still looking". */
    settledEmpty: boolean;
}>;

/** The next row the user can take from `from` in `step` direction (wrapping when asked), or -1 when none. */
function stepToEnabled(
    suggestions: readonly AutocompleteSuggestion[],
    from: number,
    step: 1 | -1,
    wrapAround: boolean,
    kind: ComposerSuggestionKindId | null = null,
): number {
    const count = suggestions.length;
    for (let taken = 1; taken <= count; taken += 1) {
        const raw = from + step * taken;
        if (!wrapAround && (raw < 0 || raw >= count)) return -1;
        const index = ((raw % count) + count) % count;
        const suggestion = suggestions[index];
        if (suggestion?.disabled !== true && (kind === null || suggestion?.kind === kind)) return index;
    }
    return -1;
}

function readKindSelection(state: ActiveSuggestionState, kind: ComposerSuggestionKindId | null, autoSelectFirst: boolean) {
    if (kind === null || state.selectionPending || state.suggestions[state.selected]?.kind === kind) {
        return { selected: state.selected, selectionPending: state.selectionPending };
    }
    return {
        selected: autoSelectFirst ? stepToEnabled(state.suggestions, -1, 1, false, kind) : -1,
        selectionPending: false,
    };
}

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
        && previous.source === next.source
        && previous.selected === next.selected
        && previous.pinnedKey === next.pinnedKey
        && previous.selectionPending === next.selectionPending
        && previous.settledEmpty === next.settledEmpty
        && sameSuggestionSnapshot(previous.suggestions, next.suggestions)
        ? previous
        : next;
}

function reconcileSuggestionSnapshot(params: Readonly<{
    previous: ActiveSuggestionState;
    source: object;
    query: string;
    suggestions: AutocompleteSuggestion[];
    complete: boolean;
    autoSelectFirst: boolean;
}>): ActiveSuggestionState {
    const { previous, source, query, suggestions, complete, autoSelectFirst } = params;
    if (previous.pinnedKey !== null) {
        const selected = suggestions.findIndex(
            (suggestion) => getAutocompleteSuggestionIdentity(suggestion) === previous.pinnedKey,
        );
        if (selected !== -1) {
            return unchangedSuggestionState(previous, {
                source,
                query,
                suggestions,
                selected,
                pinnedKey: previous.pinnedKey,
                selectionPending: false,
                settledEmpty: false,
            });
        }
        if (!complete) {
            // Do not silently turn an explicit reference choice into whichever
            // earlier section happened to settle first. Arrow navigation is still
            // an intentional new choice; Enter remains inert until then.
            return unchangedSuggestionState(previous, {
                source,
                query,
                suggestions,
                selected: -1,
                pinnedKey: previous.pinnedKey,
                selectionPending: true,
                settledEmpty: complete && suggestions.length === 0,
            });
        }
    }

    // Nothing pinned, or a final snapshot proves the pinned candidate is gone.
    // Within one query the previous position is still meaningful; across a query
    // change the list restarts at the best match.
    const previousSelected = previous.query === query ? previous.selected : -1;
    const nearest = Math.min(previousSelected, suggestions.length - 1);
    const selected = nearest >= 0 && suggestions[nearest]?.disabled === true
        ? stepToEnabled(suggestions, nearest, 1, true) : nearest;
    return unchangedSuggestionState(previous, {
        source,
        query,
        suggestions,
        selected: selected < 0 && suggestions.length > 0 && autoSelectFirst ? stepToEnabled(suggestions, -1, 1, false) : selected,
        pinnedKey: null,
        selectionPending: false,
        settledEmpty: complete && suggestions.length === 0,
    });
}

export function useActiveSuggestions(
    query: string | null,
    source: ActiveSuggestionsSource,
    options: SuggestionOptions = {}
) {
    const handler = resolveActiveSuggestionsHandler(source, query);
    const sessionVisibility = useSessionRecordingVisibility(query?.startsWith('@') === true);
    const {
        autoSelectFirst = true,
        wrapAround = true
    } = options;

    // State for suggestions
    const [state, setState] = React.useState<ActiveSuggestionState>({
        source: null,
        query: null,
        suggestions: [],
        selected: -1,
        pinnedKey: null,
        selectionPending: false,
        settledEmpty: false,
    });
    const stateRef = React.useRef(state);
    stateRef.current = state;
    const activeSyncRef = React.useRef<ValueSync<string | null> | null>(null);
    const inFlightRef = React.useRef<AbortController | null>(null);

    const move = React.useCallback((step: 1 | -1, kind: ComposerSuggestionKindId | null = null) => {
        const previous = stateRef.current;
        if (previous.suggestions.length === 0) return;
        const current = readKindSelection(previous, kind, autoSelectFirst).selected;
        const from = step === -1 ? Math.max(current, 0) : current;
        const moved = stepToEnabled(previous.suggestions, from, step, wrapAround, kind);
        const selected = moved === -1 ? current : moved;
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
    }, [autoSelectFirst, wrapAround]);
    const moveUp = React.useCallback((kind: ComposerSuggestionKindId | null = null) => move(-1, kind), [move]);
    const moveDown = React.useCallback((kind: ComposerSuggestionKindId | null = null) => move(1, kind), [move]);
    const selectionForKind = React.useCallback<ActiveSuggestionKindSelection>((kind) => {
        if (!query || stateRef.current.query !== query || stateRef.current.source !== activeSyncRef.current) return { selected: -1, selectionPending: false };
        return readKindSelection(stateRef.current, kind, autoSelectFirst);
    }, [autoSelectFirst, query]);

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
                    && !previous.settledEmpty
                ) {
                    return;
                }
                const next: ActiveSuggestionState = {
                    source: ownSync,
                    query: null,
                    suggestions: [],
                    selected: -1,
                    pinnedKey: null,
                    selectionPending: false,
                    settledEmpty: false,
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
                    source: ownSync,
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
    }, [autoSelectFirst, handler, sessionVisibility]);

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
    if (!query || state.query !== query || state.source !== sync) {
        return [[], -1, moveUp, moveDown, false, false, selectionForKind] as const;
    }

    // Return state suggestions
    // The sixth value says the settled answer for this query is empty ("no matches", not "still looking").
    return [state.suggestions, state.selected, moveUp, moveDown, state.selectionPending, state.settledEmpty, selectionForKind] as const;
}
