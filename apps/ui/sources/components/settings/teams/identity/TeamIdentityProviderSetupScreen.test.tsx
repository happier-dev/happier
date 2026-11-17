import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagedIdentityProviderV1Schema } from '@happier-dev/protocol/identity/providers';
import { TeamIdentityConnectionListResultV1Schema, TeamIdentityConnectionCreateInputV1Schema } from '@happier-dev/protocol/teams';
import { createDeferred, renderScreen, standardCleanup } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { managedIdentityProviderFixture } from '@/dev/testkit/fixtures/homeGovernanceFixtures';
import { teamCapabilitiesFixture, teamSummaryFixture, teamIdentityConnectionFixture } from '@/dev/testkit/fixtures/teamFixtures';

const routerReplaceMock = vi.hoisted(() => vi.fn());
const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => true));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openExternalUrlMock }));
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { replace: routerReplaceMock } }).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
// Generated app bytes are a build boundary; no identity catalog or owner is replaced.
vi.mock('@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts', () => ({
    BUNDLED_PLUGIN_UI_APP_ARTIFACTS: [], BUNDLED_PLUGIN_UI_APP_DECLARATIONS: [],
}));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { TeamIdentityProviderSetupScreen } = await import('./TeamIdentityProviderSetupScreen');
const { Modal } = await import('@/modal');
const { resetTeamsSnapshotsForTests } = await import('@/sync/store/teams/teamsSnapshots');
const { resetTeamsDirectoryEngineForTests } = await import('@/sync/engine/teams/teamsDirectoryEngine');
const { resetTeamActionClientForTests } = await import('@/sync/ops/teams/teamActionClient');
let serverId: string;
const providerCreatePath = '/v1/identity/providers/create';
const providerUpdatePath = '/v1/identity/providers/update';
const providerSecretPath = '/v1/identity/providers/secret/replace';
const providerValidatePath = '/v1/identity/providers/validate';
const connectionCreatePath = '/v1/teams/identity/connections/create';
const workosCreatePath = '/v1/teams/identity/workos/connection/create';
const portalPath = '/v1/teams/identity/workos/admin-portal-link/create';
function connection(id = 'connection-1', kind: 'oidc' | 'workos_sso' = 'oidc') {
    return teamIdentityConnectionFixture({
        v: 1, id, teamId: 'team-1', provider: { id: 'provider-1', kind, displayName: 'Corporate OIDC' },
        externalReference: kind === 'oidc' ? { v: 1, kind } : { v: 1, kind, organizationId: 'org-1', connectionId: null },
        settings: kind === 'oidc' ? { v: 1, kind, allowedUsers: [], allowedEmailDomains: [], groupsAny: [], groupsAll: [] } : { v: 1, kind },
        enabled: false, firstEnabledAt: null, revision: 1, state: 'disabled', allowedActions: [],
        lastObservation: null, lastSuccessfulTest: null, createdAt: 1, updatedAt: 1,
    });
}
function answerTeam(teamId = 'team-1', archived = false) {
    harness.answer(serverId, '/v1/teams/get', { body: teamSummaryFixture({ id: teamId,
        archivedAt: archived ? 1 : null, capabilities: teamCapabilitiesFixture({ manageAuthentication: true }) }) });
}
async function renderSetup(providerKind: 'oidc' | 'workos_sso' = 'oidc') {
    const screen = await renderScreen(<TeamIdentityProviderSetupScreen serverId={serverId} teamId="team-1" providerKind={providerKind} />);
    await waitForHomeGovernance(() => expect(screen.findByTestId(providerKind === 'oidc' ? 'team-oidc-name' : 'identity-workos-company-name')).not.toBeNull());
    return screen;
}
async function fillOidc(screen: Awaited<ReturnType<typeof renderScreen>>) {
    await act(async () => {
        screen.changeTextByTestId('team-oidc-name', 'Corporate OIDC');
        screen.changeTextByTestId('team-oidc-issuer', 'https://id.example');
        screen.changeTextByTestId('team-oidc-client-id', 'client-1');
        screen.changeTextByTestId('team-oidc-client-secret', 'secret-1');
    });
}

const provider = (revision = 4) => managedIdentityProviderFixture({ owner: { kind: 'team', teamId: 'team-1' }, revision });

