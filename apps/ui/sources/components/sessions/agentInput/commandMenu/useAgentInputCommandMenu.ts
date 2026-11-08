import * as React from 'react';

import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import type { ComposerSuggestionKindId } from '@/components/autocomplete/composerSuggestionGrammar';
import type { ActiveSuggestionKindSelection } from '@/components/autocomplete/useActiveSuggestions';
import type { CommandMenuItem } from '@/components/ui/commandMenu/commandMenuTypes';
import { buildAgentInputCommandMenuItems } from './buildAgentInputCommandMenuItems';

export function useAgentInputCommandMenu(
  input: Readonly<{
    suggestions: readonly AutocompleteSuggestion[];
    selected: number;
    /** A user-pinned row is absent from an incomplete current-query snapshot. */
    selectionPending?: boolean;
    activeWord: string | null;
    activeWordRange: Readonly<{ start: number; end: number }> | null;
    inputTextLength: number;
    moveUp: (kind?: ComposerSuggestionKindId | null) => void;
    moveDown: (kind?: ComposerSuggestionKindId | null) => void;
    selectionForKind: ActiveSuggestionKindSelection;
    handleSuggestionSelect: (index: number) => void;
    onOpenPromptPicker?: () => void;
    /** The settled answer for the active word is empty: no matches, not still looking. */
    settledEmpty?: boolean;
    /**
     * Reference pickers keep their frame open on a settled empty answer and draw their empty state
     * there; a command list closes as it always has.
     */
    emptyStateWhenResolved?: boolean;
    /** The kinds the active trigger can mention, in order. Two or more become the picker's kind tabs. */
    kindTabs?: readonly ComposerSuggestionKindId[];
  }>,
): Readonly<{
  commandMenuOpen: boolean;
  items: readonly CommandMenuItem[];
  selectedIndex: number;
  query: string;
  onSelectFromMenu: () => void;
  onSelectIndexFromMenu: (index: number) => void;
  onCloseMenu: () => void;
  moveUp: () => void;
  moveDown: () => void;
  /** The chosen kind tab, or null for All. */
  kindTab: ComposerSuggestionKindId | null;
  setKindTab: (kind: ComposerSuggestionKindId | null) => void;
  /** All → each kind → All. Null when the trigger has fewer than two kinds. */
  cycleKindTab: (() => void) | undefined;
  /** The menu is open with no rows and draws its empty state. */
  showsEmptyState: boolean;
  /** The menu has a row Enter can take. */
  selectable: boolean;
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

  const activeTriggerKey =
    activeWord !== null && activeWordRange !== null
      ? `${activeWordRange.start}:${activeWordRange.end}:${activeWord}:${inputTextLength}`
      : null;
  const [dismissedTriggerKey, setDismissedTriggerKey] = React.useState<
    string | null
  >(null);
  const [pickerRowSelected, setPickerRowSelected] = React.useState(false);
  const includePromptPicker =
    input.onOpenPromptPicker !== undefined &&
    activeWord?.startsWith('/') === true;
  React.useEffect(
    () => setPickerRowSelected(false),
    [activeTriggerKey, includePromptPicker],
  );

  React.useEffect(() => {
    if (
      dismissedTriggerKey !== null &&
      activeTriggerKey !== dismissedTriggerKey
    ) {
      setDismissedTriggerKey(null);
    }
  }, [activeTriggerKey, dismissedTriggerKey]);

  // Kind tabs belong to one trigger: typing narrows within the chosen kind, a new trigger starts on All.
  const kindTabs =
    input.kindTabs !== undefined && input.kindTabs.length > 1
      ? input.kindTabs
      : null;
  const triggerStart = activeWordRange?.start ?? null;
  const [kindTabState, setKindTabState] = React.useState<
    Readonly<{ trigger: number | null; kind: ComposerSuggestionKindId | null }>
  >({ trigger: null, kind: null });
  const kindTab =
    kindTabs !== null &&
    kindTabState.trigger === triggerStart &&
    kindTabState.kind !== null &&
    kindTabs.includes(kindTabState.kind)
      ? kindTabState.kind
      : null;
  const setKindTab = React.useCallback(
    (kind: ComposerSuggestionKindId | null) => {
      setKindTabState({ trigger: triggerStart, kind });
    },
    [triggerStart],
  );
  const cycleKindTab = React.useMemo(
    () =>
      kindTabs === null
        ? undefined
        : () => {
            const next =
              kindTab === null
                ? kindTabs[0]!
                : (kindTabs[kindTabs.indexOf(kindTab) + 1] ?? null);
            setKindTabState({ trigger: triggerStart, kind: next });
          },
    [kindTab, kindTabs, triggerStart],
  );

  // Tabs project the canonical selection; row dispatch retains the complete snapshot's indices.
  const shown = React.useMemo(
    () =>
      kindTab === null
        ? null
        : suggestions.flatMap((suggestion, index) =>
            suggestion.kind === kindTab ? [{ suggestion, index }] : [],
          ),
    [kindTab, suggestions],
  );
  const shownSuggestions = React.useMemo(
    () => shown?.map((row) => row.suggestion) ?? suggestions,
    [shown, suggestions],
  );

  const showsEmptyState =
    shownSuggestions.length === 0 &&
    !includePromptPicker &&
    (kindTab !== null ||
      (input.emptyStateWhenResolved === true && input.settledEmpty === true));
  // A reference picker keeps its frame while it is still looking, so a slow kind never makes it
  // vanish and come back; its caller supplies the shared loading or empty state.
  const holdsFrame = input.emptyStateWhenResolved === true;
  const commandMenuOpen =
    (shownSuggestions.length > 0 || includePromptPicker || showsEmptyState || holdsFrame) &&
    activeTriggerKey !== null &&
    activeTriggerKey !== dismissedTriggerKey;

  const items = React.useMemo(
    () =>
      buildAgentInputCommandMenuItems(shownSuggestions, {
        includePromptPicker,
      }),
    [shownSuggestions, includePromptPicker],
  );
  const kindSelection = kindTab === null ? null : input.selectionForKind(kindTab);
  const shownSelectionPending = kindSelection?.selectionPending ?? selectionPending;
  const selectedIndex =
    shown !== null
      ? shown.findIndex((row) => row.index === kindSelection?.selected)
      : includePromptPicker && (pickerRowSelected || suggestions.length === 0)
        ? suggestions.length
        : selected;
  const onSelectIndexFromMenu = React.useCallback(
    (index: number) => {
      if (shown !== null) {
        const row = shown[index >= 0 ? index : 0];
        if (row && !shownSelectionPending && row.suggestion.disabled !== true)
          handleSuggestionSelect(row.index);
        return;
      }
      if (includePromptPicker && index === suggestions.length) {
        setDismissedTriggerKey(activeTriggerKey);
        input.onOpenPromptPicker?.();
      } else if (
        !shownSelectionPending &&
        suggestions[index >= 0 ? index : 0]?.disabled !== true
      )
        handleSuggestionSelect(index >= 0 ? index : 0);
    },
    [
      activeTriggerKey,
      handleSuggestionSelect,
      includePromptPicker,
      input.onOpenPromptPicker,
      shownSelectionPending,
      shown,
      suggestions,
    ],
  );
  const onSelectFromMenu = React.useCallback(
    () => onSelectIndexFromMenu(selectedIndex),
    [onSelectIndexFromMenu, selectedIndex],
  );

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
      if (shown !== null) moveUp(kindTab);
      else if (includePromptPicker && selectedIndex === 0)
        setPickerRowSelected(true);
      else if (pickerRowSelected) {
        setPickerRowSelected(false);
        if (selected !== suggestions.length - 1) moveUp();
      } else moveUp();
    },
    moveDown: () => {
      if (shown !== null) moveDown(kindTab);
      else if (includePromptPicker && selectedIndex === suggestions.length - 1)
        setPickerRowSelected(true);
      else if (pickerRowSelected) {
        setPickerRowSelected(false);
        if (selected !== 0) moveDown();
      } else moveDown();
    },
    kindTab,
    setKindTab,
    cycleKindTab,
    showsEmptyState: commandMenuOpen && showsEmptyState,
    selectable: items.length > 0,
  };
}
