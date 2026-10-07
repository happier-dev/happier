import * as React from 'react';

import {
    selectLocalServiceInventoryPresentationRows,
    type LocalServiceInventoryPresentationRow,
    type LocalServiceInventoryState,
} from './store';
export type LocalServiceInventoryViewStatus = 'loading' | 'empty' | 'ready' | 'error';

export type LocalServiceInventoryViewModel = Readonly<{
    status: LocalServiceInventoryViewStatus;
    isRefreshing: boolean;
    rows: readonly LocalServiceInventoryPresentationRow[];
    diagnostics: readonly unknown[];
}>;

export function useLocalServiceInventory(input: Readonly<{
    inventoryState: LocalServiceInventoryState;
}>): LocalServiceInventoryViewModel {
    const rows = selectLocalServiceInventoryPresentationRows(input.inventoryState);
    const diagnostics = input.inventoryState.diagnostics;
    const isRefreshing = input.inventoryState.refreshState === 'refreshing';
    const hasError = input.inventoryState.refreshState === 'error';
    return React.useMemo(() => {
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
    }, [diagnostics, hasError, isRefreshing, rows]);
}
