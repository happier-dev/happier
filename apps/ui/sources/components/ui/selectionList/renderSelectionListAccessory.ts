import type * as React from 'react';

import type { SelectionListAccessory } from './_types';

export function renderSelectionListAccessory(
    accessory: SelectionListAccessory | undefined,
): React.ReactNode | undefined {
    if (typeof accessory === 'function') {
        return accessory() ?? undefined;
    }
    return accessory ?? undefined;
}
