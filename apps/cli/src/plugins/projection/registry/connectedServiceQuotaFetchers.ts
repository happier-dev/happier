import type { ConnectedServiceQuotaFetcherDescriptor } from '@/daemon/connectedServices/quotas/types';

import type { ResolvedContributionRegistry } from './types';

export async function resolveConnectedServiceQuotaFetcherDescriptors(
    registry: Pick<ResolvedContributionRegistry, 'catalogEntriesById'>,
): Promise<readonly ConnectedServiceQuotaFetcherDescriptor[]> {
    const descriptors: ConnectedServiceQuotaFetcherDescriptor[] = [];
    const seenIds = new Set<string>();

    for (const entry of Object.values(registry.catalogEntriesById)) {
        const descriptor = await entry.getConnectedServiceQuotaFetcherDescriptor?.();
        if (!descriptor || seenIds.has(descriptor.id)) {
            continue;
        }
        seenIds.add(descriptor.id);
        descriptors.push(descriptor);
    }

    return Object.freeze(descriptors);
}
