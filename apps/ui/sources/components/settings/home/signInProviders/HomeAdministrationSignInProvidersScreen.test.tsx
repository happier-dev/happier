import * as React from 'react';
import { act } from 'react-test-renderer';
import type { HomeSettingEntryV1 } from '@happier-dev/protocol/home/governance';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import {
    homeGovernanceProjectionFixture,
    homeSettingEntryFixture,
    homeSettingsProjectionFixture,
} from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { teamCapabilitiesFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { installSettingsViewCommonModuleMocks } from '../../settingsViewTestHelpers';

const workosClientId = (overrides?: Partial<HomeSettingEntryV1>) => homeSettingEntryFixture('WORKOS_CLIENT_ID', {
    apply: 'restart',
    declaration: { type: 'string', section: 'policies', group: 'workos' },
    applied: { value: null, pending: false },
    ...overrides,
});
const workosApiKey = (overrides?: Partial<HomeSettingEntryV1>) => homeSettingEntryFixture('WORKOS_API_KEY', {
    apply: 'restart',
    secretSet: false,
    declaration: { type: 'string', section: 'policies', group: 'workos' },
    applied: { value: null, pending: false },
    ...overrides,
});

const routeParams = vi.hoisted(() => ({ value: {} as Record<string, string> }));
const routerPush = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());
installSettingsViewCommonModuleMocks({
    storage: async (importOriginal) => await importOriginal(),
    router: async () => {
        const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
        return createExpoRouterMock({ params: () => routeParams.value, navigation: { setOptions: () => undefined }, router: { push: routerPush, replace: routerReplace, dismissTo: vi.fn() } }).module;
    },
});
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { HomeAdministrationSignInProvidersScreen } = await import('./HomeAdministrationSignInProvidersScreen');
const { TeamAuthenticationSettingsScreen } = await import('../../teams/identity/TeamAuthenticationSettingsScreen');
const { TeamIdentityProviderSetupScreen } = await import('../../teams/identity/TeamIdentityProviderSetupScreen');
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
const { resetHomeGovernanceSnapshotsForTests } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');

beforeEach(async () => {
    standardCleanup();
    routeParams.value = {};
    routerPush.mockReset();
    routerReplace.mockReset();
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    resetHomeGovernanceEngineForTests();
    resetHomeGovernanceSnapshotsForTests();
    resetServerFeaturesClientForTests();
    await harness.reset();
});
afterEach(() => standardCleanup());

