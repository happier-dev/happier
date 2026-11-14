import { describe, expect, it } from 'vitest';

// Reproduce a screen's static import graph before its suite installs boundaries.
import { createServerFetchAtEndpoint } from '@/sync/http/client';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { renderScreen } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from './homeGovernanceHarness';
import { createProviderSettingsHarness, installProviderSettingsRpcBoundary } from './providerSettingsHarness';

describe('transport boundary import order', () => {
    it('routes a statically imported HTTP client through the current external transport', async () => {
        expect(typeof createServerFetchAtEndpoint).toBe('function');
        expect(typeof renderScreen).toBe('function');
        const home = createHomeGovernanceHarness();
        installHomeGovernanceBoundaries(home);
        const serverUrl = 'https://static-client-home.test';
        const serverId = await home.addHome({ name: 'Static client Home', serverUrl });
        home.answer(serverId, '/v1/fixture', { body: { source: 'current-boundary' } });
        try {
            const token = home.findByServerUrl(serverUrl)?.token;
            if (!token) throw new Error('Fixture Home has no credential');
            const request = createServerFetchAtEndpoint({ endpointUrl: serverUrl, serverId, credentials: { token } });
            expect(await (await request('/v1/fixture')).json()).toEqual({ source: 'current-boundary' });
            expect(home.requestsFor('/v1/fixture')).toHaveLength(1);
        } finally {
            await home.reset();
        }
    });

    it('installs the RPC boundary after a static consumer has loaded the Socket SDK', () => {
        expect(typeof machineRpcWithServerScope).toBe('function');
        expect(() => installProviderSettingsRpcBoundary(createProviderSettingsHarness())).not.toThrow();
    });
});
