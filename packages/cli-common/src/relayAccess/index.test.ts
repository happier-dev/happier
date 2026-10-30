import { describe, expect, it } from 'vitest';
import { relayAccessProviderDescriptors as catalogDescriptors, relayAccessProviderIds as catalogIds } from './catalog';

import {
    relayAccessProviderDescriptors,
    relayAccessProviderIds,
    relayAccessProviders,
} from './index.js';

describe('relayAccess public entrypoint', () => {
    it('exposes provider metadata and providers from the root export', () => {
        expect(relayAccessProviderIds).toEqual([
            'localOnly',
            'lan',
            'tailscaleServe',
            'tailscaleFunnel',
            'cloudflareNamed',
        ]);
        expect(relayAccessProviderDescriptors.map((descriptor) => descriptor.id)).toEqual(relayAccessProviderIds);
        expect(relayAccessProviders.map((provider) => provider.descriptor.id)).toEqual(relayAccessProviderIds);
        expect(catalogIds).toEqual(relayAccessProviderIds);
        expect(catalogDescriptors.map((descriptor) => descriptor.id)).toEqual(relayAccessProviderIds);
    });
});
