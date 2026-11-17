import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    ManagedGitHubAppErrorV1Schema,
    ManagedGitHubAppsListOutputV1Schema,
    ManagedGitHubAppVerifyInstallationOutputV1Schema,
} from '@happier-dev/protocol/identity/githubApps';

import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
import {
    homeAdministrationGitHubAppEditPath,
    homeAdministrationGitHubAppPath,
    homeAdministrationPoliciesPath,
} from '../governance/homeAdministrationRoutes';

const openExternalUrlMock = vi.hoisted(() => vi.fn(async () => true));

vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: openExternalUrlMock }));
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
import { createServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
const { resetScopedHomeActionExecutorsForTests } = await import('@/sync/ops/actions/scopedHomeActionExecutor');
const { ManagedGitHubAppDetailContent } = await import('./ManagedGitHubAppDetailScreen');
import type { ManagedGitHubAppSurface } from './managedGitHubAppSurface';
import { consumePendingGitHubAppVerification } from './githubAppOAuthReturn';
import { managedGitHubAppFailureMessage } from './ManagedGitHubAppFailure';

let surface: ManagedGitHubAppSurface;

beforeEach(async () => {
    standardCleanup();
    resetScopedHomeActionExecutorsForTests();
    await harness.reset();
    openExternalUrlMock.mockReset().mockResolvedValue(true);
    consumePendingGitHubAppVerification('registration-1');
    const serverId = await harness.addHome({ serverUrl: 'https://github-verify.example', name: 'GitHub Home', accountId: 'account-1' });
    surface = {
        scope: createServerAccountScope(serverId, 'account-1')!, owner: { kind: 'home' }, mutationsAvailable: true,
        routes: {
            detail: (id) => homeAdministrationGitHubAppPath(serverId, id),
            edit: (id) => homeAdministrationGitHubAppEditPath(serverId, id),
            signIn: homeAdministrationPoliciesPath(serverId),
        },
    };
    // A freshly created App: registered, no verified installation yet.
    harness.answer(serverId, '/v1/identity/github-apps/list', { body: ManagedGitHubAppsListOutputV1Schema.parse({
        registrations: [{
            id: 'registration-1', owner: { kind: 'home' }, githubHost: 'https://github.com',
            githubAppId: '5801423', githubClientId: 'Iv1.client', githubAppSlug: 'happier-home',
            githubOwnerId: '357096320', githubOwnerLogin: 'acme', revision: 1, securityRevision: 1,
            state: 'draft',
            secretHealth: { clientSecretConfigured: true, privateKeyConfigured: true, webhookSecretConfigured: false },
            lastVerifiedAt: null, createdAt: '2026-11-17T14:10:00.000Z', updatedAt: '2026-11-17T14:10:00.000Z',
        }],
        installations: [],
    }) });
    harness.answer(serverId, '/v1/identity/github-apps/verify-installation', { body: ManagedGitHubAppVerifyInstallationOutputV1Schema.parse({ authorizeUrl: 'https://github.com/login/oauth/authorize', attemptId: 'attempt-1' }) });
});

function requestsFor(operation: string) {
    return harness.requestsFor(`/v1/identity/github-apps/${operation}`);
}

async function renderDetail(content: React.ReactElement) {
    const screen = await renderScreen(content);
    await waitForHomeGovernance(() => expect(screen.findByTestId('github-installation-id')).not.toBeNull());
    return screen;
}

describe('managed GitHub App installation verification form', () => {
    it.each([
        ['', '77', 'identityAdministration.githubInstallationIdRequired'],
        ['99', '', 'identityAdministration.githubOrganizationIdRequired'],
        ['', '', 'identityAdministration.githubInstallationIdsRequired'],
    ])('names the missing ID once (installation %j, organization %j) and sends nothing', async (installationId, organizationId, message) => {
        const screen = await renderDetail(<ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />);
        await act(async () => {
            screen.changeTextByTestId('github-installation-id', installationId);
            screen.changeTextByTestId('github-organization-id', organizationId);
        });
        await screen.pressByTestIdAsync('github-installation-verify');

        expect(requestsFor('verify-installation')).toHaveLength(0);
        expect(screen.getTextContent().split(message)).toHaveLength(2);
        expect(screen.getTextContent()).not.toContain('identityAdministration.error');

        await act(async () => { screen.changeTextByTestId('github-installation-id', '99'); });
        expect(screen.getTextContent()).not.toContain(message);
    });

    it('presents a refused verification once, not as a caption and a card', async () => {
        harness.answer(surface.scope.serverId, '/v1/identity/github-apps/verify-installation', {
            status: 403, body: ManagedGitHubAppErrorV1Schema.parse({ error: 'github_app_forbidden' }),
        });
        const message = managedGitHubAppFailureMessage('github_app_forbidden');
        const screen = await renderDetail(<ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />);
        await act(async () => {
            screen.changeTextByTestId('github-installation-id', '99');
            screen.changeTextByTestId('github-organization-id', '77');
        });
        await screen.pressByTestIdAsync('github-installation-verify');

        await vi.waitFor(() => expect(screen.getTextContent()).toContain(message));
        const text = screen.getTextContent();
        expect(text.split(message)).toHaveLength(2);
        // The old card added a generic "that did not go through" title under the same message.
        expect(text.replaceAll(message, '')).not.toContain('identityAdministration.error');
        expect(openExternalUrlMock).not.toHaveBeenCalled();
    });

    it('says the verification continues on GitHub once it opened', async () => {
        const screen = await renderDetail(<ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />);
        await act(async () => {
            screen.changeTextByTestId('github-installation-id', '99');
            screen.changeTextByTestId('github-organization-id', '77');
        });
        await screen.pressByTestIdAsync('github-installation-verify');

        expect(openExternalUrlMock).toHaveBeenCalledWith('https://github.com/login/oauth/authorize');
        expect(screen.getTextContent()).toContain('identityAdministration.githubVerificationOpened');
    });
});
