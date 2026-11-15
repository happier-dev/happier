import * as React from 'react';
import { homeAdministrationGitHubAppCreatePath, homeAdministrationGitHubAppPath, homeAdministrationGitHubAppEditPath, homeAdministrationPoliciesPath } from '../governance/homeAdministrationRoutes';
import { teamGitHubAppPath, teamGitHubAppEditPath, teamAuthenticationPath, teamDirectoryPath, teamIdentityProviderSetupPath } from '../../teams/teamsRoutes';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { ManagedGitHubAppsListOutputV1Schema } from '@happier-dev/protocol/identity/githubApps';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';

const pushMock = vi.hoisted(() => vi.fn());

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: pushMock } }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
const projection = ManagedGitHubAppsListOutputV1Schema.parse({
    registrations: [{
        id: 'registration-1',
        owner: { kind: 'team', teamId: 'team-1' },
        githubHost: 'https://github.com',
        githubAppId: '12',
        githubClientId: 'Iv1.client',
        githubAppSlug: 'acme-happier',
        githubOwnerId: '42',
        githubOwnerLogin: 'acme',
        revision: 3,
        securityRevision: 2,
        state: 'needs_attention',
        secretHealth: {
            clientSecretConfigured: true,
            privateKeyConfigured: true,
            webhookSecretConfigured: false,
        },
        lastVerifiedAt: null,
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-01T10:00:00.000Z',
    }],
    installations: [],
});

const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ItemList } = await import('@/components/ui/lists/ItemList');
const { ManagedGitHubAppsSection } = await import('./ManagedGitHubAppsSection');
const listPath = '/v1/identity/github-apps/list';
let serverId: string;

function SettingsPage({ children }: React.PropsWithChildren) {
    return <ItemList>{children}</ItemList>;
}

beforeEach(async () => {
    standardCleanup();
    pushMock.mockReset();
    await harness.reset();
    serverId = await harness.addHome({ name: 'GitHub Home', serverUrl: 'https://github-controls.example', accountId: 'account-1', teamsEnabled: true });
    harness.answer(serverId, listPath, { body: projection });
});

describe('ManagedGitHubAppsSection', () => {
    it('keeps retained registrations reachable while policy disables only creation', async () => {
        const screen = await renderScreen(<ManagedGitHubAppsSection
            surface={{
                scope: { serverId, accountId: 'account-1' },
                owner: { kind: 'team', teamId: 'team-1' },
                mutationsAvailable: true,
                routes: {
                    detail: (id) => teamGitHubAppPath({ serverId, teamId: 'team-1' }, id),
                    edit: (id) => teamGitHubAppEditPath({ serverId, teamId: 'team-1' }, id),
                    signIn: teamAuthenticationPath({ serverId, teamId: 'team-1' }),
                    directory: teamDirectoryPath({ serverId, teamId: 'team-1' }),
                },
            }}
            createPath={teamIdentityProviderSetupPath({ serverId, teamId: 'team-1' }, 'github_app_identity')}
            createAvailable={false}
        />, { wrapper: SettingsPage });

        await vi.waitFor(() => expect(screen.findByTestId('home-github-app:registration-1')).not.toBeNull());
        expect(screen.findByTestId('home-github-app-add')?.props.disabled).toBe(true);
        await screen.pressByTestIdAsync('home-github-app:registration-1');
        expect(pushMock).toHaveBeenCalledTimes(1);
        expect(pushMock).toHaveBeenCalledWith(teamGitHubAppPath({ serverId, teamId: 'team-1' }, 'registration-1'));
        expect(harness.requestsFor(listPath)).toEqual([expect.objectContaining({
            serverId,
            input: { owner: { kind: 'team', teamId: 'team-1' } },
        })]);
    });

    it('presents a failed list read as a read, never as a change that did not go through', async () => {
        harness.answer(serverId, listPath, { status: 409, body: { error: 'github_installation_unverified' } });
        const screen = await renderScreen(<ManagedGitHubAppsSection
            surface={{
                scope: { serverId, accountId: 'account-1' },
                owner: { kind: 'home' },
                mutationsAvailable: true,
                routes: {
                    detail: (id) => homeAdministrationGitHubAppPath(serverId, id),
                    edit: (id) => homeAdministrationGitHubAppEditPath(serverId, id),
                    signIn: homeAdministrationPoliciesPath(serverId),
                },
            }}
            createPath={homeAdministrationGitHubAppCreatePath(serverId)}
        />, { wrapper: SettingsPage });

        await vi.waitFor(() => expect(screen.findByTestId('managed-github-apps-unavailable')).not.toBeNull());
        expect(screen.getTextContent()).toContain('identityAdministration.githubAppsReadFailed');
        expect(screen.getTextContent()).not.toContain('identityAdministration.error');
        expect(screen.getTextContent()).not.toContain('github_installation_unverified');
    });
});
