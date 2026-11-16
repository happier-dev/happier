import { createPersistentUiState, UiStatePersistenceError, usePersistentUiStateValue } from './persistentUiState';

/** How the Services column groups what you run (owner 2026-11-16 10:20Z): flat, by Project, or by type. */
export type ServicesColumnGrouping = 'all' | 'project' | 'type';
const SERVICES_COLUMN_GROUPINGS: readonly ServicesColumnGrouping[] = ['all', 'project', 'type'];
const GROUPING_KEY = 'grouping';
const DEFAULT_GROUPING: ServicesColumnGrouping = 'project';

// A per-device view choice on the device KV owner, like the Session list's folds: never an Account setting.
export const servicesColumnState = createPersistentUiState<ServicesColumnGrouping>('services-column-v1',
    (value) => SERVICES_COLUMN_GROUPINGS.find((grouping) => grouping === value) ?? DEFAULT_GROUPING);

export function readServicesColumnGrouping(): ServicesColumnGrouping {
    return servicesColumnState.read(GROUPING_KEY) ?? DEFAULT_GROUPING;
}

/** The grouping this device shows; only this key's change wakes the reader. */
export function useServicesColumnGrouping(): ServicesColumnGrouping {
    return usePersistentUiStateValue(servicesColumnState, GROUPING_KEY) ?? DEFAULT_GROUPING;
}

export function setServicesColumnGrouping(grouping: ServicesColumnGrouping): void {
    try { servicesColumnState.set(GROUPING_KEY, grouping); }
    catch (error) {
        if (!(error instanceof UiStatePersistenceError)) throw error;
        console.warn('[services] The column grouping could not be kept on this device.');
    }
}
