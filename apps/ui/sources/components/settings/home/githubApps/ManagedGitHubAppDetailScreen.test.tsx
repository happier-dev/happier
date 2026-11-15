import * as React from 'react';
import { homeAdministrationGitHubAppPath, homeAdministrationGitHubAppEditPath, homeAdministrationPoliciesPath } from '../governance/homeAdministrationRoutes';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedGitHubAppsListOutputV1 } from '@happier-dev/protocol/identity/githubApps';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';

const runtimeFetchMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn(async () => false));
const alertMock = vi.hoisted(() => vi.fn(async () => {}));
const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => true));
const routerParams = vi.hoisted(() => ({ value: {} as Record<string, string> }));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ params: () => routerParams.value }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock();
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: confirmMock, alertAsync: alertMock } }).module;
});
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openExternalUrlMock }));
vi.mock('@/sync/runtime/connectivity/serverReachabilityRuntimeFetch', () => ({
    runtimeFetchWithServerReachability: runtimeFetchMock,
}));
vi.mock('@/sync/http/client', () => ({
    serverFetch: vi.fn(),
    createServerFetchAtEndpoint: () => async (path: string) => {
        if (path.startsWith('/v1/account/encryption')) {
            return new Response(JSON.stringify({ mode: 'plain', updatedAt: 0 }), { status: 200 });
        }
        if (path.startsWith('/v2/account/settings')) {
            return new Response(JSON.stringify({ content: null, version: 0 }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
    },
}));
vi.mock('@/auth/storage/tokenStorage', async (importOriginal) => {
    const { createTokenStorageModuleMock } = await import('@/dev/testkit/mocks/tokenStorage');
    return createTokenStorageModuleMock({
        importOriginal,
        tokenStorage: { getCredentialsForServerUrl: async () => ({ token: 'e30.eyJzdWIiOiJhY2NvdW50LTEifQ.signature' }) },
    });
});

import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { upsertServerProfile } from '@/sync/domains/server/serverProfiles';
import { resetScopedHomeActionExecutorsForTests } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { ManagedGitHubAppDetailContent } from './ManagedGitHubAppDetailScreen';
import type { ManagedGitHubAppSurface } from './managedGitHubAppSurface';
import { consumePendingGitHubAppVerification } from './githubAppOAuthReturn';
import { HOME_GITHUB_APP_SETTINGS, TEAM_GITHUB_APP_SETTINGS } from '@/components/settings/identity/identitySettings';

let projection: ManagedGitHubAppsListOutputV1;
let surface: ManagedGitHubAppSurface;
let removeResponse: { body: unknown; status: number };

beforeEach(async () => {
    standardCleanup();
    resetScopedHomeActionExecutorsForTests();
    runtimeFetchMock.mockReset();
    confirmMock.mockReset().mockResolvedValue(false);
    alertMock.mockReset();
    openExternalUrlMock.mockReset().mockResolvedValue(true);
    routerParams.value = {};
    consumePendingGitHubAppVerification('registration-1');
    const profile = await upsertServerProfile({ serverUrl: 'https://github-controls.example', name: 'GitHub Home' });
    surface = {
        scope: createServerAccountScope(profile.id, 'account-1')!, owner: { kind: 'home' }, mutationsAvailable: true,
        routes: {
            detail: (id) => homeAdministrationGitHubAppPath(profile.id, id),
            edit: (id) => homeAdministrationGitHubAppEditPath(profile.id, id),
            signIn: homeAdministrationPoliciesPath(profile.id),
        },
    };
    projection = {
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
            id: 'installation-1', registrationId: 'registration-1', githubInstallationId: '99',
            githubOrganizationId: '77', githubOrganizationLogin: 'happier-dev', repositorySelection: 'all',
            revision: 1, state: 'verified', verifiedPermissions: {}, verifiedEvents: ['membership'],
            suspendedAt: null, lastVerifiedAt: '2026-09-01T10:00:00.000Z', teamConsumers: [],
            requirements: {
                permissions: { members: 'read' }, events: ['membership'],
                missingPermissions: [{ permission: 'members', required: 'read' }], missingEvents: [],
            },
        }],
    };
    removeResponse = { body: { removed: true }, status: 200 };
    runtimeFetchMock.mockImplementation(async (request: { url: string }) => {
        if (request.url.endsWith('/list')) return new Response(JSON.stringify(projection), { status: 200 });
        if (request.url.endsWith('/remove')) return new Response(JSON.stringify(removeResponse.body), { status: removeResponse.status });
        if (request.url.endsWith('/verify-installation')) {
            return new Response(JSON.stringify({ authorizeUrl: 'https://github.com/login/oauth/authorize', attemptId: 'attempt-1' }), { status: 200 });
        }
        throw new Error(`Unexpected GitHub App request: ${request.url}`);
    });
});

function requestsFor(operation: string) {
    return runtimeFetchMock.mock.calls.filter(([request]) => request.url.endsWith(`/${operation}`));
}

describe('managed GitHub App installation operations', () => {
    it('says a failed read as a read, and a missing App as missing, never as a change that did not go through', async () => {
        runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }));
        const failed = await renderScreen(<ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />);
        await vi.waitFor(() => expect(failed.getTextContent()).toContain('identityAdministration.githubAppsReadFailed'));
        expect(failed.getTextContent()).not.toContain('identityAdministration.error');
        await failed.unmount();

        projection = { ...projection, registrations: [], installations: [] };
        runtimeFetchMock.mockImplementation(async () => new Response(JSON.stringify(projection), { status: 200 }));
        const missing = await renderScreen(<ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />);
        await vi.waitFor(() => expect(missing.getTextContent()).toContain('identityAdministration.errorMissing'));
    });

    it('keeps organization information non-interactive and requires the named removal control and confirmation', async () => {
        const screen = await renderScreen(<ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />);
        const organization = screen.findHostByTestId('github-app-installation:installation-1');
        expect(organization).not.toBeNull();
        expect(organization?.props.onPress).toBeUndefined();
        const remove = screen.findByTestId('github-app-installation-remove:installation-1');
        expect(remove?.props.accessibilityLabel).toContain('happier-dev');
        expect(screen.getTextContent()).toContain('identityAdministration.githubAllRepositories');
        expect(screen.getTextContent()).toContain('identityAdministration.githubVerified');
        await screen.pressByTestIdAsync('github-app-installation-remove:installation-1');
        expect(confirmMock).toHaveBeenCalledWith(expect.stringContaining('happier-dev'), expect.any(String), expect.objectContaining({ destructive: true }));
        expect(requestsFor('remove')).toHaveLength(0);
        expect(screen.findHostByTestId('github-app-installation:installation-1')).not.toBeNull();
    });

    it('preserves the exact Team owner and server in-use refusal through the inline remove control', async () => {
        surface = { ...surface, owner: { kind: 'team', teamId: 'team-1' } };
        projection.registrations[0].owner = surface.owner;
        confirmMock.mockResolvedValue(true);
        removeResponse = { body: { error: 'github_installation_in_use', blockers: { identityProviderInstances: 1, directorySources: 0 } }, status: 409 };
        const screen = await renderScreen(<ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />);
        await screen.pressByTestIdAsync('github-app-installation-remove:installation-1');
        expect(JSON.parse(requestsFor('remove')[0]?.[0].init.body ?? 'null')).toEqual({
            owner: { kind: 'team', teamId: 'team-1' }, installationId: 'installation-1', expectedRevision: 1,
        });
        expect(alertMock).toHaveBeenCalledWith('identityAdministration.githubRemoveInstallation', 'identityAdministration.githubInstallationInUse');
        expect(screen.findHostByTestId('github-app-installation:installation-1')).not.toBeNull();
    });

    it('starts installation verification from a named button and opens the returned GitHub URL', async () => {
        const screen = await renderScreen(<ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />);
        await act(async () => {
            screen.changeTextByTestId('github-installation-id', '99');
            screen.changeTextByTestId('github-organization-id', '77');
        });
        const verify = screen.findByTestId('github-installation-verify');
        expect(verify?.props.accessibilityRole).toBe('button');
        expect(verify?.props.accessibilityLabel).toBe('identityAdministration.githubVerifyInstallation');
        await screen.pressByTestIdAsync('github-installation-verify');
        expect(openExternalUrlMock).toHaveBeenCalledWith('https://github.com/login/oauth/authorize');
        expect(consumePendingGitHubAppVerification('registration-1')).toEqual({ registrationId: 'registration-1', returnTo: surface.routes.detail('registration-1') });
    });

    it('keeps installation information visible while removal is pending and refreshes after success', async () => {
        confirmMock.mockResolvedValue(true);
        const screen = await renderScreen(<ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />);
        let completeRemoval!: (response: Response) => void;
        runtimeFetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { completeRemoval = resolve; }));

        await act(async () => { screen.pressByTestId('github-app-installation-remove:installation-1'); });

        expect(screen.findByTestId('github-app-installation-remove:installation-1')?.props.disabled).toBe(true);
        expect(screen.findByTestId('github-installation-verify')?.props.disabled).toBe(true);
        expect(screen.findHostByTestId('github-app-installation:installation-1')?.props.onPress).toBeUndefined();
        expect(screen.getTextContent()).toContain('happier-dev');
        expect(JSON.parse(requestsFor('remove')[0]?.[0].init.body ?? 'null')).toEqual({
            owner: { kind: 'home' }, installationId: 'installation-1', expectedRevision: 1,
        });

        projection.installations = [];
        await act(async () => { completeRemoval(new Response(JSON.stringify({ removed: true }), { status: 200 })); });

        expect(screen.findHostByTestId('github-app-installation:installation-1')).toBeNull();
        expect(screen.getTextContent()).toContain('identityAdministration.githubInstallationsEmpty');
        expect(screen.findByTestId('github-installation-verify')?.props.disabled).toBe(false);
    });
});