describe('Sign-in providers page', () => {
    const companyConnection = (teamId: string | null) => ({
        v: 1, id: 'company-connection', teamId,
        provider: { id: 'company-provider', kind: 'workos_sso', displayName: 'Acme' },
        externalReference: { v: 1, kind: 'workos_sso', organizationId: null, connectionId: null },
        settings: { v: 1, kind: 'workos_sso' }, enabled: false, firstEnabledAt: null,
        revision: 1, state: 'setting_up', lastObservation: null, lastSuccessfulTest: null,
        allowedActions: [`${teamId === null ? 'home' : 'teams'}.identity.workos.adminPortalLink.create`], createdAt: 1, updatedAt: 1,
    });
    const companyChoice = (owner: 'home' | 'team') => ({
        v: 1, providerKind: 'workos_sso', providerId: null, displayName: null, owner,
        availability: { status: 'available', setupChoice: { kind: 'create_managed', actionId: `${owner === 'home' ? 'home' : 'teams'}.identity.workos.connection.create` } },
    });

    it('opens a Home company connection and offers WorkOS setup from the existing provider collection', async () => {
        const serverId = await harness.addHome({ name: 'Company Home', serverUrl: 'https://company-home.example', accountId: 'owner-1' });
        harness.answer(serverId, '/v1/home/governance/get', { body: homeGovernanceProjectionFixture() });
        harness.answer(serverId, '/v1/home/settings/get', { body: homeSettingsProjectionFixture() });
        harness.answer(serverId, '/v1/identity/providers/list', { body: { items: [], unreadableCount: 0 } });
        harness.answer(serverId, '/v1/home/identity/connections/list', { body: { items: [companyConnection(null)], eligibleProviders: [companyChoice('home')] } });
        const screen = await renderScreen(<HomeAdministrationSignInProvidersScreen serverId={serverId} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-identity-connection:company-connection')).not.toBeNull());
        await act(async () => { screen.pressByTestId('home-identity-connection:company-connection'); });
        expect(routerPush).toHaveBeenLastCalledWith(`/settings/home/${serverId}/sign-in-providers/connections/company-connection`);
        await act(async () => { screen.pressByTestId('home-identity-provider-add'); });
        await act(async () => { screen.pressByTestId('home-eligible-provider:workos'); });
        expect(routerPush).toHaveBeenLastCalledWith(`/settings/home/${serverId}/sign-in-providers/connections/new`);
        expect(harness.requestsFor('/v1/home/identity/workos/connection/create')).toHaveLength(0);
    });

    it('navigates Team WorkOS creation to the same named setup and creates only after submission', async () => {
        const serverId = await harness.addHome({ name: 'Company Home', serverUrl: 'https://company-team.example', accountId: 'owner-1', teamsEnabled: true });
        harness.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageAuthentication: true }) }) });
        harness.answer(serverId, '/v1/teams/identity/connections/list', { body: {
            items: [], eligibleProviders: [companyChoice('team')], memberSignInUrl: null,
            admissionModeApplicability: { v: 1, modes: { invite_only: { status: 'available' }, provisioned: { status: 'unavailable', reason: 'directory_source_required' }, jit: { status: 'unavailable', reason: 'team_connection_required' } } },
        } });
        harness.answer(serverId, '/v1/teams/identity/workos/connection/create', { body: { connection: companyConnection('team-1') } });
        const screen = await renderScreen(<TeamAuthenticationSettingsScreen serverId={serverId} teamId="team-1" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-authentication-add-connection')).not.toBeNull());
        await act(async () => { screen.pressByTestId('team-authentication-add-connection'); });
        await act(async () => { screen.pressByTestId('team-eligible-provider:workos_sso'); });
        expect(routerPush).toHaveBeenLastCalledWith(`/settings/teams/${serverId}/team-1/authentication/new?kind=workos_sso`);
        expect(harness.requestsFor('/v1/teams/identity/workos/connection/create')).toHaveLength(0);
        await screen.update(<TeamIdentityProviderSetupScreen serverId={serverId} teamId="team-1" providerKind="workos_sso" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('identity-workos-company-name')?.props.editable).toBe(true));
        await act(async () => { screen.changeTextByTestId('identity-workos-company-name', 'Acme'); });
        await screen.pressByTestIdAsync('identity-workos-create');
        await waitForHomeGovernance(() => expect(routerReplace).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/authentication/company-connection`));
        expect(harness.requestsFor('/v1/teams/identity/workos/connection/create').map((request) => request.input)).toEqual([{ v: 1, teamId: 'team-1', displayName: 'Acme' }]);
    });
    it('lists what the deployment provides beside the Home\'s own providers, with the key that sets it', async () => {
        const serverId = await harness.addHome({ name: 'Acme Home', serverUrl: 'https://acme-home.example', accountId: 'owner-1' });
        harness.answer(serverId, '/v1/home/governance/get', {
            body: homeGovernanceProjectionFixture({
                identityServices: {
                    workos: 'partially_configured',
                    privateIdentityNetworkAllowed: false,
                    teamProviderKinds: ['oidc'],
                    deploymentOidcProviders: [
                        { id: 'acme-sso', displayName: 'Acme SSO', sourceKey: 'AUTH_PROVIDERS_CONFIG_PATH' },
                    ],
                },
            }),
        });
        harness.answer(serverId, '/v1/home/settings/get', {
            body: homeSettingsProjectionFixture({
                entries: [
                    workosApiKey({ source: 'deployment', fixed: true, secretSet: true }),
                    workosClientId(),
                    homeSettingEntryFixture('HAPPIER_FEATURE_AUTH_MANAGED_IDENTITY__PRIVATE_NETWORK_ENABLED', { source: 'deployment', fixed: true }),
                ],
            }),
        });

        const screen = await renderScreen(<HomeAdministrationSignInProvidersScreen serverId={serverId} />);

        await waitForHomeGovernance(() => expect(screen.findByTestId('home-sign-in-deployment-oidc:acme-sso')).not.toBeNull());
        expect(screen.getTextContent()).toContain('Acme SSO');
        // Read-only and from the deployment, without its env key as body copy (DR-17).
        expect(screen.getTextContent()).toContain('homeGovernance.signInProviders.fromDeploymentReadOnly');
        expect(screen.getTextContent()).not.toContain('AUTH_PROVIDERS_CONFIG_PATH');
        // WorkOS is a sign-in platform, never a row of the OIDC list; the deployment locks per key.
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-sign-in-platform:workos')).not.toBeNull());
        expect(screen.findByTestId('home-sign-in-workos')).toBeNull();
        expect(screen.getTextContent()).not.toContain('WORKOS_API_KEY, WORKOS_CLIENT_ID');
        expect(screen.findByTestId('home-sign-in-private-endpoints-unavailable.fixed-key:0')).not.toBeNull();
        expect(screen.findByTestId('home-sign-in-providers-owners-only')).toBeNull();
    });

    it('shows already-authorised sign-in facts to an admin without requesting managed providers or offering mutations', async () => {
        const serverId = await harness.addHome({ name: 'Acme Home', serverUrl: 'https://acme-home-admin.example', accountId: 'admin-1' });
        const projection = homeGovernanceProjectionFixture();
        projection.viewer = { ...projection.viewer, homeRole: 'admin' };
        projection.capabilities = { ...projection.capabilities, manageAuthentication: false };
        projection.identityServices = {
            workos: 'partially_configured', privateIdentityNetworkAllowed: true, teamProviderKinds: ['oidc'],
            deploymentOidcProviders: [{ id: 'acme-sso', displayName: 'Acme SSO', sourceKey: 'AUTH_PROVIDERS_CONFIG_PATH' }],
        };
        harness.answer(serverId, '/v1/home/governance/get', { body: projection });
        harness.answer(serverId, '/v1/home/settings/get', { body: homeSettingsProjectionFixture() });

        const screen = await renderScreen(<HomeAdministrationSignInProvidersScreen serverId={serverId} />);

        await waitForHomeGovernance(() => expect(screen.findByTestId('home-sign-in-providers-owners-only')).not.toBeNull());
        expect(screen.findByTestId('home-sign-in-deployment-oidc:acme-sso')).not.toBeNull();
        expect(screen.findByTestId('home-identity-provider-add')).toBeNull();
        expect(screen.findByTestId('home-policy-team-jit')).not.toBeNull();
        expect(screen.findHostByTestId('home-policy-team-jit')?.props.accessibilityState).toMatchObject({ disabled: true });
        expect(screen.findByTestId('home-policy-team-jit')?.props.onPress).toBeUndefined();
        expect(harness.requestsFor('/v1/identity/providers/list')).toHaveLength(0);
        expect(harness.requestsFor('/v1/identity/github-apps/list')).toHaveLength(0);
        expect(screen.findByTestId('home-policy-identity-network-mode:public_only')).not.toBeNull();
        expect(screen.findHostByTestId('home-policy-identity-network-mode:public_only')?.props.accessibilityState).toMatchObject({ disabled: true });
        expect(screen.findByTestId('home-policy-identity-network-save')).toBeNull();
    });

    it('edits WorkOS in place: nothing is written until Save, then one write carries the field and the secret', async () => {
        const serverId = await harness.addHome({ name: 'Acme Home', serverUrl: 'https://acme-home-workos.example', accountId: 'owner-1' });
        harness.answer(serverId, '/v1/home/governance/get', { body: homeGovernanceProjectionFixture() });
        harness.answer(serverId, '/v1/home/settings/get', {
            body: homeSettingsProjectionFixture({ revision: 4, entries: [workosApiKey(), workosClientId()] }),
        });
        harness.answer(serverId, '/v1/home/settings/set', {
            body: homeSettingsProjectionFixture({
                revision: 5,
                entries: [
                    workosApiKey({ secretSet: true, source: 'home', applied: { value: null, pending: true } }),
                    workosClientId({ value: 'client_01', source: 'home', applied: { value: null, pending: true } }),
                ],
            }),
        });

        const screen = await renderScreen(<HomeAdministrationSignInProvidersScreen serverId={serverId} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-sign-in-platform:workos')).not.toBeNull());
        expect(screen.getTextContent()).toContain('homeGovernance.signInProviders.notSetWorkos');

        await act(async () => { screen.pressByTestId('home-sign-in-platform:workos.header'); });
        await act(async () => {
            screen.findByTestId('home-sign-in-platform-setting:WORKOS_CLIENT_ID.input')?.props.onChangeText('client_01');
        });
        await act(async () => { screen.findByTestId('home-sign-in-platform-setting:WORKOS_CLIENT_ID.input')?.props.onBlur?.(); });
        // An unset key is an open masked field, never a "Set" step before it (lab `hcSignin-RN`).
        expect(screen.findByTestId('home-sign-in-platform-setting:WORKOS_API_KEY-set')).toBeNull();
        // Each key says where its value comes from and what happens to it.
        expect(screen.getTextContent()).toContain('homeGovernance.signInProviders.workosClientIdHint');
        expect(screen.getTextContent()).toContain('homeGovernance.signInProviders.secretHintUnset');
        await act(async () => {
            screen.findByTestId('home-sign-in-platform-setting:WORKOS_API_KEY-input')?.props.onChangeText('sk_test_1');
        });
        // Leaving a field never writes; only the row's Save does.
        expect(harness.requestsFor('/v1/home/settings/set')).toHaveLength(0);
        expect(screen.findByTestId('home-sign-in-platform-setting:WORKOS_API_KEY-save')).toBeNull();

        await act(async () => { screen.pressByTestId('home-sign-in-platform:workos.save'); });

        await waitForHomeGovernance(() => {
            expect(harness.requestsFor('/v1/home/settings/set').map((request) => request.input)).toEqual([{
                expectedRevision: 4,
                values: { WORKOS_CLIENT_ID: 'client_01' },
                secrets: { WORKOS_API_KEY: { replace: 'sk_test_1' } },
            }]);
            expect(screen.getTextContent()).toContain('homeGovernance.signInProviders.pendingSummaryWorkos');
            expect(screen.findByTestId('home-runtime-pending-restart')).not.toBeNull();
        });
    });

    it('says at the top of the page that the last start ignored a sign-in setting, and leads to its row', async () => {
        const serverId = await harness.addHome({ name: 'Acme Home', serverUrl: 'https://acme-home-ignored.example', accountId: 'owner-1' });
        harness.answer(serverId, '/v1/home/governance/get', { body: homeGovernanceProjectionFixture() });
        harness.answer(serverId, '/v1/home/settings/get', {
            body: homeSettingsProjectionFixture({
                entries: [
                    workosApiKey({ secretSet: true, source: 'home', applied: { value: null, pending: false, ignoredReason: 'secret_unreadable' } }),
                    workosClientId({ value: 'client_01', source: 'home' }),
                ],
            }),
        });

        const screen = await renderScreen(<HomeAdministrationSignInProvidersScreen serverId={serverId} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-sign-in-ignored')).not.toBeNull());
        await act(async () => { screen.pressByTestId('home-sign-in-ignored.action'); });
        expect(routerPush).toHaveBeenLastCalledWith(`/settings/home/${serverId}/sign-in-providers?setting=${encodeURIComponent(
            'homeAdministration.signInProviders.workos',
        )}`);
    });

    it('shows no ignored notice while every sign-in setting was applied', async () => {
        const serverId = await harness.addHome({ name: 'Acme Home', serverUrl: 'https://acme-home-applied.example', accountId: 'owner-1' });
        harness.answer(serverId, '/v1/home/governance/get', { body: homeGovernanceProjectionFixture() });
        harness.answer(serverId, '/v1/home/settings/get', {
            body: homeSettingsProjectionFixture({ entries: [workosApiKey({ secretSet: true, source: 'home' }), workosClientId({ value: 'client_01', source: 'home' })] }),
        });

        const screen = await renderScreen(<HomeAdministrationSignInProvidersScreen serverId={serverId} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-sign-in-platform:workos')).not.toBeNull());
        expect(screen.findByTestId('home-sign-in-ignored')).toBeNull();
    });

    it('locks per key: a deployment-set API key is read-only while the client ID stays editable', async () => {
        const serverId = await harness.addHome({ name: 'Acme Home', serverUrl: 'https://acme-home-locked.example', accountId: 'owner-1' });
        harness.answer(serverId, '/v1/home/governance/get', { body: homeGovernanceProjectionFixture() });
        harness.answer(serverId, '/v1/home/settings/get', {
            body: homeSettingsProjectionFixture({
                entries: [
                    workosApiKey({ source: 'deployment', fixed: true, secretSet: true }),
                    workosClientId({ value: 'client_01', source: 'home' }),
                ],
            }),
        });

        const screen = await renderScreen(<HomeAdministrationSignInProvidersScreen serverId={serverId} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-sign-in-platform:workos')).not.toBeNull());
        expect(screen.getTextContent()).toContain('homeGovernance.signInProviders.readyPartlyLocked');
        await act(async () => { screen.pressByTestId('home-sign-in-platform:workos.header'); });

        expect(screen.findByTestId('home-sign-in-platform-setting:WORKOS_CLIENT_ID.input')).not.toBeNull();
        expect(screen.findByTestId('home-sign-in-platform-setting:WORKOS_API_KEY.fixed-key:0')).not.toBeNull();
        expect(screen.findByTestId('home-sign-in-platform-setting:WORKOS_API_KEY-replace')).toBeNull();
        expect(screen.findByTestId('home-sign-in-platform-setting:WORKOS_API_KEY-input')).toBeNull();
    });

    it('shows an admin the platforms as facts, without fields or Save', async () => {
        const serverId = await harness.addHome({ name: 'Acme Home', serverUrl: 'https://acme-home-platform-admin.example', accountId: 'admin-1' });
        const projection = homeGovernanceProjectionFixture();
        projection.viewer = { ...projection.viewer, homeRole: 'admin' };
        projection.capabilities = { ...projection.capabilities, manageAuthentication: false, manageHomeSettings: false };
        harness.answer(serverId, '/v1/home/governance/get', { body: projection });
        harness.answer(serverId, '/v1/home/settings/get', {
            body: homeSettingsProjectionFixture({ entries: [workosApiKey({ secretSet: true, source: 'home' }), workosClientId()] }),
        });

        const screen = await renderScreen(<HomeAdministrationSignInProvidersScreen serverId={serverId} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-sign-in-platform:workos')).not.toBeNull());
        await act(async () => { screen.pressByTestId('home-sign-in-platform:workos.header'); });

        expect(screen.findByTestId('home-sign-in-platform-setting:WORKOS_CLIENT_ID')).not.toBeNull();
        expect(screen.findByTestId('home-sign-in-platform-setting:WORKOS_CLIENT_ID.input')).toBeNull();
        expect(screen.findByTestId('home-sign-in-platform-setting:WORKOS_API_KEY-replace')).toBeNull();
        expect(screen.findByTestId('home-sign-in-platform:workos.save')).toBeNull();
    });
});
