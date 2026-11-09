import { act } from 'react-test-renderer';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { renderHook, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { FeaturesResponseSchema} from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { initializeRealAppRuntimeForTests } from '@/dev/testkit/harness/realAppRuntimeHarness';

await initializeRealAppRuntimeForTests();

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
beforeEach(() => harness.reset());
afterEach(() => standardCleanup());

it('settles a refused pairing start through the real feature, transport and lifecycle owners', async () => {
    const homeId = await harness.addHome({ name: 'Pairing', serverUrl: 'https://pairing-readiness.test',
        serverIdentityId: 'srv_pairing_readiness', accountId: 'owner', currentAccount: true, active: false });
    const descriptor = { v: 1 as const, homeServerIdentityId: 'srv_pairing_readiness',
        canonicalServerUrl: 'https://pairing-readiness.test', revision: 1,
        endpoints: [{ kind: 'https' as const, url: 'https://pairing-readiness.test' }] };
    const profile = await adoptHomeProfile({ descriptor, source: 'qr', descriptorAuthority: 'current_connection_observation' });
    const features = { ...createRootLayoutFeaturesResponse(), homeConnectionDescriptor: descriptor };
    tryWriteServerEnabledBitInPlace(features, 'auth.pairing.boundQrV2', true);
    features.capabilities.serverIdentity.serverIdentityId = 'srv_pairing_readiness';
    features.capabilities.server.canonicalServerUrl = 'https://pairing-readiness.test';
    FeaturesResponseSchema.parse(features);
    harness.answer(homeId, '/v1/features', { body: features });
    harness.answer(homeId, '/v1/features/authenticated', { body: features });
    harness.answer(homeId, '/v1/auth/pairing/start', { status: 403, body: { error: 'forbidden' } });
    await harness.setActionPolicy(homeId, 'machines.pairing.create', 'ui', 'allowed');
    const { usePairingSession } = await import('./usePairingSession');
    const hook = await renderHook(() => usePairingSession({ enabled: true, isAuthenticated: true, targetProfileId: profile.id }));
    let result: unknown;
    await act(async () => { result = await hook.getCurrent().startPairing(); });
    expect({ result, presentation: hook.getCurrent().presentation }).toEqual({
        result: { ok: false, status: 403 },
        presentation: { phase: 'invalid_request', cause: 'home_refused' },
    });
    expect(harness.requests.map(request => request.path)).toContain('/v1/auth/pairing/start');
    expect(hook.getCurrent().isStarting).toBe(false);
});