beforeEach(async () => {
    standardCleanup();
    resetTeamsSnapshotsForTests();
    resetTeamsDirectoryEngineForTests();
    resetTeamActionClientForTests();
    await harness.reset();
    serverId = await harness.addHome({ name: 'Identity Home', serverUrl: 'https://identity-home.example', accountId: 'account-1', teamsEnabled: true });
    await harness.selectHomes([serverId]);
    answerTeam();
    harness.answer(serverId, providerCreatePath, { body: provider() });
    harness.answer(serverId, providerUpdatePath, { body: provider(5) });
    harness.answer(serverId, providerSecretPath, { body: provider(6) });
    harness.answer(serverId, providerValidatePath, { body: provider(5) });
    harness.answer(serverId, connectionCreatePath, { body: { connection: connection() } });
    routerReplaceMock.mockReset();
    openExternalUrlMock.mockReset().mockResolvedValue(true);
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(true);
});

describe('TeamIdentityProviderSetupScreen through its real Action clients', () => {
    it('creates nothing for WorkOS until the portal opens, then opens it on the new connection', async () => {
        harness.answer(serverId, '/v1/teams/identity/connections/list', { body: TeamIdentityConnectionListResultV1Schema.parse({
            items: [], memberSignInUrl: null,
            admissionModeApplicability: { v: 1, modes: { invite_only: { status: 'available' }, provisioned: { status: 'available' }, jit: { status: 'available' } } },
            eligibleProviders: [{ v: 1, providerKind: 'workos_sso', providerId: null, displayName: null, owner: 'team',
                availability: { status: 'available', setupChoice: { kind: 'create_managed', actionId: 'teams.identity.workos.connection.create' } } }],
        }) });
        harness.answer(serverId, workosCreatePath, { body: { connection: connection('connection-1', 'workos_sso') } });
        harness.answer(serverId, portalPath, { body: { url: 'https://portal.workos.example/setup' } });
        const screen = await renderSetup('workos_sso');
        await waitForHomeGovernance(() => expect(screen.findByTestId('identity-workos-company-name')?.props.editable).toBe(true));
        await act(async () => screen.changeTextByTestId('identity-workos-company-name', 'Northwind Studio'));
        expect(harness.requestsFor(workosCreatePath)).toHaveLength(0);
        await screen.pressByTestIdAsync('identity-workos-create');
        expect(harness.requests.filter(request => request.path === workosCreatePath || request.path === portalPath)
            .map(request => [request.path, request.input])).toEqual([
            [workosCreatePath, { v: 1, teamId: 'team-1', displayName: 'Northwind Studio' }],
            [portalPath, { v: 1, teamId: 'team-1', connectionId: 'connection-1', intent: 'sso' }],
        ]);
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://portal.workos.example/setup');
        expect(routerReplaceMock).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/authentication/connection-1`);
    });

    it('keeps Team-owned provider fields read-only when Team mutations are unavailable', async () => {
        answerTeam('team-1', true);
        const screen = await renderSetup();
        expect(screen.findByTestId('team-oidc-name')?.props.editable).toBe(false);
        expect(screen.findByTestId('team-oidc-allowed-users')?.props.editable).toBe(false);
        expect(screen.findByTestId('team-oidc-create')?.props.disabled).toBe(true);
    });

    it('does not carry a provider draft across an exact Team route change', async () => {
        const screen = await renderSetup();
        await fillOidc(screen);
        answerTeam('team-2');
        await screen.update(<TeamIdentityProviderSetupScreen serverId={serverId} teamId="team-2" providerKind="oidc" />);
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-oidc-name')?.props.value).toBe(''));
        expect(screen.findByTestId('team-oidc-client-secret')?.props.value).toBe('');
    });

    it('labels Team-specific restriction fields for screen readers', async () => {
        const screen = await renderSetup();
        expect(screen.findByTestId('team-oidc-allowed-users')?.props.accessibilityLabel).toBe('teams.authentication.detail.allowedUsers');
        expect(screen.findByTestId('team-oidc-allowed-domains')?.props.accessibilityLabel).toBe('teams.authentication.detail.allowedDomains');
        expect(screen.findByTestId('team-oidc-groups-any')?.props.accessibilityLabel).toBe('identityAdministration.groupsAny');
        expect(screen.findByTestId('team-oidc-groups-all')?.props.accessibilityLabel).toBe('identityAdministration.groupsAll');
    });

    it('creates the Team-owned OIDC provider and attaches that exact provider to the Team', async () => {
        const screen = await renderSetup();
        await fillOidc(screen);
        await screen.pressByTestIdAsync('team-oidc-create');
        expect(harness.requestsFor(providerCreatePath)).toHaveLength(1);
        expect(harness.requestsFor(providerCreatePath)[0]?.input).toMatchObject({ owner: { kind: 'team', teamId: 'team-1' } });
        expect(TeamIdentityConnectionCreateInputV1Schema.parse(harness.requestsFor(connectionCreatePath)[0]?.input))
            .toMatchObject({ teamId: 'team-1', providerInstanceId: 'provider-1' });
        expect(routerReplaceMock).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/authentication/connection-1`);
    });

    it('finishes Team attachment after its native Ask confirmation without an Inbox approval', async () => {
        await harness.requireUiApproval(serverId, 'teams.identity.connections.create');
        const screen = await renderSetup();
        await fillOidc(screen);
        await screen.pressByTestIdAsync('team-oidc-create');
        expect(Modal.confirm).toHaveBeenCalledOnce();
        expect(routerReplaceMock).toHaveBeenCalledTimes(1);
        expect(routerReplaceMock).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/authentication/connection-1`);
        expect(harness.artifacts(serverId).list()).toHaveLength(0);
    });

    it('makes Team attachment retryable when the native Ask confirmation is declined', async () => {
        await harness.requireUiApproval(serverId, 'teams.identity.connections.create');
        vi.mocked(Modal.confirm).mockResolvedValueOnce(false);
        const screen = await renderSetup();
        await fillOidc(screen);
        await screen.pressByTestIdAsync('team-oidc-create');
        expect(harness.requestsFor(connectionCreatePath)).toHaveLength(0);
        expect(Boolean(screen.findByTestId('team-oidc-create')?.props.disabled)).toBe(false);
        expect(routerReplaceMock).not.toHaveBeenCalled();
        await screen.pressByTestIdAsync('team-oidc-create');
        expect(harness.requestsFor(providerCreatePath)).toHaveLength(1);
        expect(harness.requestsFor(connectionCreatePath)).toHaveLength(1);
        expect(routerReplaceMock).toHaveBeenCalledOnce();
    });

    it('starts Team attachment once when the held provider response settles', async () => {
        const held = createDeferred<void>();
        harness.answer(serverId, providerCreatePath, { body: provider(), respondAfter: held.promise });
        const screen = await renderSetup();
        await fillOidc(screen);
        const saving = screen.pressByTestIdAsync('team-oidc-create');
        await waitForHomeGovernance(() => expect(harness.requestsFor(providerCreatePath)).toHaveLength(1));
        expect(harness.requestsFor(connectionCreatePath)).toHaveLength(0);
        expect(screen.findByTestId('team-oidc-create')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('team-oidc-create');
        expect(harness.requestsFor(providerCreatePath)).toHaveLength(1);
        await act(async () => held.resolve());
        await saving;
        expect(harness.requestsFor(connectionCreatePath)).toHaveLength(1);
        expect(routerReplaceMock).toHaveBeenCalledOnce();
    });

    it('settles provider then connection Ask phases without replaying either phase', async () => {
        await harness.requireUiApproval(serverId, 'identity.providers.create');
        await harness.requireUiApproval(serverId, 'teams.identity.connections.create');
        const held = createDeferred<void>();
        harness.answer(serverId, connectionCreatePath, { body: { connection: connection() }, respondAfter: held.promise });
        const screen = await renderSetup();
        await fillOidc(screen);
        const saving = screen.pressByTestIdAsync('team-oidc-create');
        await waitForHomeGovernance(() => expect(harness.requestsFor(connectionCreatePath)).toHaveLength(1));
        expect(Modal.confirm).toHaveBeenCalledTimes(2);
        expect(routerReplaceMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('team-oidc-create')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('team-oidc-create');
        expect(harness.requestsFor(providerCreatePath)).toHaveLength(1);
        expect(harness.requestsFor(connectionCreatePath)).toHaveLength(1);
        await act(async () => held.resolve());
        await saving;
        expect(routerReplaceMock).toHaveBeenCalledOnce();
    });

    it('reuses a created provider when attaching the connection is retried', async () => {
        harness.answer(serverId, connectionCreatePath, { status: 503, body: { error: 'home_unreachable' } });
        const screen = await renderSetup();
        await fillOidc(screen);
        await screen.pressByTestIdAsync('team-oidc-create');
        harness.answer(serverId, connectionCreatePath, { body: { connection: connection() } });
        await screen.pressByTestIdAsync('team-oidc-create');
        expect(harness.requestsFor(providerCreatePath)).toHaveLength(1);
        expect(harness.requestsFor(connectionCreatePath)).toHaveLength(2);
        expect(routerReplaceMock).toHaveBeenCalledOnce();
    });

    it('keeps a created provider retryable after the connection response is lost', async () => {
        harness.answer(serverId, connectionCreatePath, { dispatchThenFail: true });
        const screen = await renderSetup();
        await fillOidc(screen);
        await screen.pressByTestIdAsync('team-oidc-create');
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-oidc-create')?.props.disabled).toBe(false));
        harness.answer(serverId, connectionCreatePath, { body: { connection: connection() } });
        await screen.pressByTestIdAsync('team-oidc-create');
        expect(harness.requestsFor(providerCreatePath)).toHaveLength(1);
        expect(harness.requestsFor(connectionCreatePath)).toHaveLength(2);
        expect(routerReplaceMock).toHaveBeenCalledWith(`/settings/teams/${serverId}/team-1/authentication/connection-1`);
    });

    it('uses the shared editor test action for a saved provider awaiting Team attachment', async () => {
        harness.answer(serverId, connectionCreatePath, { status: 503, body: { error: 'home_unreachable' } });
        const screen = await renderSetup();
        await fillOidc(screen);
        await screen.pressByTestIdAsync('team-oidc-create');
        await screen.pressByTestIdAsync('team-oidc-test');
        expect(harness.requestsFor(providerValidatePath)).toHaveLength(1);
        expect(harness.requestsFor(providerValidatePath)[0]?.input).toMatchObject({
            owner: { kind: 'team', teamId: 'team-1' }, id: 'provider-1', expectedRevision: 4, expectedSecurityRevision: 1,
        });
    });

    it('applies provider edits before retrying a failed Team attachment', async () => {
        harness.answer(serverId, connectionCreatePath, { status: 503, body: { error: 'home_unreachable' } });
        const screen = await renderSetup();
        await fillOidc(screen);
        await screen.pressByTestIdAsync('team-oidc-create');
        expect(harness.requestsFor(connectionCreatePath)).toHaveLength(1);
        await waitForHomeGovernance(() => expect(screen.findByTestId('team-oidc-create')?.props.disabled).toBe(false));
        await act(async () => {
            screen.changeTextByTestId('team-oidc-issuer', 'https://new-id.example');
            screen.changeTextByTestId('team-oidc-client-id', 'client-2');
            screen.changeTextByTestId('team-oidc-client-secret', 'secret-2');
            screen.pressByTestId('team-oidc-advanced-toggle');
        });
        await act(async () => screen.changeTextByTestId('team-oidc-scopes', 'openid email'));
        const changed = { ...provider(5), config: { ...provider(5).config, issuer: 'https://new-id.example', clientId: 'client-2', scopes: 'openid email' } };
        harness.answer(serverId, providerUpdatePath, { body: ManagedIdentityProviderV1Schema.parse(changed) });
        harness.answer(serverId, providerSecretPath, { body: ManagedIdentityProviderV1Schema.parse({ ...changed, revision: 6 }) });
        harness.answer(serverId, connectionCreatePath, { body: { connection: connection() } });
        await screen.pressByTestIdAsync('team-oidc-create');
        expect(harness.requestsFor(providerUpdatePath)[0]?.input).toMatchObject({ owner: { kind: 'team', teamId: 'team-1' }, id: 'provider-1', expectedRevision: 4,
            config: { issuer: 'https://new-id.example', clientId: 'client-2', scopes: 'openid email' } });
        expect(harness.requestsFor(providerSecretPath)[0]?.input).toMatchObject({ id: 'provider-1', expectedRevision: 5, clientSecret: 'secret-2' });
        expect(harness.requestsFor(connectionCreatePath)).toHaveLength(2);
        expect(harness.requestsFor(connectionCreatePath)[1]?.input).toMatchObject({ providerInstanceId: 'provider-1' });
    });
});
