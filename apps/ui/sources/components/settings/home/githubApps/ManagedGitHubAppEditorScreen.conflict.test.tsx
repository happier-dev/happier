import * as React from 'react';
import { homeAdministrationGitHubAppPath, homeAdministrationGitHubAppEditPath, homeAdministrationPoliciesPath } from '../governance/homeAdministrationRoutes';
import { AppState } from 'react-native';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

import { ManagedGitHubAppsListOutputV1Schema } from '@happier-dev/protocol/identity/githubApps';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries, waitForHomeGovernance } from '@/dev/testkit/harness/homeGovernanceHarness';
const replaceMock = vi.hoisted(() => vi.fn());

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { replace: replaceMock } }).module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/utils/url/openExternalUrl', () => ({ openExternalUrl: vi.fn(async () => true) }));
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);
const harness = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(harness);
const { ManagedGitHubAppEditorContent } = await import('./ManagedGitHubAppEditorScreen');
const { publishHomeAccountChange } = await import('@/sync/runtime/orchestration/homeAccountChange');
const listPath = '/v1/identity/github-apps/list';
const updatePath = '/v1/identity/github-apps/update';

function readyState(revision: number, githubClientId: string) {
    return ManagedGitHubAppsListOutputV1Schema.parse({
        registrations: [{
            id: 'registration-1', owner: { kind: 'home' as const }, githubHost: 'https://github.com',
            githubAppId: '12', githubClientId, githubAppSlug: 'happier',
            githubOwnerId: '22', githubOwnerLogin: 'happier-dev', revision, securityRevision: 1,
            state: 'verified' as const,
            secretHealth: { clientSecretConfigured: true, privateKeyConfigured: true, webhookSecretConfigured: true },
            lastVerifiedAt: '2026-09-01T10:00:00.000Z', createdAt: '2026-08-01T10:00:00.000Z',
            updatedAt: '2026-09-01T10:00:00.000Z',
        }],
        installations: [],
    });
}

const surface = {
    scope: { serverId: 'home-1', accountId: 'account-1' },
    owner: { kind: 'home' as const },
    mutationsAvailable: true,
    routes: {
        detail: (id: string) => homeAdministrationGitHubAppPath(surface.scope.serverId, id),
        edit: (id: string) => homeAdministrationGitHubAppEditPath(surface.scope.serverId, id),
        signIn: homeAdministrationPoliciesPath('home-1'),
    },
};

async function renderEditor() {
    const screen = await renderScreen(<ManagedGitHubAppEditorContent
        surface={surface}
        manifestReturn={{ kind: 'home', serverId: surface.scope.serverId }}
        registrationId="registration-1"
    />);
    await waitForHomeGovernance(() => expect(screen.findByTestId('github-app-client-id')).not.toBeNull());
    return screen;
}

beforeEach(async () => {
    standardCleanup();
    await harness.reset();
    surface.scope.serverId = await harness.addHome({ name: 'Home', serverUrl: 'https://github-conflict.test', accountId: 'account-1' });
    surface.routes.signIn = homeAdministrationPoliciesPath(surface.scope.serverId);
    replaceMock.mockReset();
    harness.answer(surface.scope.serverId, listPath, { body: readyState(2, 'Iv1.original') });
});

