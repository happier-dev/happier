import React from 'react';
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
import { AccountSessionsSignOutEverywhereServerOutputV1Schema, ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1 } from '@happier-dev/protocol/auth/accountSessions';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const boundary = vi.hoisted(() => ({
    confirm: vi.fn(async () => false),
    alertAsync: vi.fn(async () => undefined),
}));
installDisconnectedServerSocketBoundary();
installSettingsViewCommonModuleMocks({
    storage: 'real',
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { confirm: boundary.confirm, alertAsync: boundary.alertAsync } }).module;
    },
});
const homes = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(homes);
const { AuthProvider } = await import('@/auth/context/AuthContext');

describe('Account session Security confirmation', () => {
    let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
    let restoreExecutor: (() => void) | undefined;
    let homeId: string;
    beforeEach(async () => {
        await loadSyncSingletonForTests();
        boundary.confirm.mockReset().mockResolvedValue(false);
        boundary.alertAsync.mockClear();
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

    it('keeps this device signed in when the person cancels global sign-out', async () => {
        const { AccountSessionSecuritySection } = await import('./AccountSessionSecuritySection');
        const screen = await renderScreen(<AuthProvider initialCredentials={account.credentials}><AccountSessionSecuritySection /></AuthProvider>);
        await screen.pressByTestIdAsync('settings-account-sign-out-everywhere');
        expect(boundary.confirm).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ destructive: true }));
        expect(homes.requestsFor(ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1)).toHaveLength(0);
        await expect(TokenStorage.getCredentialsForServerUrl(account.home.serverUrl, { serverId: account.serverId })).resolves.toEqual(account.credentials);
    });

    it('does not apply an old Account confirmation to the newly active Account', async () => {
        boundary.confirm.mockImplementationOnce(async () => {
            storage.getState().activateProfileScope({ serverId: getActiveServerSnapshot().serverId, accountId: 'account-b' });
            return true;
        });
        const { AccountSessionSecuritySection } = await import('./AccountSessionSecuritySection');
        const screen = await renderScreen(<AuthProvider initialCredentials={account.credentials}><AccountSessionSecuritySection /></AuthProvider>);
        await screen.pressByTestIdAsync('settings-account-sign-out-everywhere');
        expect(homes.requestsFor(ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1)).toHaveLength(0);
        await expect(TokenStorage.getCredentialsForServerUrl(account.home.serverUrl, { serverId: account.serverId })).resolves.toEqual(account.credentials);
        // The settings view mocks render translation keys.
        expect(boundary.alertAsync).toHaveBeenCalledWith(expect.any(String), 'settingsApiTokens.errors.accountChanged');
    });

    it('signs out the Account it was confirmed for when nothing changed', async () => {
        boundary.confirm.mockResolvedValueOnce(true);
        const { AccountSessionSecuritySection } = await import('./AccountSessionSecuritySection');
        const screen = await renderScreen(<AuthProvider initialCredentials={account.credentials}><AccountSessionSecuritySection /></AuthProvider>);
        await screen.pressByTestIdAsync('settings-account-sign-out-everywhere');
        await vi.waitFor(async () => expect(await TokenStorage.getCredentialsForServerUrl(account.home.serverUrl, { serverId: account.serverId })).toBeNull());
        expect(homes.requestsFor(ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1)).toHaveLength(1);
    });
});
