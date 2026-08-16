import * as React from 'react';

import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import type { CommandMenuItem } from '@/components/ui/commandMenu/commandMenuTypes';
import { buildAgentInputCommandMenuItems } from './buildAgentInputCommandMenuItems';

/**
 * Adapter hook that bridges existing AgentInput autocomplete state
 * to the `<CommandMenu>` primitive props.
 *
 * Responsibilities:
 * - Converts `AutocompleteSuggestion[]` into `CommandMenuItem[]` via the mapper.
 * - Manages the dismissed-trigger-key pattern (D46) so Escape suppresses
 *   the current trigger without relying on selection-collapse side effects.
 * - Provides stable callbacks for `useCommandMenuKeyboard` consumption.
 *
 * All existing autocomplete state (suggestions, selected, moveUp, moveDown,
 * handleSuggestionSelect) is passed through from the existing hooks. This
 * adapter does NOT replace any of that logic — it only shapes the output for
 * the primitive.
 *
 * Note: `activeWord` is `string | null` — the `activeWord` field of the host's
 * `findActiveWord` result, not the full `ActiveWord` object. It contains the
 * token text from the trigger up to the cursor (e.g. "/goal", "@file").
 */
export function useAgentInputCommandMenu(input: Readonly<{
    suggestions: readonly AutocompleteSuggestion[];
    selected: number;
    activeWord: string | null;
    activeWordRange: Readonly<{ start: number; end: number }> | null;
    inputTextLength: number;
    moveUp: () => void;
    moveDown: () => void;
    handleSuggestionSelect: (index: number) => void;
}>): Readonly<{
    commandMenuOpen: boolean;
    items: readonly CommandMenuItem[];
    selectedIndex: number;
    query: string;
    onSelectFromMenu: () => void;
    onCloseMenu: () => void;
    moveUp: () => void;
    moveDown: () => void;
}> {
    const {
        suggestions,
        selected,
        activeWord,
        activeWordRange,
        inputTextLength,
        moveUp,
        moveDown,
        handleSuggestionSelect,
    } = input;

    // Build the trigger key for dismissed-trigger-key pattern (D46).
    // This is a composite key that changes whenever the trigger range, query,
    // or input version changes, preventing the menu from reopening after
    // Escape while avoiding suppression leaks to an identical trigger elsewhere.
    const activeTriggerKey = activeWord !== null && activeWordRange !== null
        ? `${activeWordRange.start}:${activeWordRange.end}:${activeWord}:${inputTextLength}`
        : null;

    const [dismissedTriggerKey, setDismissedTriggerKey] = React.useState<string | null>(null);

    // Clear the dismissal when the trigger changes (the user moved to a
    // different word or edited the text enough that it's a different trigger).
    React.useEffect(() => {
        if (dismissedTriggerKey !== null && activeTriggerKey !== dismissedTriggerKey) {
            setDismissedTriggerKey(null);
        }
    }, [activeTriggerKey, dismissedTriggerKey]);

    const commandMenuOpen =
        suggestions.length > 0
        && activeTriggerKey !== null
        && activeTriggerKey !== dismissedTriggerKey;

    const items = React.useMemo(
        () => buildAgentInputCommandMenuItems(suggestions),
        [suggestions],
    );

    const onSelectFromMenu = React.useCallback(() => {
        const indexToSelect = selected >= 0 ? selected : 0;
        handleSuggestionSelect(indexToSelect);
    }, [selected, handleSuggestionSelect]);

    const onCloseMenu = React.useCallback(() => {
        if (activeTriggerKey !== null) {
            setDismissedTriggerKey(activeTriggerKey);
        }
    }, [activeTriggerKey]);

    const query = activeWord ?? '';

    return {
        commandMenuOpen,
        items,
        selectedIndex: selected,
        query,
        onSelectFromMenu,
        onCloseMenu,
        moveUp,
        moveDown,
    };
}
