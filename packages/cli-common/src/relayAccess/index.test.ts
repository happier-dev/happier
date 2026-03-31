import { describe, expect, it } from 'vitest';

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
    });
});
