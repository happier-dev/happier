/**
 * Public barrel for the SelectionList primitive. Consumers SHOULD import
 * exclusively from `@/components/ui/selectionList`, not from individual
 * submodule files. Re-exports are explicit so the public surface is
 * audit-able.
 */

export {
    SELECTION_LIST_STATUS_VARIANTS,
    type SelectionListAccessory,
    type SelectionListDynamicSection,
    type SelectionListDynamicSectionResolveResult,
    type SelectionListHeightBehavior,
    type SelectionListInputBehavior,
    type SelectionListInputMode,
    type SelectionListKeyboardHint,
    type SelectionListOption,
    type SelectionListPagination,
    type SelectionListProps,
    type SelectionListQuickActionShortcut,
    type SelectionListSection,
    type SelectionListSectionDescriptor,
    type SelectionListStatusVariant,
    type SelectionListStep,
    type SelectionListTextEllipsizeMode,
    type SelectionListVirtualizationMode,
} from './_types';

export { SelectionList } from './SelectionList';
export { SelectionListScreen, type SelectionListScreenProps } from './SelectionListScreen';
export { resolvePopoverSelectionListHeightBehavior } from './resolvePopoverSelectionListHeightBehavior';
