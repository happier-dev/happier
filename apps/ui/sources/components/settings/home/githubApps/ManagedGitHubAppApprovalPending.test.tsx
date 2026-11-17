import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagedGitHubAppsListOutputV1Schema, MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/identity/githubApps';
import { createDeferred } from '@/dev/testkit';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { renderScreen, findTestInstanceByTypeContainingText } from '@/dev/testkit/render/renderScreen';
import { homeAdministrationGitHubAppPath, homeAdministrationGitHubAppEditPath, homeAdministrationPoliciesPath, homeAdministrationSignInProvidersPath } from '../governance/homeAdministrationRoutes';
import { teamDirectoryPath } from '../../teams/teamsRoutes';

const replaceMock = vi.hoisted(() => vi.fn());
const pushMock = vi.hoisted(() => vi.fn());
const openExternalUrlMock = vi.hoisted(() => vi.fn());
const approvalPendingMock = vi.hoisted(() => vi.fn());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { replace: replaceMock, push: pushMock } }).module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock({ translate: key => key }));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openExternalUrlMock }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ManagedGitHubAppDetailContent } = await import('./ManagedGitHubAppDetailScreen');
const { ManagedGitHubAppEditorContent } = await import('./ManagedGitHubAppEditorScreen');
const { consumePendingGitHubAppManifestSetup, consumePendingGitHubAppVerification } = await import('./githubAppOAuthReturn');
const { Modal } = await import('@/modal');
const listPath = '/v1/identity/github-apps/list';
const createPath = '/v1/identity/github-apps/create';
const manifestPath = '/v1/identity/github-apps/manifest-setup/start';
const verifyPath = '/v1/identity/github-apps/verify-installation';
const removePath = '/v1/identity/github-apps/remove';
const apps = ManagedGitHubAppsListOutputV1Schema.parse({
    registrations: [{
        id: 'registration-1', owner: { kind: 'home' }, githubHost: 'https://github.com',
        githubAppId: '12', githubClientId: 'Iv1.client', githubAppSlug: 'happier',
        githubOwnerId: '22', githubOwnerLogin: 'happier-dev', revision: 2, securityRevision: 1,
        state: 'verified',
        secretHealth: { clientSecretConfigured: true, privateKeyConfigured: true, webhookSecretConfigured: true },
        lastVerifiedAt: '2026-09-01T10:00:00.000Z', createdAt: '2026-08-01T10:00:00.000Z',
        updatedAt: '2026-09-01T10:00:00.000Z',
    }],
    installations: [{
        id: 'installation-1', registrationId: 'registration-1', githubInstallationId: '1',
        githubOrganizationId: '2', githubOrganizationLogin: 'happier-dev', repositorySelection: 'all',
        revision: 1, state: 'verified', verifiedPermissions: {}, verifiedEvents: [],
        suspendedAt: null, lastVerifiedAt: null,
        teamConsumers: [
            {
                team: { id: 'team-1', name: 'Acme' },
                binding: {
                    kind: 'identity_connection', id: 'connection-1',
                    providerInstanceId: 'provider-1', enabled: true,
                },
            },
            {
                team: { id: 'team-1', name: 'Acme' },
                binding: { kind: 'directory_source', id: 'source-1', state: 'active' },
            },
        ],
    }],
});

const surface = {
    scope: { serverId: '', accountId: 'account-1' },
    owner: { kind: 'home' as const },
    mutationsAvailable: true,
    routes: {
        detail: (id: string) => homeAdministrationGitHubAppPath(surface.scope.serverId, id),
        edit: (id: string) => homeAdministrationGitHubAppEditPath(surface.scope.serverId, id),
        signIn: '', directory: '',
    },
    githubEnterpriseOriginPolicyPath: '',
    onApprovalPending: approvalPendingMock,
};

async function renderReady(content: React.ReactElement) {
    const screen = await renderScreen(content);
    await waitForHomeGovernance(() => expect(harness.requestsFor(listPath).length).toBeGreaterThan(0));
    // Lists settle through the real Action client before a registration is available.
    await waitForHomeGovernance(() => {
        expect(screen.findByTestId('github-app-loading')).toBeNull();
        expect(screen.findByTestId('github-app-editor-loading')).toBeNull();
    });
    return screen;
}

async function changeText(screen: Awaited<ReturnType<typeof renderScreen>>, values: Readonly<Record<string, string>>) {
    await act(async () => {
        for (const [testID, value] of Object.entries(values)) screen.changeTextByTestId(testID, value);
    });
}

