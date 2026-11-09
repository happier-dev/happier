import { vi } from 'vitest';

import * as subscriptions from '@/sync/domains/state/storageSubscriptions';

/** Observe real index delivery; registration, routing and consumers remain unchanged. */
export function observeStorageSubscriptionDeliveries(
    matches: (paths: readonly (readonly PropertyKey[])[], origin: string) => boolean = () => true,
) {
    let deliveries = 0;
    const register = subscriptions.subscribeStoragePaths;
    const observation = vi.spyOn(subscriptions, 'subscribeStoragePaths').mockImplementation((paths, listener) => {
        const observed = matches(paths, new Error().stack ?? '');
        return register(paths, event => {
            if (observed) deliveries++;
            listener(event);
        });
    });
    return {
        get count() { return deliveries; },
        reset() { deliveries = 0; },
        restore() { observation.mockRestore(); },
    };
}
