import type { ProviderConformanceFixture } from '../../../../apps/cli/src/machines/managed/providerConformance.testkit.js';
import { railwayVendor } from './vendor.js';

/** Railway API v2 / files wire v3.16.0 boundary for the shared provider conformance suite. */
export const providerConformanceFixture: ProviderConformanceFixture = world => {
    const railway = railwayVendor();
    return {
        foreignId: 'happier-foreign', launch: { environmentId: 'environment-one' },
        async http(request, { method }) {
            const response = await railway.request(request.url, { method, body: typeof request.body === 'string' ? request.body : world.decode.decode(request.body) });
            return { status: response.status, finalUrl: request.url, headers: { 'content-type': 'application/json' }, body: new Uint8Array(await response.arrayBuffer()) };
        },
        external: {
            allocationCount: () => railway.calls.filter(call => call.query.includes('sandboxCreate(')).length,
            foreignPresent: () => railway.foreignPresent, present: () => railway.present,
            owned: () => new Set<string>(railway.present ? ['sandbox'] : []),
            setFailure: failure => railway.setFailure(failure === 'outage'), cleanup: () => railway.cleanup(),
        },
    };
};