beforeEach(async () => {
    standardCleanup();
    await harness.reset();
    surface.scope.serverId = await harness.addHome({ name: 'GitHub Home', serverUrl: 'https://github-home.test', accountId: 'account-1' });
    surface.routes.signIn = homeAdministrationPoliciesPath(surface.scope.serverId);
    surface.routes.directory = teamDirectoryPath({ serverId: surface.scope.serverId, teamId: 'team-1' });
    surface.githubEnterpriseOriginPolicyPath = homeAdministrationSignInProvidersPath(surface.scope.serverId);
    harness.answer(surface.scope.serverId, listPath, { body: apps });
    replaceMock.mockReset(); pushMock.mockReset(); openExternalUrlMock.mockReset(); approvalPendingMock.mockReset();
    vi.mocked(Modal.confirm).mockReset().mockResolvedValue(true);
    consumePendingGitHubAppManifestSetup(); consumePendingGitHubAppVerification('registration-1');
});

describe('managed GitHub App present-user mutations', () => {
    it('routes identity and directory setup to their canonical owners without claiming facet state', async () => {
        const screen = await renderReady(
            <ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />,
        );

        expect(findTestInstanceByTypeContainingText(screen.findByTestId('github-app-sign-in')!, 'Text', 'identityAdministration.githubFacetConfigure')).toBeDefined();
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('github-app-directory')!, 'Text', 'identityAdministration.githubFacetConfigure')).toBeDefined();
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('github-app-team-consumer:identity_connection:connection-1')!, 'Text', 'Acme')).toBeDefined();
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('github-app-team-consumer:directory_source:source-1')!, 'Text', 'identityAdministration.githubFacetDirectory')).toBeDefined();
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('github-app-installation:installation-1')!, 'Text', 'identityAdministration.githubVerified')).toBeDefined();

        await screen.pressByTestIdAsync('github-app-sign-in');
        await screen.pressByTestIdAsync('github-app-directory');

        expect(pushMock).toHaveBeenNthCalledWith(1, surface.routes.signIn);
        expect(pushMock).toHaveBeenNthCalledWith(2, surface.routes.directory);
    });

    it('keeps installation verification fields read-only when mutations are unavailable', async () => {
        const screen = await renderReady(
            <ManagedGitHubAppDetailContent
                surface={{ ...surface, mutationsAvailable: false }}
                registrationId="registration-1"
            />,
        );

        expect(screen.findByTestId('github-installation-id')?.props.editable).toBe(false);
        expect(screen.findByTestId('github-organization-id')?.props.editable).toBe(false);
        expect(screen.findByTestId('github-installation-verify')?.props.disabled).toBe(true);
        expect(screen.findByTestId('github-app-edit')?.props.disabled).toBe(true);
    });

    it('preserves a Home-owned create draft and opens the exact Home policy after an unapproved enterprise origin', async () => {
        harness.answer(surface.scope.serverId, createPath, { status: 409, body: { error: 'github_enterprise_origin_not_approved' } });
        const screen = await renderReady(
            <ManagedGitHubAppEditorContent
                surface={surface}
                manifestReturn={{ kind: 'home', serverId: surface.scope.serverId }}
            />,
        );
        await changeText(screen, {
            'github-app-host': 'https://github.corp.example',
            'github-app-id': '12',
            'github-app-client-id': 'Iv1.client',
            'github-app-private-key': 'private-key',
        });

        await screen.pressByTestIdAsync('github-app-save');

        expect(replaceMock).not.toHaveBeenCalled();
        expect(Boolean(screen.findByTestId('github-app-save')!.props.accessibilityState?.busy)).toBe(false);
        expect(screen.findByTestId('github-app-host')?.props.value).toBe('https://github.corp.example');
        expect(screen.findByTestId('github-app-private-key')?.props.value).toBe('private-key');
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('github-enterprise-origin-policy')!, 'Text', 'homeGovernance.githubEnterpriseOrigins')).toBeDefined();
        expect(screen.findAll((node) => node.props.description
            === 'identityAdministration.githubEnterpriseOriginNotApproved')).not.toHaveLength(0);

        await screen.pressByTestIdAsync('github-enterprise-origin-policy');
        expect(pushMock).toHaveBeenCalledWith(homeAdministrationSignInProvidersPath(surface.scope.serverId));
    });

    it('offers the same exact-Home recovery from installation verification without reporting success', async () => {
        harness.answer(surface.scope.serverId, verifyPath, { status: 409, body: { error: 'github_enterprise_origin_not_approved' } });
        const screen = await renderReady(
            <ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />,
        );
        await changeText(screen, {
            'github-installation-id': '3',
            'github-organization-id': '4',
        });

        await screen.pressByTestIdAsync('github-installation-verify');

        expect(openExternalUrlMock).not.toHaveBeenCalled();
        expect(Boolean(screen.findByTestId('github-installation-verify')!.props.disabled)).toBe(false);
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('github-enterprise-origin-policy')!, 'Text', 'homeGovernance.githubEnterpriseOrigins')).toBeDefined();
        await screen.pressByTestIdAsync('github-enterprise-origin-policy');
        expect(pushMock).toHaveBeenCalledWith(homeAdministrationSignInProvidersPath(surface.scope.serverId));
    });

    it('does not invent Home policy navigation for a Team-owned GitHub App', async () => {
        harness.answer(surface.scope.serverId, createPath, { status: 409, body: { error: 'github_enterprise_origin_not_approved' } });
        const { githubEnterpriseOriginPolicyPath: _homePolicyPath, ...sharedSurface } = surface;
        const teamSurface = {
            ...sharedSurface,
            owner: { kind: 'team' as const, teamId: 'team-1' },
        };
        const screen = await renderReady(
            <ManagedGitHubAppEditorContent
                surface={teamSurface}
                manifestReturn={{ kind: 'team', serverId: surface.scope.serverId, teamId: 'team-1' }}
            />,
        );
        await changeText(screen, {
            'github-app-host': 'https://github.corp.example',
            'github-app-id': '12',
            'github-app-client-id': 'Iv1.client',
            'github-app-private-key': 'private-key',
        });

        await screen.pressByTestIdAsync('github-app-save');

        expect(screen.findByTestId('github-enterprise-origin-policy')).toBeNull();
        expect(pushMock).not.toHaveBeenCalled();
    });

    it('explains an unenumerated Home failure instead of printing its code', async () => {
        harness.answer(surface.scope.serverId, verifyPath, { status: 422, body: { error: 'github_installation_unverified' } });
        const screen = await renderReady(
            <ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />,
        );

        await changeText(screen, {
            'github-installation-id': '1',
            'github-organization-id': '2',
        });
        await screen.pressByTestIdAsync('github-installation-verify');

        // The classifier's answer, not the wire enum. A raw code here is the
        // regression: it is unlocalized and means nothing to an administrator.
        const footers = screen.findAll((node) => typeof node.props.description === 'string'
            && node.props.description.length > 0);
        expect(footers.map((node) => node.props.description))
            .not.toContain('github_installation_unverified');
        expect(footers.map((node) => node.props.description))
            .toContain('identityAdministration.error');
    });

    it.each(['save', 'manifest'] as const)('starts one %s request when pressed twice before React renders busy state', async kind => {
        const held = createDeferred<void>();
        const path = kind === 'save' ? createPath : manifestPath;
        harness.answer(surface.scope.serverId, path, { body: kind === 'save'
            ? MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1['identity.githubApps.create'].parse({ registration: apps.registrations[0] })
            : MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1['identity.githubApps.manifestSetup.start'].parse({ authorizeUrl: 'https://github.com/settings/apps/new' }), respondAfter: held.promise });
        const screen = await renderReady(<ManagedGitHubAppEditorContent surface={surface} manifestReturn={{ kind: 'home', serverId: surface.scope.serverId }} />);
        await changeText(screen, kind === 'save'
            ? { 'github-app-id': '12', 'github-app-client-id': 'Iv1.client', 'github-app-private-key': 'private-key' }
            : { 'github-manifest-app-name': 'Happier' });
        act(() => {
            screen.pressByTestId(kind === 'save' ? 'github-app-save' : 'github-manifest-start');
            screen.pressByTestId(kind === 'save' ? 'github-app-save' : 'github-manifest-start');
        });
        await waitForHomeGovernance(() => expect(harness.requestsFor(path)).toHaveLength(1));
        await act(async () => held.resolve());
    });

    it.each(['create', 'update', 'manifest', 'verify', 'remove'] as const)('waits for native Ask before a %s effect and continues through the real success path', async kind => {
        const action = kind === 'manifest' ? 'identity.githubApps.manifestSetup.start' : kind === 'verify'
            ? 'identity.githubApps.verifyInstallation' : kind === 'update' ? 'identity.githubApps.update'
            : kind === 'remove' ? 'identity.githubApps.remove' : 'identity.githubApps.create';
        const path = kind === 'manifest' ? manifestPath : kind === 'verify' ? verifyPath
            : kind === 'update' ? '/v1/identity/github-apps/update' : kind === 'remove' ? removePath : createPath;
        await harness.requireUiApproval(surface.scope.serverId, action);
        let confirm: ((value: boolean) => void) | undefined;
        // Removing an installation first asks its destructive confirmation, then native Ask.
        if (kind === 'remove') vi.mocked(Modal.confirm).mockResolvedValueOnce(true);
        vi.mocked(Modal.confirm).mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
        const value = kind === 'manifest' ? { authorizeUrl: 'https://github.com/settings/apps/new' }
            : kind === 'verify' ? { authorizeUrl: 'https://github.com/login/oauth/authorize', attemptId: 'attempt-1' }
            : kind === 'remove' ? { removed: true } : { registration: apps.registrations[0] };
        harness.answer(surface.scope.serverId, path, { body: MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1[action].parse(value) });
        const detail = kind === 'verify' || kind === 'remove';
        const screen = await renderReady(detail
            ? <ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />
            : <ManagedGitHubAppEditorContent surface={surface} manifestReturn={{ kind: 'home', serverId: surface.scope.serverId }} registrationId={kind === 'update' ? 'registration-1' : undefined} />);
        await changeText(screen, kind === 'manifest' ? { 'github-manifest-app-name': 'Happier' }
            : kind === 'verify' ? { 'github-installation-id': '3', 'github-organization-id': '4' }
            : kind === 'remove' ? {} : kind === 'update' ? { 'github-app-client-id': 'Iv1.changed' }
            : { 'github-app-id': '12', 'github-app-client-id': 'Iv1.client', 'github-app-private-key': 'private-key' });
        const control = kind === 'manifest' ? 'github-manifest-start' : kind === 'verify' ? 'github-installation-verify'
            : kind === 'remove' ? 'github-app-installation-remove:installation-1' : 'github-app-save';
        const pressing = screen.pressByTestIdAsync(control);
        await waitForHomeGovernance(() => expect(confirm).toBeTypeOf('function'));
        expect(harness.requestsFor(path)).toHaveLength(0);
        expect(replaceMock).not.toHaveBeenCalled();
        expect(openExternalUrlMock).not.toHaveBeenCalled();
        expect(harness.requestsFor(listPath)).toHaveLength(1);
        openExternalUrlMock.mockResolvedValueOnce(true);
        await act(async () => confirm!(true));
        await pressing;
        expect(harness.requestsFor(path)).toHaveLength(1);
        expect(approvalPendingMock).not.toHaveBeenCalled();
        expect(harness.artifacts(surface.scope.serverId).list()).toEqual([]);
        if (kind === 'manifest') {
            expect(openExternalUrlMock).toHaveBeenCalledWith('https://github.com/settings/apps/new');
            expect(consumePendingGitHubAppManifestSetup()).toEqual({ kind: 'home', serverId: surface.scope.serverId });
        } else if (kind === 'verify') {
            expect(openExternalUrlMock).toHaveBeenCalledWith('https://github.com/login/oauth/authorize');
            expect(consumePendingGitHubAppVerification('registration-1')).toEqual({ registrationId: 'registration-1', returnTo: surface.routes.detail('registration-1') });
        } else if (kind === 'remove') {
            await waitForHomeGovernance(() => expect(harness.requestsFor(listPath)).toHaveLength(2));
        } else expect(replaceMock).toHaveBeenCalledWith(surface.routes.detail('registration-1'));
    });

    it('keeps a declined manifest draft retryable without opening GitHub', async () => {
        await harness.requireUiApproval(surface.scope.serverId, 'identity.githubApps.manifestSetup.start');
        vi.mocked(Modal.confirm).mockResolvedValueOnce(false);
        const screen = await renderReady(<ManagedGitHubAppEditorContent surface={surface} manifestReturn={{ kind: 'home', serverId: surface.scope.serverId }} />);
        await changeText(screen, { 'github-manifest-app-name': 'Happier' });
        await screen.pressByTestIdAsync('github-manifest-start');
        expect(harness.requestsFor(manifestPath)).toHaveLength(0);
        expect(openExternalUrlMock).not.toHaveBeenCalled();
        expect(Boolean(screen.findByTestId('github-manifest-start')!.props.disabled)).toBe(false);
        expect(screen.findByTestId('github-manifest-app-name')?.props.value).toBe('Happier');
    });
});
