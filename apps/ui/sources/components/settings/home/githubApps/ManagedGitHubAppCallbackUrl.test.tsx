import * as React from 'react';
import { homeAdministrationGitHubAppPath, homeAdministrationGitHubAppEditPath, homeAdministrationPoliciesPath } from '../governance/homeAdministrationRoutes';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { findTestInstanceByTypeContainingText } from '@/dev/testkit/render/renderScreen';

import { ManagedGitHubAppsListOutputV1Schema } from '@happier-dev/protocol/identity/githubApps';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';

import { installBrowserClipboardBoundary, renderScreen, standardCleanup } from '@/dev/testkit';

const setClipboardMock = vi.hoisted(() => vi.fn(async (_text: string) => true));
const callbackUrlMock = vi.hoisted(() => ({ value: 'https://home.example.test/v1/oauth/github-app/callback' as string | undefined }));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

vi.mock('expo-clipboard', () => ({ setStringAsync: setClipboardMock }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: vi.fn(async () => true) }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ManagedGitHubAppDetailContent } = await import('./ManagedGitHubAppDetailScreen');
const { ManagedGitHubAppEditorContent } = await import('./ManagedGitHubAppEditorScreen');
const listPath = '/v1/identity/github-apps/list';
function answerRegistration() {
    harness.answer(surface.scope.serverId, listPath, { body: ManagedGitHubAppsListOutputV1Schema.parse({
        registrations: [{
                id: 'registration-1',
                owner: { kind: 'home' },
                githubHost: 'https://github.com',
                githubAppId: '12',
                githubClientId: 'Iv1.client',
                githubAppSlug: 'happier',
                githubOwnerId: '22',
                githubOwnerLogin: 'happier-dev',
                revision: 2,
                securityRevision: 1,
                state: 'verified',
                secretHealth: { clientSecretConfigured: true, privateKeyConfigured: true, webhookSecretConfigured: true },
                lastVerifiedAt: '2026-09-01T10:00:00.000Z',
                createdAt: '2026-08-01T10:00:00.000Z',
                updatedAt: '2026-09-01T10:00:00.000Z',
                ...(callbackUrlMock.value === undefined ? {} : { callbackUrl: callbackUrlMock.value }),
            }],
        installations: [],
    }) });
}

const surface = {
    scope: { serverId: 'home-1', accountId: 'account-1' },
    owner: { kind: 'home' as const },
    mutationsAvailable: true,
    routes: {
        detail: (id: string) => homeAdministrationGitHubAppPath('home-1', id),
        edit: (id: string) => homeAdministrationGitHubAppEditPath('home-1', id),
        signIn: homeAdministrationPoliciesPath('home-1'),
    },
};

beforeEach(async () => {
    standardCleanup();
    await harness.reset();
    surface.scope.serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://home.example.test', accountId: 'account-1' });
    setClipboardMock.mockClear();
    installBrowserClipboardBoundary(async text => { await setClipboardMock(text); });
    callbackUrlMock.value = 'https://home.example.test/v1/oauth/github-app/callback';
    answerRegistration();
});

describe('managed GitHub App callback URL', () => {
    it('shows the Home-derived callback URL on the registration and copies the exact value', async () => {
        const screen = await renderScreen(
            <ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />,
        );

        await waitForHomeGovernance(() => expect(screen.findByTestId('github-app-callback-url')).not.toBeNull());
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('github-app-callback-url')!, 'Text', 'https://home.example.test/v1/oauth/github-app/callback')).toBeDefined();

        await screen.pressByTestIdAsync('github-app-callback-url');

        expect(setClipboardMock).toHaveBeenCalledWith('https://home.example.test/v1/oauth/github-app/callback');
    });

    it('offers the same copyable callback URL beside the manual setup fields', async () => {
        const screen = await renderScreen(
            <ManagedGitHubAppEditorContent
                surface={surface}
                manifestReturn={{ kind: 'home', serverId: 'home-1' }}
                registrationId="registration-1"
            />,
        );

        await waitForHomeGovernance(() => expect(screen.findByTestId('github-app-callback-url')).not.toBeNull());
        expect(findTestInstanceByTypeContainingText(screen.findByTestId('github-app-callback-url')!, 'Text', 'https://home.example.test/v1/oauth/github-app/callback')).toBeDefined();
    });

    it('renders no callback row when the Home publishes no public URL to derive one from', async () => {
        callbackUrlMock.value = undefined;
        answerRegistration();
        const detail = await renderScreen(
            <ManagedGitHubAppDetailContent surface={surface} registrationId="registration-1" />,
        );
        await waitForHomeGovernance(() => expect(detail.findByTestId('github-app-edit')).not.toBeNull());
        expect(detail.findByTestId('github-app-callback-url')).toBeNull();

        const editor = await renderScreen(
            <ManagedGitHubAppEditorContent
                surface={surface}
                manifestReturn={{ kind: 'home', serverId: 'home-1' }}
                registrationId="registration-1"
            />,
        );
        await waitForHomeGovernance(() => expect(harness.requestsFor(listPath)).toHaveLength(2));
        expect(editor.findByTestId('github-app-callback-url')).toBeNull();
    });
});
