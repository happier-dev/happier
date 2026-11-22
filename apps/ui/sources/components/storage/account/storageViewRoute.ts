import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';

import type { AccountStorageMeasuredKind } from './accountStorageModel';

/**
 * The Storage view's address, opened filtered (owner 11-19: "one storage view the user can open everywhere"): the
 * Artifacts page total and meter, and the Account quota notices, open it with the Artifacts kind chosen.
 */
export function accountStorageViewRoute(kind?: AccountStorageMeasuredKind): string {
    return kind ? `${SETTINGS_ROUTES.storage}?kind=${kind}` : SETTINGS_ROUTES.storage;
}
