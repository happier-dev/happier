import * as React from 'react';

import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import type { CommandMenuItem } from '@/components/ui/commandMenu/commandMenuTypes';
import { buildAgentInputCommandMenuItems } from './buildAgentInputCommandMenuItems';

export function useAgentInputCommandMenu(input: Readonly<{
    suggestions: readonly AutocompleteSuggestion[];
    selected: number;
    /** A user-pinned row is absent from an incomplete current-query snapshot. */
    selectionPending?: boolean;
    activeWord: string | null;
    activeWordRange: Readonly<{ start: number; end: number }> | null;
    inputTextLength: number;
    moveUp: () => void;
    moveDown: () => void;
    handleSuggestionSelect: (index: number) => void;
    onOpenPromptPicker?: () => void;
}>): Readonly<{
    commandMenuOpen: boolean;
    items: readonly CommandMenuItem[];
    selectedIndex: number;
    query: string;
    onSelectFromMenu: () => void;
    onSelectIndexFromMenu: (index: number) => void;
    onCloseMenu: () => void;
    moveUp: () => void;
    moveDown: () => void;
}> {
    const {
        suggestions,
        selected,
        selectionPending = false,
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
    const [pickerRowSelected, setPickerRowSelected] = React.useState(false);
    const includePromptPicker = input.onOpenPromptPicker !== undefined && activeWord?.startsWith('/') === true;
    React.useEffect(() => setPickerRowSelected(false), [activeTriggerKey, includePromptPicker]);

    React.useEffect(() => {
        if (dismissedTriggerKey !== null && activeTriggerKey !== dismissedTriggerKey) {
            setDismissedTriggerKey(null);
        }
    }, [activeTriggerKey, dismissedTriggerKey]);

    const commandMenuOpen =
        (suggestions.length > 0 || includePromptPicker)
        && activeTriggerKey !== null
        && activeTriggerKey !== dismissedTriggerKey;

    const items = React.useMemo(
        () => buildAgentInputCommandMenuItems(suggestions, { includePromptPicker }),
        [suggestions, includePromptPicker],
    );
    const selectedIndex = includePromptPicker && (pickerRowSelected || suggestions.length === 0) ? suggestions.length : selected;
    const onSelectIndexFromMenu = React.useCallback((index: number) => {
        if (includePromptPicker && index === suggestions.length) {
            setDismissedTriggerKey(activeTriggerKey);
            input.onOpenPromptPicker?.();
        } else if (!selectionPending) handleSuggestionSelect(index >= 0 ? index : 0);
    }, [activeTriggerKey, handleSuggestionSelect, includePromptPicker, input.onOpenPromptPicker, selectionPending, suggestions.length]);
    const onSelectFromMenu = React.useCallback(() => onSelectIndexFromMenu(selectedIndex), [onSelectIndexFromMenu, selectedIndex]);

    const onCloseMenu = React.useCallback(() => {
        if (activeTriggerKey !== null) {
            setDismissedTriggerKey(activeTriggerKey);
        }
    }, [activeTriggerKey]);

    return {
        commandMenuOpen,
        items,
        selectedIndex,
        query: activeWord ?? '',
        onSelectFromMenu,
        onSelectIndexFromMenu,
        onCloseMenu,
        moveUp: () => {
            if (includePromptPicker && selectedIndex === 0) setPickerRowSelected(true);
            else if (pickerRowSelected) { setPickerRowSelected(false); if (selected !== suggestions.length - 1) moveUp(); }
            else moveUp();
        },
        moveDown: () => {
            if (includePromptPicker && selectedIndex === suggestions.length - 1) setPickerRowSelected(true);
            else if (pickerRowSelected) { setPickerRowSelected(false); if (selected !== 0) moveDown(); }
            else moveDown();
        },
    };
}
