import * as React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import { AuthProvider } from '@/auth/context/AuthContext';
import { router } from 'expo-router';
import { Modal } from '@/modal';
import { t } from '@/text';
import { initializeAuthRouteRuntimeForTests } from '@/dev/testkit/harness/authRouteRuntimeHarness';
import {
    consumePendingGitHubAppManifestSetup,
    recordPendingGitHubAppManifestSetup,
} from '@/components/settings/home/githubApps/githubAppOAuthReturn';
import { homeAdministrationGitHubAppPath } from '@/components/settings/home/governance/homeAdministrationRoutes';

installTokenStorageWebPlatformMocks();
const boundary = vi.hoisted(() => ({ params: {
    provider: 'github', flow: 'connect', purpose: 'github_app_manifest_setup', created: '1', registrationId: 'registration-1', error: '',
} as Record<string, string> }));
vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness'))
    .createSocketIoClientBoundary(original));
vi.mock('expo-router', async () => ({
    ...(await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
    useLocalSearchParams: () => boundary.params,
}));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module);

await initializeAuthRouteRuntimeForTests();
const { default: OAuthProviderReturn } = await import('./[provider]');

let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
afterEach(async () => {
    await screen?.unmount();
    screen = undefined;
    consumePendingGitHubAppManifestSetup();
    boundary.params.created = '1';
    boundary.params.error = '';
    vi.clearAllMocks();
});

it('opens the created registration in the administration tree the setup started from', async () => {
    recordPendingGitHubAppManifestSetup({ kind: 'home', serverId: 'server-1' });
    screen = await renderScreen(<AuthProvider initialCredentials={null}><OAuthProviderReturn /></AuthProvider>);
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith(homeAdministrationGitHubAppPath('server-1', 'registration-1')));
    expect(Modal.alertAsync).not.toHaveBeenCalled();
});

// GitHub created the App and the Home stored it; only this browser lacks the record
// of where the setup started (another browser, a cleared store). Saying "nothing was
// changed" would be false, so the return says the App exists and where to find it.
it('says the App was created when this browser holds no setup record', async () => {
    screen = await renderScreen(<AuthProvider initialCredentials={null}><OAuthProviderReturn /></AuthProvider>);
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/settings'));
    expect(Modal.alertAsync).toHaveBeenCalledWith(
        t('identityAdministration.githubManifestCreatedTitle'),
        t('identityAdministration.githubManifestCreatedElsewhere'),
    );
    expect(Modal.alertAsync).not.toHaveBeenCalledWith(t('common.error'), expect.anything());
});

it('keeps the failure message when GitHub returned no created App', async () => {
    boundary.params.created = '';
    boundary.params.error = 'github_app_forbidden';
    screen = await renderScreen(<AuthProvider initialCredentials={null}><OAuthProviderReturn /></AuthProvider>);
    await vi.waitFor(() => expect(router.replace).toHaveBeenCalledWith('/settings'));
    expect(Modal.alertAsync).toHaveBeenCalledWith(t('common.error'), t('identityAdministration.error'));
});
