import {
    resolveSelectionListListboxDomId,
    resolveSelectionListOptionDomId,
} from '@/components/ui/selectionList';

import type { CommandMenuItem } from './commandMenuTypes';

export const COMMAND_MENU_ROOT_STEP_ID = 'command-menu-root';

export function resolveCommandMenuComboboxAccessibility(input: Readonly<{
    testID: string;
    items: readonly CommandMenuItem[];
    selectedIndex: number;
}>): Readonly<{
    listboxId: string;
    activeDescendantId?: string;
}> {
    const selectionListTestID = `${input.testID}:list`;
    const selectedItem = input.selectedIndex >= 0 && input.selectedIndex < input.items.length
        ? input.items[input.selectedIndex]
        : undefined;
    return {
        listboxId: resolveSelectionListListboxDomId(selectionListTestID),
        ...(selectedItem === undefined
            ? {}
            : {
                activeDescendantId: resolveSelectionListOptionDomId({
                    option: selectedItem,
                    rootTestID: selectionListTestID,
                    stepId: COMMAND_MENU_ROOT_STEP_ID,
                }),
            }),
    };
}
