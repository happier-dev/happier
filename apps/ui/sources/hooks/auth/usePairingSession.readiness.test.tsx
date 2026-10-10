import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { FeaturesResponseSchema, tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
beforeEach(() => harness.reset());
afterEach(() => standardCleanup());

it('settles a refused pairing start through the real feature, transport and lifecycle owners', async () => {
    const homeId = await harness.addHome({ name: 'Pairing', serverUrl: 'https://pairing-readiness.test',
        serverIdentityId: 'srv_pairing_readiness', accountId: 'owner', currentAccount: true });
    const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_pairing_readiness',
        canonicalServerUrl: 'https://pairing-readiness.test', revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'https://pairing-readiness.test' }] };
    await adoptHomeProfile({ descriptor, source: 'qr', descriptorAuthority: 'current_connection_observation' });
    const features = createRootLayoutFeaturesResponse();
    tryWriteServerEnabledBitInPlace(features, 'auth.pairing.boundQrV2', true);
    features.capabilities.serverIdentity.serverIdentityId = 'srv_pairing_readiness';
    features.capabilities.server.canonicalServerUrl = 'https://pairing-readiness.test';
    features.homeConnectionDescriptor = descriptor;
    FeaturesResponseSchema.parse(features);
    harness.answer(homeId, '/v1/features', { body: features });
    harness.answer(homeId, '/v1/features/authenticated', { body: features });
    harness.answer(homeId, '/v1/auth/pairing/start', { status: 403, body: { error: 'forbidden' } });
    const { usePairingSession } = await import('./usePairingSession');
    const hook = await renderHook(() => usePairingSession({ enabled: true, isAuthenticated: true, targetProfileId: homeId }));
    let result: unknown;
    await act(async () => { result = await hook.getCurrent().startPairing(); });
    expect({ result, paths: harness.requests.map(request => request.path), presentation: hook.getCurrent().presentation }).toEqual({
        result: { ok: false, status: 403 }, paths: ['/v1/features', '/v1/features/authenticated', '/v1/auth/pairing/start'],
        presentation: { phase: 'invalid_request', cause: 'home_refused' },
    });
    expect(hook.getCurrent().isStarting).toBe(false);
});
