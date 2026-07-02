import * as React from 'react';

import {
    selectLocalServiceInventoryRows,
    type LocalServiceInventoryRow,
    type LocalServiceInventoryState,
} from './store';
import {
    selectManagedLocalServiceRows,
    type ManagedLocalServiceRow,
    type ManagedLocalServicesState,
} from '../managed/store';

export type LocalServiceInventoryViewStatus = 'loading' | 'empty' | 'ready' | 'error';

export type LocalServiceInventoryViewModel = Readonly<{
    status: LocalServiceInventoryViewStatus;
    isRefreshing: boolean;
    rows: readonly LocalServiceInventoryRow[];
    managedRows: readonly ManagedLocalServiceRow[];
    diagnostics: readonly unknown[];
}>;

export function useLocalServiceInventory(input: Readonly<{
    inventoryState: LocalServiceInventoryState;
    managedState?: ManagedLocalServicesState | null;
}>): LocalServiceInventoryViewModel {
    return React.useMemo(() => {
        const rows = selectLocalServiceInventoryRows(input.inventoryState);
        const managedRows = input.managedState ? selectManagedLocalServiceRows(input.managedState) : [];
        const managedDiagnostics = input.managedState?.diagnostics ?? [];
        const diagnostics = [
            ...input.inventoryState.diagnostics,
            ...managedDiagnostics,
        ];
        const isRefreshing = input.inventoryState.refreshState === 'refreshing'
            || input.managedState?.refreshState === 'refreshing';
        const hasError = input.inventoryState.refreshState === 'error'
            || input.managedState?.refreshState === 'error';
        const hasRows = rows.length > 0 || managedRows.length > 0;
        const status: LocalServiceInventoryViewStatus = hasRows
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
            managedRows,
            diagnostics,
        };
    }, [input.inventoryState, input.managedState]);
}