describe('managed GitHub App current and setup access', () => {
    it('keeps setup requirements visible when no enabled consumer requires access', async () => {
        const setupRequirements = projection.installations[0].requirements;
        projection.installations[0] = {
            ...projection.installations[0],
            requirements: { permissions: {}, events: [], missingPermissions: [], missingEvents: [] },
            prospectiveRequirements: setupRequirements,
        };
        const screen = await renderScreen(<ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />);

        expect(screen.getTextContent()).toContain('identityAdministration.githubCurrentAccessEmpty');
        expect(screen.getTextContent()).toContain('identityAdministration.githubSetupAccess');
        expect(screen.findByTestId('github-app-requirement:installation-1:permission:members')).toBeNull();
        expect(screen.findByTestId('github-app-setup-requirement:installation-1:permission:members')).not.toBeNull();
        expect(screen.getTextContent()).toContain('identityAdministration.githubRequirementMissing');
    });

    it('preserves current requirement display when the Home omits the optional setup projection', async () => {
        const screen = await renderScreen(<ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />);

        expect(screen.findByTestId('github-app-requirement:installation-1:permission:members')).not.toBeNull();
        expect(screen.findByTestId('github-app-requirement:installation-1:event:membership')).not.toBeNull();
        expect(screen.getTextContent()).toContain('identityAdministration.githubRequiredAccess');
        expect(screen.getTextContent()).toContain('identityAdministration.githubRequirementMissing');
        expect(screen.getTextContent()).toContain('identityAdministration.githubRequirementGranted');
        expect(screen.getTextContent()).not.toContain('identityAdministration.githubSetupAccess');
    });

    it('does not invent access requirements when the Home publishes no projection', async () => {
        delete projection.installations[0].requirements;
        const screen = await renderScreen(<ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />);

        expect(screen.findByTestId('github-app-requirement:installation-1:permission:members')).toBeNull();
        expect(screen.getTextContent()).not.toContain('identityAdministration.githubRequiredAccess');
        expect(screen.getTextContent()).not.toContain('identityAdministration.githubCurrentAccess');
        expect(screen.getTextContent()).not.toContain('identityAdministration.githubSetupAccess');
    });
});

describe('managed GitHub App settings search', () => {
    it.each(['home', 'team'] as const)('reveals the verification field for its exact %s owner', async (kind) => {
        const settings = kind === 'home' ? HOME_GITHUB_APP_SETTINGS : TEAM_GITHUB_APP_SETTINGS;
        surface = { ...surface, owner: kind === 'home' ? { kind } : { kind, teamId: 'team-1' } };
        projection.registrations[0].owner = surface.owner;
        routerParams.value = { setting: settings.settings.githubInstallationId.anchor };

        const screen = await renderScreen(<ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />);

        expect(screen.findHostByTestId(`setting-reveal.${settings.settings.githubInstallationId.anchor}`)).not.toBeNull();
        expect(screen.findByTestId('github-installation-id')).not.toBeNull();
    });
});
