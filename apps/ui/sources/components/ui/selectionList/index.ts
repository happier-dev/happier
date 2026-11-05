/**
 * Public barrel for the SelectionList primitive. Consumers SHOULD import
 * exclusively from `@/components/ui/selectionList`, not from individual
 * submodule files. Re-exports are explicit so the public surface is
 * audit-able.
 */

export {
    SELECTION_LIST_STATUS_VARIANTS,
    type SelectionListAccessory,
    type SelectionListColumnsLayout,
    type SelectionListDynamicSection,
    type SelectionListDynamicSectionResolveResult,
    type SelectionListFilter,
    type SelectionListFilterOption,
    type SelectionListHeightBehavior,
    type SelectionListInputBehavior,
    type SelectionListInputMode,
    type SelectionListKeyboardHint,
    type SelectionListLazyVisual,
    type SelectionListOption,
    type SelectionListOptionVisualState,
    type SelectionListOptionPresentation,
    type SelectionListPagination,
    type SelectionListProps,
    type SelectionListQuickActionShortcut,
    type SelectionListSection,
    type SelectionListSectionDescriptor,
    type SelectionListSelection,
    type SelectionListStatusVariant,
    type SelectionListStep,
    type SelectionListTextEllipsizeMode,
    type SelectionListVirtualizationMode,
    type SelectionListVirtualizedOptionSource,
    type SelectionListVirtualizedOptionSourceHeader,
    type SelectionListVirtualizedOptionSourceItem,
} from './_types';

export { SELECTION_LIST_CARD_COLUMN_GAP_PX, SELECTION_LIST_LARGE_POPOVER_SIZE, SELECTION_LIST_VIRTUALIZED_ROW_ESTIMATED_HEIGHT_PX } from './_constants';
export { SelectionList } from './SelectionList';
export { SelectionListDetailPaneContext } from './SelectionListDetailPaneContext';
export { SelectionListFilterChip } from './SelectionListFilterChips';
export { SelectionListScreen, type SelectionListScreenProps } from './SelectionListScreen';
export {
    createDefaultDynamicSectionCache,
    type SelectionListDynamicSectionCache,
} from './selectionListDynamicSectionCache';
export { filterSelectionListSections } from './filterSelectionListSections';
export { renderSelectionListAccessory } from './renderSelectionListAccessory';
export { resolvePopoverSelectionListHeightBehavior } from './resolvePopoverSelectionListHeightBehavior';
export {
    SELECTION_LIST_MODAL_CARD_SCROLL,
    SELECTION_LIST_MODAL_MAX_HEIGHT,
    resolveSelectionListModalHeightBehavior,
} from './selectionListModalPresentation';
export {
    resolveSelectionListListboxDomId,
    resolveSelectionListOptionDomId,
} from './resolveSelectionListOptionDomId';
