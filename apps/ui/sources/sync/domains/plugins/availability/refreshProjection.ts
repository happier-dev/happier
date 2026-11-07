import type { ActivePluginAccountAvailabilityProjectionHydrator } from '@/sync/api/plugins/availability/pluginAvailabilityProjection';

import {
    applyPluginAccountAvailabilityProjectionRefresh,
    failPluginAccountAvailabilityProjection,
} from './projection';
import { isPluginAvailabilityResponseFailure } from './responseFailure';

/** One Sync attempt publishes readiness and preserves the owner's retry classification. */
export async function refreshPluginAccountAvailabilityProjection(
    hydrator: ActivePluginAccountAvailabilityProjectionHydrator,
): Promise<void> {
    try {
        const projection = await hydrator.refresh();
        if (projection) applyPluginAccountAvailabilityProjectionRefresh(projection);
    } catch (error) {
        if (isPluginAvailabilityResponseFailure(error)) {
            failPluginAccountAvailabilityProjection({ scope: error.scope, code: error.code });
        }
        throw error;
    }
}
