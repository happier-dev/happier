import { ValueSync } from '@/utils/sessions/sync';
import * as React from 'react';
import type { AutocompleteSuggestion } from './autocompleteTypes';

interface SuggestionOptions {
    clampSelection?: boolean;  // If true, clamp instead of preserving exact position
    autoSelectFirst?: boolean; // If true, automatically select first item when suggestions appear
    wrapAround?: boolean;      // If true, wrap around when reaching top/bottom
}

export function useActiveSuggestions(
    query: string | null, 
    handler: (query: string) => Promise<AutocompleteSuggestion[]>,
    options: SuggestionOptions = {}
) {
    const { 
        clampSelection = true, 
        autoSelectFirst = true,
        wrapAround = true 
    } = options;

    // State for suggestions
    const [state, setState] = React.useState<{
        query: string | null;
        suggestions: AutocompleteSuggestion[];
        selected: number,
    }>({
        query: null,
        suggestions: [],
        selected: -1
    });
    const activeSyncRef = React.useRef<ValueSync<string | null> | null>(null);

    const moveUp = React.useCallback(() => {
        setState((prev) => {
            if (prev.suggestions.length === 0) return prev;
            
            if (prev.selected <= 0) {
                // At top or nothing selected
                if (wrapAround) {
                    return { ...prev, selected: prev.suggestions.length - 1 };
                } else {
                    return { ...prev, selected: 0 };
                }
            }
            // Move up
            return { ...prev, selected: prev.selected - 1 };
        });
    }, [wrapAround]);

    const moveDown = React.useCallback(() => {
        setState((prev) => {
            if (prev.suggestions.length === 0) return prev;
            
            if (prev.selected >= prev.suggestions.length - 1) {
                // At bottom
                if (wrapAround) {
                    return { ...prev, selected: 0 };
                } else {
                    return { ...prev, selected: prev.suggestions.length - 1 };
                }
            }
            // If nothing selected, select first
            if (prev.selected < 0) {
                return { ...prev, selected: 0 };
            }
            // Move down
            return { ...prev, selected: prev.selected + 1 };
        });
    }, [wrapAround]);

    // Sync query to suggestions
    const sync = React.useMemo(() => {
        let ownSync!: ValueSync<string | null>;
        ownSync = new ValueSync<string | null>(async (nextQuery) => {
            if (!nextQuery) {
                setState((prev) => (
                    prev.query === null && prev.suggestions.length === 0 && prev.selected === -1
                        ? prev
                        : { query: null, suggestions: [], selected: -1 }
                ));
                return;
            }
            const suggestions = await handler(nextQuery);
            if (activeSyncRef.current !== ownSync) {
                return;
            }
            setState((prev) => {
                const previousSuggestions = prev.query === nextQuery ? prev.suggestions : [];
                const previousSelected = prev.query === nextQuery ? prev.selected : -1;
                if (clampSelection) {
                    // Simply clamp the selection to valid range
                    let newSelected = previousSelected;
                    
                    if (suggestions.length === 0) {
                        newSelected = -1;
                    } else if (autoSelectFirst && previousSuggestions.length === 0) {
                        // First time showing suggestions, auto-select first
                        newSelected = 0;
                    } else if (previousSelected >= suggestions.length) {
                        // Selection is out of bounds, clamp to last item
                        newSelected = suggestions.length - 1;
                    } else if (previousSelected < 0 && suggestions.length > 0 && autoSelectFirst) {
                        // No selection but we have suggestions
                        newSelected = 0;
                    }
                    
                    return { query: nextQuery, suggestions, selected: newSelected };
                } else {
                    // Try to preserve selection by key (old behavior)
                    if (previousSelected >= 0 && previousSelected < previousSuggestions.length) {
                        const previousKey = previousSuggestions[previousSelected].key;
                        const newIndex = suggestions.findIndex(s => s.key === previousKey);
                        if (newIndex !== -1) {
                            // Found the same key, keep it selected
                            return { query: nextQuery, suggestions, selected: newIndex };
                        }
                    }

                    // Key not found or no previous selection, clamp the selection
                    const clampedSelection = Math.min(previousSelected, suggestions.length - 1);
                    return {
                        query: nextQuery,
                        suggestions,
                        selected: clampedSelection < 0 && suggestions.length > 0 && autoSelectFirst ? 0 : clampedSelection
                    };
                }
            });
        });
        return ownSync;
    }, [clampSelection, autoSelectFirst, handler]);

    React.useEffect(() => {
        activeSyncRef.current = sync;
        return () => {
            if (activeSyncRef.current === sync) {
                activeSyncRef.current = null;
            }
            sync.stop();
        };
    }, [sync]);

    React.useEffect(() => {
        sync.setValue(query);
    }, [query, sync]);

    // If no query return empty suggestions
    if (!query || state.query !== query) {
        return [[], -1, moveUp, moveDown] as const;
    }

    // Return state suggestions
    return [state.suggestions, state.selected, moveUp, moveDown] as const;
}
