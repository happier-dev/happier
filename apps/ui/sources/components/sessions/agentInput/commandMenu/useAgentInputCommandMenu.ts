import * as React from 'react';

import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import type { CommandMenuItem } from '@/components/ui/commandMenu/commandMenuTypes';
import { buildAgentInputCommandMenuItems } from './buildAgentInputCommandMenuItems';

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

    const activeTriggerKey = activeWord !== null && activeWordRange !== null
        ? `${activeWordRange.start}:${activeWordRange.end}:${activeWord}:${inputTextLength}`
        : null;
    const [dismissedTriggerKey, setDismissedTriggerKey] = React.useState<string | null>(null);

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
        handleSuggestionSelect(selected >= 0 ? selected : 0);
    }, [handleSuggestionSelect, selected]);

    const onCloseMenu = React.useCallback(() => {
        if (activeTriggerKey !== null) {
            setDismissedTriggerKey(activeTriggerKey);
        }
    }, [activeTriggerKey]);

    return {
        commandMenuOpen,
        items,
        selectedIndex: selected,
        query: activeWord ?? '',
        onSelectFromMenu,
        onCloseMenu,
        moveUp,
        moveDown,
    };
}

