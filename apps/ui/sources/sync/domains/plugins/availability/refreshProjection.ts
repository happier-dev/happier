import type { ActivePluginAccountAvailabilityProjectionHydrator } from '@/sync/api/plugins/availability/pluginAvailabilityProjection';

import {
    applyPluginAccountAvailabilityProjectionRefresh,
    canMergePluginAccountAvailabilityRows,
    failPluginAccountAvailabilityProjection,
} from './projection';
import { isPluginAvailabilityResponseFailure } from './responseFailure';

/** One Sync attempt publishes readiness and preserves the owner's retry classification. */
export async function refreshPluginAccountAvailabilityProjection(
    hydrator: ActivePluginAccountAvailabilityProjectionHydrator,
): Promise<void> {
    try {
        const projection = await hydrator.refresh({ canMergePlugins: canMergePluginAccountAvailabilityRows });
        if (projection?.pluginIds && !canMergePluginAccountAvailabilityRows(projection.scope)) {
            // The held projection changed while the row-level read was in
            // flight; the Sync owner's retry reads the whole inventory.
            hydrator.requireFullRefresh();
            throw new Error('Plugin Availability row-level read has no complete projection to merge into.');
        }
        if (projection) applyPluginAccountAvailabilityProjectionRefresh(projection);
    } catch (error) {
        if (isPluginAvailabilityResponseFailure(error)) {
            failPluginAccountAvailabilityProjection({ scope: error.scope, code: error.code });
        }
        throw error;
    }
}
