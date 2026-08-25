import * as React from 'react';

import {
    selectLocalServiceInventoryRows,
    type LocalServiceInventoryRow,
    type LocalServiceInventoryState,
} from './store';
export type LocalServiceInventoryViewStatus = 'loading' | 'empty' | 'ready' | 'error';

export type LocalServiceInventoryViewModel = Readonly<{
    status: LocalServiceInventoryViewStatus;
    isRefreshing: boolean;
    rows: readonly LocalServiceInventoryRow[];
    diagnostics: readonly unknown[];
}>;

export function useLocalServiceInventory(input: Readonly<{
    inventoryState: LocalServiceInventoryState;
}>): LocalServiceInventoryViewModel {
    return React.useMemo(() => {
        const rows = selectLocalServiceInventoryRows(input.inventoryState);
        const diagnostics = input.inventoryState.diagnostics;
        const isRefreshing = input.inventoryState.refreshState === 'refreshing';
        const hasError = input.inventoryState.refreshState === 'error';
        const status: LocalServiceInventoryViewStatus = rows.length > 0
            ? 'ready'
            : hasError
                ? 'error'
                : isRefreshing
                    ? 'loading'
                    : 'empty';

        return {
            status,
            isRefreshing,
            rows,
            diagnostics,
        };
    }, [input.inventoryState]);
}
