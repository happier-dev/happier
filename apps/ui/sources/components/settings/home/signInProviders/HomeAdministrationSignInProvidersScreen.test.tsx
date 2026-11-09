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
import { reportPopoverContentLayout, withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { teamCapabilitiesFixture, teamPolicyFixture, teamSummaryFixture } from '@/dev/testkit/fixtures/teamFixtures';
import { TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1 } from '@happier-dev/protocol/changes';
import { REMOTE_HOST_ROWS_ROUTE_V1 } from '@happier-dev/protocol/remoteHosts/remoteHostRecordV1';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { buildSettingHref } from '@/components/settings/catalog/settingDeclarations';
import { TEAM_AUTHENTICATION_SETTINGS } from '../../teams/identity/teamAuthenticationSettings';
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
// Opening an external page is the OS/browser boundary.
const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openExternalUrlMock }));
const routerPush = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());
installSettingsViewCommonModuleMocks({
    storage: 'real',
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ confirmResult: true }).module;
    },
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
const { IdentityConnectionDetailScreen } = await import('../../teams/identity/IdentityConnectionDetailScreen');
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
const { resetHomeGovernanceEngineForTests } = await import('@/sync/engine/home/governance/homeGovernanceEngine');
const { resetHomeGovernanceSnapshotsForTests } = await import('@/sync/store/home/governance/homeGovernanceSnapshots');
const { resetHomeSettingsEngineForTests } = await import('@/sync/engine/home/governance/homeSettingsEngine');
const { resetHomeSettingsSnapshotsForTests } = await import('@/sync/store/home/governance/homeSettingsSnapshots');
const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
const { resetRemoteHostCatalogEngineForTests } = await import('@/sync/engine/settings/remoteHostCatalogEngine');
const { resetRemoteHostCatalogSnapshotsForTests } = await import('@/sync/store/settings/remoteHostCatalogSnapshot');
const { storage } = await import('@/sync/domains/state/storage');
const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
const { publishAppliedActiveServerSnapshot, publishAppliedActiveServerRuntimeAvailability } = await import('@/sync/runtime/orchestration/appliedActiveServerRuntime');
let restorePopoverGlobals: (() => void) | undefined;

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
    resetHomeSettingsEngineForTests();
    resetHomeSettingsSnapshotsForTests();
    resetServerFeaturesClientForTests();
    resetRemoteHostCatalogEngineForTests();
    resetRemoteHostCatalogSnapshotsForTests();
    await harness.reset();
    // The real menu needs the browser frame/window boundary; leave selection,
    // availability and the scoped Action path running inside the process.
    restorePopoverGlobals = withPopoverWebGlobals();
});
afterEach(() => {
    standardCleanup();
    storage.getState().clearProfileScope();
    publishAppliedActiveServerRuntimeAvailability(false);
    restorePopoverGlobals?.();
    restorePopoverGlobals = undefined;
});

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
        await waitForHomeGovernance(() => expect(screen.findHostByTestId('home-eligible-provider:workos')).not.toBeNull());
        await act(async () => { reportPopoverContentLayout(screen.tree, { width: 320, height: 180 }); });
        await act(async () => { screen.pressByTestId('home-eligible-provider:workos'); });
        expect(routerPush).toHaveBeenLastCalledWith(`/settings/home/${serverId}/sign-in-providers/connections/new`);
        expect(harness.requestsFor('/v1/home/identity/workos/connection/create')).toHaveLength(0);
    });

    it('navigates Team WorkOS creation to the same named setup and creates nothing until the portal opens', async () => {
        const serverId = await harness.addHome({ name: 'Company Home', serverUrl: 'https://company-team.example', accountId: 'owner-1', teamsEnabled: true });
        harness.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageAuthentication: true }) }) });
        harness.answer(serverId, '/v1/teams/identity/connections/list', { body: {
            items: [], eligibleProviders: [companyChoice('team')], memberSignInUrl: null,
            admissionModeApplicability: { v: 1, modes: { invite_only: { status: 'available' }, provisioned: { status: 'unavailable', reason: 'directory_source_required' }, jit: { status: 'unavailable', reason: 'team_connection_required' } } },
        } });
        harness.answer(serverId, '/v1/teams/identity/workos/connection/create', { body: { connection: companyConnection('team-1') } });
        harness.answer(serverId, '/v1/teams/identity/workos/admin-portal-link/create', { body: { url: 'https://portal.workos.example/setup' } });
        openExternalUrlMock.mockClear();
        const screen = await renderScreen(<TeamAuthenticationSettingsScreen serverId={serverId} teamId="team-1" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-authentication-add-connection')).not.toBeNull());
        await act(async () => { screen.pressByTestId('team-authentication-add-connection'); });
        await waitForHomeGovernance(() => expect(screen.findHostByTestId('team-eligible-provider:workos_sso')).not.toBeNull());
        await act(async () => { reportPopoverContentLayout(screen.tree, { width: 320, height: 180 }); });
        await act(async () => { screen.pressByTestId('team-eligible-provider:workos_sso'); });
        expect(routerPush).toHaveBeenLastCalledWith(`/settings/teams/${serverId}/team-1/authentication/new?kind=workos_sso`);
        expect(harness.requestsFor('/v1/teams/identity/workos/connection/create')).toHaveLength(0);
        await screen.update(<TeamIdentityProviderSetupScreen serverId={serverId} teamId="team-1" providerKind="workos_sso" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('identity-workos-company-name')?.props.editable).toBe(true));
        await act(async () => { screen.changeTextByTestId('identity-workos-company-name', 'Acme'); });
        await screen.pressByTestIdAsync('identity-workos-create');
        await waitForHomeGovernance(() => expect(routerReplace).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/authentication/company-connection`));
        expect(harness.requestsFor('/v1/teams/identity/workos/connection/create').map((request) => request.input)).toEqual([{ v: 1, teamId: 'team-1', displayName: 'Acme' }]);
        // The one submit is opening the portal: the draft and its portal link are made together.
        expect(harness.requestsFor('/v1/teams/identity/workos/admin-portal-link/create').map((request) => request.input))
            .toEqual([{ v: 1, teamId: 'team-1', connectionId: 'company-connection', intent: 'sso' }]);
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://portal.workos.example/setup');
    });

    it('explains why WorkOS cannot be set up instead of offering a form that cannot succeed', async () => {
        const serverId = await harness.addHome({ name: 'Company Home', serverUrl: 'https://company-team-blocked.example', accountId: 'owner-1', teamsEnabled: true });
        harness.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageAuthentication: true }) }) });
        harness.answer(serverId, '/v1/teams/identity/connections/list', { body: {
            items: [],
            eligibleProviders: [{ ...companyChoice('team'), availability: { status: 'unavailable', code: 'workos_platform_unavailable' } }],
            memberSignInUrl: null,
            admissionModeApplicability: { v: 1, modes: { invite_only: { status: 'available' }, provisioned: { status: 'unavailable', reason: 'directory_source_required' }, jit: { status: 'unavailable', reason: 'team_connection_required' } } },
        } });
        const screen = await renderScreen(<TeamIdentityProviderSetupScreen serverId={serverId} teamId="team-1" providerKind="workos_sso" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('identity-workos-unavailable')).not.toBeNull());
        expect(screen.findByTestId('identity-workos-company-name')).toBeNull();
        expect(screen.findByTestId('identity-workos-create')).toBeNull();
        expect(harness.requestsFor('/v1/teams/identity/workos/connection/create')).toHaveLength(0);
    });

    it('keeps WorkOS setup available while the managed-provider read is unavailable, without admitting OIDC creation', async () => {
        const serverId = await harness.addHome({ name: 'Company Home', serverUrl: 'https://company-home-read-failure.example', accountId: 'owner-1' });
        harness.answer(serverId, '/v1/home/governance/get', { body: homeGovernanceProjectionFixture() });
        harness.answer(serverId, '/v1/home/settings/get', { body: homeSettingsProjectionFixture() });
        harness.answer(serverId, '/v1/identity/providers/list', { status: 503, body: { error: 'unavailable' } });
        harness.answer(serverId, '/v1/home/identity/connections/list', { body: { items: [], eligibleProviders: [companyChoice('home')] } });
        const screen = await renderScreen(<HomeAdministrationSignInProvidersScreen serverId={serverId} />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('home-identity-providers-unavailable')).not.toBeNull());
        await waitForHomeGovernance(() => expect(screen.findHostByTestId('home-identity-provider-add')?.props.accessibilityState).toMatchObject({ disabled: false }));
        await act(async () => { screen.pressByTestId('home-identity-provider-add'); });
        await waitForHomeGovernance(() => expect(screen.findHostByTestId('home-eligible-provider:oidc')).not.toBeNull());
        await act(async () => { reportPopoverContentLayout(screen.tree, { width: 320, height: 180 }); });
        await act(async () => { screen.pressByTestId('home-eligible-provider:oidc'); });
        expect(routerPush).not.toHaveBeenCalled();
        await act(async () => { screen.pressByTestId('home-eligible-provider:workos'); });
        expect(routerPush).toHaveBeenLastCalledWith(`/settings/home/${serverId}/sign-in-providers/connections/new`);
    });

    it('shows current Team accepted-sign-in policy on the shared active connection and opens its existing owner', async () => {
        const serverId = await harness.addHome({ name: 'Company Home', serverUrl: 'https://company-team-policy.example', accountId: 'owner-1', teamsEnabled: true });
        const team = teamSummaryFixture({ capabilities: teamCapabilitiesFixture({ manageAuthentication: true }), policy: teamPolicyFixture({
            authenticationPolicy: { v: 1, mode: 'restricted', accepted: [{ kind: 'team_connection', connectionId: 'company-connection' }, { kind: 'home_method', methodId: 'github' }] },
        }) });
        harness.answer(serverId, '/v1/teams/get', { body: team });
        harness.answer(serverId, '/v1/teams/identity/connections/list', { body: {
            items: [{ ...companyConnection('team-1'), enabled: true, firstEnabledAt: 1, state: 'connected', externalReference: { v: 1, kind: 'workos_sso', organizationId: 'org_acme', connectionId: 'conn_acme' } }],
            eligibleProviders: [], memberSignInUrl: null,
            admissionModeApplicability: { v: 1, modes: { invite_only: { status: 'available' }, provisioned: { status: 'unavailable', reason: 'directory_source_required' }, jit: { status: 'unavailable', reason: 'team_connection_required' } } },
        } });
        const screen = await renderScreen(<IdentityConnectionDetailScreen serverId={serverId} teamId="team-1" connectionId="company-connection" />);
        await waitForHomeGovernance(() => expect(screen.findHostByTestId('identity-workos-current-connection')).not.toBeNull());
        expect(screen.findHostByTestId('identity-workos-required-for-team')).not.toBeNull();
        expect(screen.getTextContent()).toContain('common.yes');
        expect(screen.getTextContent()).not.toContain('identityAdministration.homeWorkosCompanyName');
        await screen.pressByTestIdAsync('identity-workos-required-for-team');
        expect(routerPush).toHaveBeenLastCalledWith(buildSettingHref(`/settings/teams/${serverId}/team-1/authentication`, TEAM_AUTHENTICATION_SETTINGS.settings.acceptedMethods));

        harness.answer(serverId, '/v1/teams/get', { body: { ...team, policy: teamPolicyFixture() } });
        await act(async () => { publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]); });
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('common.no'));
        harness.answer(serverId, '/v1/teams/get', { body: { ...team, policy: teamPolicyFixture({ authenticationPolicyStatus: 'repair_required' }) } });
        await act(async () => { publishHomeAccountChange(serverId, [TEAMS_ACCOUNT_CHANGE_ENTITY_ID_V1]); });
        await waitForHomeGovernance(() => expect(screen.getTextContent()).toContain('teams.authentication.policy.repairRequired'));
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
        expect(harness.requestsFor('/v1/identity/providers/list')).toHaveLength(0);
        expect(harness.requestsFor('/v1/identity/github-apps/list')).toHaveLength(0);
        expect(screen.findByTestId('home-policy-identity-network-mode:public_only')).not.toBeNull();
        expect(screen.findHostByTestId('home-policy-identity-network-mode:public_only')?.props.accessibilityState).toMatchObject({ disabled: true });
        expect(screen.findByTestId('home-policy-identity-network-save')).toBeNull();
    });

    it('edits WorkOS in place: nothing is written until Save, then one write carries the field and the secret', async () => {
        const serverId = await harness.addHome({ name: 'Acme Home', serverUrl: 'https://acme-home-workos.example', accountId: 'owner-1' });
        // The executor consumes the real active Account and applied-runtime owners. With no
        // pending change it must not demand that Account's remote-host catalog at all.
        storage.getState().activateProfileScope({ serverId, accountId: 'owner-1' });
        publishAppliedActiveServerSnapshot(getActiveServerSnapshot());
        harness.answer(serverId, REMOTE_HOST_ROWS_ROUTE_V1, { body: {
            status: 'present', revision: 1, content: { t: 'plain', v: { v: 1, hosts: [] } },
        } });
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
        expect(harness.requestsFor(REMOTE_HOST_ROWS_ROUTE_V1)).toHaveLength(0);
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
        await waitForHomeGovernance(() => expect(harness.requestsFor(REMOTE_HOST_ROWS_ROUTE_V1)).toHaveLength(1));
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
