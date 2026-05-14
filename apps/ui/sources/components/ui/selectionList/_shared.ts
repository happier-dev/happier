/**
 * Small shared helpers used across SelectionList sub-components. Keep this
 * file lean — anything that grows beyond ~30 lines or owns a single behavior
 * should live in its own module under `selectionList/`.
 */

import { SELECTION_LIST_DEFAULT_TEST_ID } from './_constants';

/**
 * Compose a stable testID under the SelectionList namespace.
 * Example: `selectionListTestId(undefined, 'option', '42')` → `selection-list:option:42`.
 */
export function selectionListTestId(
    rootTestID: string | undefined,
    ...suffixes: ReadonlyArray<string>
): string {
    const root = rootTestID && rootTestID.length > 0 ? rootTestID : SELECTION_LIST_DEFAULT_TEST_ID;
    return [root, ...suffixes].filter((part) => part.length > 0).join(':');
}