describe('ManagedGitHubAppEditorContent revision and secret continuity', () => {
    it('preserves a dirty draft when a refresh advances the registration and saves only after explicit reload', async () => {
        const screen = await renderEditor();
        await act(async () => screen.changeTextByTestId('github-app-client-id', 'Iv1.local-edit'));

        harness.answer(surface.scope.serverId, listPath, { body: readyState(3, 'Iv1.remote-edit') });
        await act(async () => publishHomeAccountChange(surface.scope.serverId));
        await waitForHomeGovernance(() => expect(screen.findByTestId('github-app-reload-conflict')).not.toBeNull());

        expect(screen.findByTestId('github-app-client-id')?.props.value).toBe('Iv1.local-edit');
        expect(screen.findByTestId('github-app-save')?.props.disabled).toBe(true);
        expect(screen.findByTestId('github-app-reload-conflict')).not.toBeNull();

        await screen.pressByTestIdAsync('github-app-reload-conflict');
        expect(screen.findByTestId('github-app-client-id')?.props.value).toBe('Iv1.remote-edit');

        await act(async () => screen.changeTextByTestId('github-app-client-id', 'Iv1.reviewed-edit'));
        harness.answer(surface.scope.serverId, updatePath, { body: { registration: readyState(4, 'Iv1.reviewed-edit').registrations[0] } });
        await screen.pressByTestIdAsync('github-app-save');

        expect(harness.requestsFor(updatePath)[0]?.input).toMatchObject({ expectedRevision: 3 });
        expect(replaceMock).toHaveBeenCalledWith(homeAdministrationGitHubAppPath(surface.scope.serverId, 'registration-1'));
    });

    it('refreshes an Action CAS conflict and waits for a newer projection before offering reload', async () => {
        harness.answer(surface.scope.serverId, updatePath, { status: 409, body: { error: 'github_app_revision_conflict' } });
        const screen = await renderEditor();
        await act(async () => screen.changeTextByTestId('github-app-client-id', 'Iv1.local-edit'));

        await screen.pressByTestIdAsync('github-app-save');

        await waitForHomeGovernance(() => expect(harness.requestsFor(listPath)).toHaveLength(2));
        expect(screen.findByTestId('github-app-save')?.props.disabled).toBe(true);
        expect(screen.findByTestId('github-app-reload-conflict')).toBeNull();
        await screen.pressByTestIdAsync('github-app-refresh-conflict');
        await waitForHomeGovernance(() => expect(harness.requestsFor(listPath)).toHaveLength(3));

        harness.answer(surface.scope.serverId, listPath, { body: readyState(3, 'Iv1.remote-edit') });
        await act(async () => publishHomeAccountChange(surface.scope.serverId));
        await waitForHomeGovernance(() => expect(screen.findByTestId('github-app-reload-conflict')).not.toBeNull());
        expect(screen.findByTestId('github-app-refresh-conflict')).toBeNull();
        expect(screen.findByTestId('github-app-reload-conflict')).not.toBeNull();
    });

    it('clears unsaved App secrets when the app leaves the active state', async () => {
        let onAppStateChange: ((state: string) => void) | null = null;
        vi.spyOn(AppState, 'addEventListener').mockImplementation((_, listener) => {
            onAppStateChange = listener as (state: string) => void;
            return { remove: vi.fn() };
        });
        const screen = await renderEditor();
        await act(async () => {
            screen.changeTextByTestId('github-app-client-secret', 'client-secret');
            screen.changeTextByTestId('github-app-private-key', 'private-key');
            screen.changeTextByTestId('github-app-webhook-secret', 'webhook-secret');
        });

        await act(async () => onAppStateChange?.('inactive'));

        expect(screen.findByTestId('github-app-client-secret')?.props.value).toBe('');
        expect(screen.findByTestId('github-app-private-key')?.props.value).toBe('');
        expect(screen.findByTestId('github-app-webhook-secret')?.props.value).toBe('');
    });

    it('does not offer local-only edits when mutations are unavailable', async () => {
        const screen = await renderScreen(
            <ManagedGitHubAppEditorContent
                surface={{ ...surface, mutationsAvailable: false }}
                manifestReturn={{ kind: 'home', serverId: surface.scope.serverId }}
                registrationId="registration-1"
            />,
        );

        await waitForHomeGovernance(() => expect(screen.findByTestId('github-app-client-id')).not.toBeNull());
        expect(screen.findByTestId('github-app-client-id')?.props.editable).toBe(false);
        expect(screen.findByTestId('github-app-client-secret')?.props.editable).toBe(false);
        expect(screen.findByTestId('github-app-private-key')?.props.editable).toBe(false);
        expect(screen.findByTestId('github-app-webhook-secret')?.props.editable).toBe(false);
        expect(screen.findByTestId('github-app-save')?.props.disabled).toBe(true);
    });
});
