import React from 'react';
import { Alert } from 'react-native';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// The static storage graph reaches the Socket.IO transport; register its external boundary before any import.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import { installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { AppPresentationPlatformProvider } from '@/components/ui/presentation/AppPresentationPlatformProvider';
import { AccountSessionsSignOutEverywhereServerOutputV1Schema, ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1 } from '@happier-dev/protocol/auth/accountSessions';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';
import { act } from 'react-test-renderer';

installDisconnectedServerSocketBoundary();
installSettingsViewCommonModuleMocks({ storage: 'real' });
vi.doUnmock('@/modal');
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { AuthProvider } = await import('@/auth/context/AuthContext');
const { ModalProvider } = await import('@/modal');

describe('Account session Security confirmation', () => {
    let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
    let restoreExecutor: (() => void) | undefined;
    let homeId: string;
    beforeEach(async () => {
        await loadSyncSingletonForTests();
        installHomeGovernanceBoundaries(homes);
        restoreExecutor = await installRealActionExecutorModuleLoader();
        homeId = await homes.addHome({ name: 'Sign-out Home', serverUrl: 'https://sign-out-home.example.test', accountId: 'account-a' });
        homes.answer(homeId, ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1, {
            body: AccountSessionsSignOutEverywhereServerOutputV1Schema.parse({ status: 'signed_out' }),
        });
        // A real applied Home and Account: the confirmation binds to them.
        account = await restoreServerAccountForTest({ serverUrl: 'https://sign-out-home.example.test', accountId: 'account-a', request: homes.request });
        storage.getState().activateProfileScope({ serverId: getActiveServerSnapshot().serverId, accountId: 'account-a' });
    });
    afterEach(async () => {
        await account?.dispose();
        retireActiveServerAccountScopeLifetime();
        storage.getState().clearProfileScope();
        standardCleanup();
        restoreExecutor?.();
        await homes.reset();
    });

    async function openConfirmation() {
        const { AccountSessionSecuritySection } = await import('./AccountSessionSecuritySection');
        const screen = await renderScreen(
            <AppPresentationPlatformProvider>
                <AuthProvider initialCredentials={account.credentials}>
                    <ModalProvider><AccountSessionSecuritySection /></ModalProvider>
                </AuthProvider>
            </AppPresentationPlatformProvider>,
        );
        await act(async () => { screen.pressByTestId('settings-account-sign-out-everywhere'); });
        return screen;
    }

    it('keeps this device signed in when the person cancels after selecting API-token revocation', async () => {
        const screen = await openConfirmation();
        await screen.pressByTestIdAsync('web-modal-confirm-toggle');
        await screen.pressByTestIdAsync('web-modal-cancel');
        expect(homes.requestsFor(ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1)).toHaveLength(0);
        await expect(TokenStorage.getCredentialsForServerUrl(account.home.serverUrl, { serverId: account.serverId })).resolves.toEqual(account.credentials);
    });

    it('does not apply an old Account confirmation to the newly active Account', async () => {
        const screen = await openConfirmation();
        // The confirmation is hosted by the app on native, while this feedback uses the OS alert.
        const nativeAlert = vi.spyOn(Alert, 'alert');
        try {
            await act(async () => {
                storage.getState().activateProfileScope({ serverId: getActiveServerSnapshot().serverId, accountId: 'account-b' });
            });
            await screen.pressByTestIdAsync('web-modal-confirm');
            await vi.waitFor(() => expect(nativeAlert.mock.calls[0]?.[1]).toBe('settingsApiTokens.errors.accountChanged'));
            await act(async () => { nativeAlert.mock.calls[0]?.[2]?.[0]?.onPress?.(); });
        } finally {
            nativeAlert.mockRestore();
        }
        expect(homes.requestsFor(ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1)).toHaveLength(0);
        await expect(TokenStorage.getCredentialsForServerUrl(account.home.serverUrl, { serverId: account.serverId })).resolves.toEqual(account.credentials);
    });

    it.each([false, true])('signs out and submits the checkbox decision (%s)', async revokeApiTokens => {
        const screen = await openConfirmation();
        if (revokeApiTokens) await screen.pressByTestIdAsync('web-modal-confirm-toggle');
        await screen.pressByTestIdAsync('web-modal-confirm');
        await vi.waitFor(async () => expect(await TokenStorage.getCredentialsForServerUrl(account.home.serverUrl, { serverId: account.serverId })).toBeNull());
        expect(homes.requestsFor(ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1)).toEqual([
            expect.objectContaining({ input: revokeApiTokens ? { revokeApiTokens: true } : {} }),
        ]);
    });
});
