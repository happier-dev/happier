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
  consumePendingGitHubAppVerification,
  recordPendingGitHubAppVerification,
} from '@/components/settings/home/githubApps/githubAppOAuthReturn';

installTokenStorageWebPlatformMocks();
const verifiedReturn = {
  provider: 'github-app',
  flow: 'connect',
  purpose: 'github_app_installation_verification',
  verified: '1',
  registrationId: 'registration-1',
  installationId: 'installation-1',
  error: '',
} as const;
const boundary = vi.hoisted(() => ({ params: {} as Record<string, string> }));
vi.mock('socket.io-client', async (original) =>
  (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
  ).createSocketIoClientBoundary(original),
);
vi.mock('expo-router', async () => ({
  ...(await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
  useLocalSearchParams: () => boundary.params,
}));
vi.mock('react-native-unistyles', async () =>
  (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock(),
);
vi.mock('@expo/vector-icons', async () =>
  (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock(),
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);

await initializeAuthRouteRuntimeForTests();
const { default: OAuthProviderReturn } = await import('./[provider]');

let screen: Awaited<ReturnType<typeof renderScreen>> | undefined;
afterEach(async () => {
  await screen?.unmount();
  screen = undefined;
  consumePendingGitHubAppVerification('registration-1');
  vi.clearAllMocks();
});

async function renderReturn(params: Record<string, string>) {
  boundary.params = { ...params };
  screen = await renderScreen(
    <AuthProvider initialCredentials={null}>
      <OAuthProviderReturn />
    </AuthProvider>,
  );
}

it('returns to the App the verification started from', async () => {
  recordPendingGitHubAppVerification({
    registrationId: 'registration-1',
    returnTo: '/settings/apps/registration-1',
  });
  await renderReturn(verifiedReturn);
  await vi.waitFor(() =>
    expect(router.replace).toHaveBeenCalledWith(
      '/settings/apps/registration-1',
    ),
  );
  expect(Modal.alertAsync).not.toHaveBeenCalled();
});

// The Home verified and stored the installation; only this browser lacks the record of
// where the verification started (the return landed on another origin or browser).
// Saying "nothing was changed" would be false.
it('says the installation was verified when this browser holds no verification record', async () => {
  await renderReturn(verifiedReturn);
  await vi.waitFor(() =>
    expect(router.replace).toHaveBeenCalledWith('/settings'),
  );
  expect(Modal.alertAsync).toHaveBeenCalledWith(
    t('identityAdministration.githubInstallationVerifiedTitle'),
    t('identityAdministration.githubInstallationVerifiedElsewhere'),
  );
  expect(Modal.alertAsync).not.toHaveBeenCalledWith(
    t('common.error'),
    expect.anything(),
  );
});

it('keeps the failure message when GitHub returned an error', async () => {
  recordPendingGitHubAppVerification({
    registrationId: 'registration-1',
    returnTo: '/settings/apps/registration-1',
  });
  await renderReturn({
    ...verifiedReturn,
    verified: '',
    installationId: '',
    error: 'github_app_forbidden',
  });
  await vi.waitFor(() =>
    expect(router.replace).toHaveBeenCalledWith(
      '/settings/apps/registration-1',
    ),
  );
  expect(Modal.alertAsync).toHaveBeenCalledTimes(1);
  expect(Modal.alertAsync).toHaveBeenCalledWith(
    t('common.error'),
    t('identityAdministration.error'),
  );
});

it('keeps the failure message when the return names no verified installation', async () => {
  await renderReturn({ ...verifiedReturn, installationId: '' });
  await vi.waitFor(() =>
    expect(router.replace).toHaveBeenCalledWith('/settings'),
  );
  expect(Modal.alertAsync).toHaveBeenCalledTimes(1);
  expect(Modal.alertAsync).toHaveBeenCalledWith(
    t('common.error'),
    t('identityAdministration.error'),
  );
});
