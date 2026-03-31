import { describe, expect, it } from 'vitest';

import { relayAccessProviderDescriptors as catalogDescriptors, relayAccessProviderIds as catalogIds } from './catalog';
import { relayAccessProviderDescriptors, relayAccessProviderIds } from './registry';

describe('relayAccess registry', () => {
    it('exposes a stable, ordered list of provider ids', () => {
        expect(relayAccessProviderIds).toEqual([
            'localOnly',
            'lan',
            'tailscaleServe',
            'tailscaleFunnel',
            'cloudflareNamed',
        ]);
    });

    it('exposes a stable, ordered list of provider descriptors', () => {
        expect(relayAccessProviderDescriptors.map((descriptor) => descriptor.id)).toEqual(relayAccessProviderIds);
    });

    it('keeps the catalog ids and descriptors aligned with the runtime registry exports', () => {
        expect(catalogIds).toEqual(relayAccessProviderIds);
        expect(catalogDescriptors.map((descriptor) => descriptor.id)).toEqual(relayAccessProviderIds);
    });
});
