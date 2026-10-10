import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { homeGovernanceProjectionFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

const routeParams = vi.hoisted(() => ({ value: {} as Record<string, string> }));
installSettingsViewCommonModuleMocks({
    storage: async (importOriginal) => await importOriginal(),
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ params: () => routeParams.value, navigation: { setOptions: () => undefined } }).module;
    },
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { HomeAdministrationPoliciesScreen } = await import('./HomeAdministrationPoliciesScreen');
const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
const { resetHomeGovernanceSnapshotsForTests } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');

beforeEach(async () => {
    standardCleanup();
    routeParams.value = {};
    resetHomeGovernanceEngineForTests();
    resetHomeGovernanceSnapshotsForTests();
    await harness.reset();
});
afterEach(() => standardCleanup());

describe('Home policy settings search', () => {
    it('lets an administrator read the sign-in and encryption policy the owner sets, and reveals a requested field there', async () => {
        const serverId = await harness.addHome({ name: 'Home policy search', serverUrl: 'https://home-policy-search.example', accountId: 'account-ada' });
        const projection = homeGovernanceProjectionFixture({
            authenticationOptions: {
                methods: [{ id: 'key_challenge', displayName: 'Device key', actions: [{ id: 'login', enabled: true, mode: 'keyed' }] }],
                permittedAccountModes: ['e2ee'],
                recommendedProvisioningMode: 'e2ee',
                signInService: { deploymentMode: null, canDisable: false },
            },
        });
        // An admin: reads the administration state (plan I4), may not change sign-in or encryption.
        projection.capabilities = { ...projection.capabilities, viewAdministration: true, manageAuthentication: false };
        harness.answer(serverId, '/v1/home/governance/get', { body: projection });
        routeParams.value = { setting: 'homeAdministration.authenticationPolicy.recommendedProvisioningMode' };
        const screen = await renderScreen(<HomeAdministrationPoliciesScreen serverId={serverId} />);

        await waitForHomeGovernance(() => expect(screen.findByTestId('home-policy-auth-method:key_challenge')).not.toBeNull());
        // Team creation is the Teams page's (DR-09), not a second control here.
        expect(screen.findByTestId('home-policy-team-creation')).toBeNull();
        await waitForHomeGovernance(() => expect(screen.findByTestId('setting-reveal.homeAdministration.authenticationPolicy.recommendedProvisioningMode')).not.toBeNull());
        // The owner's choices are on the page, read-only: nothing to switch and nothing to save.
        expect(screen.findByTestId('home-policy-auth-method:key_challenge-switch')?.props.disabled).toBe(true);
        expect(screen.findByTestId('home-policy-auth-recommended:e2ee')).not.toBeNull();
        expect(screen.findByTestId('home-policy-auth-save')).toBeNull();
        expect(harness.requestsFor('/v1/home/policy/set')).toHaveLength(0);
    });
});
