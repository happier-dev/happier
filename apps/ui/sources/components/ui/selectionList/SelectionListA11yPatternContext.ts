import * as React from 'react';

import type { SelectionListA11yPattern } from './buildSelectionListOptionA11yProps';

/**
 * The ARIA pattern is a property of the whole popup, not of one row: the
 * container role, the row role, and the cell role must agree or the composite
 * widget is invalid. `SelectionListBody` resolves it once from the render plan
 * and publishes it here so every row path — plain, animated, per-section
 * virtualized, and flat virtualized — reads the SAME decision instead of each
 * threading its own copy through a different prop chain.
 *
 * Defaults to `'listbox'`, so a row rendered outside a body (unit tests,
 * story surfaces) keeps the historical option role set.
 */
export const SelectionListA11yPatternContext = React.createContext<SelectionListA11yPattern>('listbox');
