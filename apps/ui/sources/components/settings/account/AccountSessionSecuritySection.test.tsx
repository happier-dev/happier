import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const boundary = vi.hoisted(() => ({
    confirm: vi.fn(async () => false),
    alertAsync: vi.fn(async () => undefined),
    logout: vi.fn(async () => ({ kind: 'completed' as const })),
}));
installDisconnectedServerSocketBoundary();
installSettingsViewCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: { confirm: boundary.confirm, alertAsync: boundary.alertAsync } }).module;
    },
});
// The authenticated device session is supplied by the platform auth boundary.
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: { token: 'test-token' }, logout: boundary.logout }),
}));


describe('Account session Security confirmation', () => {
    let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
    beforeEach(async () => {
        await loadSyncSingletonForTests();
        boundary.confirm.mockReset().mockResolvedValue(false);
        boundary.alertAsync.mockClear();
        boundary.logout.mockClear();
        // A real applied Home and Account: the confirmation binds to them.
        account = await restoreServerAccountForTest({ serverUrl: 'https://sign-out-home.example.test', accountId: 'account-a' });
        storage.getState().activateProfileScope({ serverId: getActiveServerSnapshot().serverId, accountId: 'account-a' });
    });
    afterEach(async () => {
        await account.dispose();
        retireActiveServerAccountScopeLifetime();
        storage.getState().clearProfileScope();
        standardCleanup();
    });

    it('keeps this device signed in when the person cancels global sign-out', async () => {
        const { AccountSessionSecuritySection } = await import('./AccountSessionSecuritySection');
        const screen = await renderScreen(<AccountSessionSecuritySection />);
        await screen.pressByTestIdAsync('settings-account-sign-out-everywhere');
        expect(boundary.confirm).toHaveBeenCalledWith(expect.any(String), expect.any(String), expect.objectContaining({ destructive: true }));
        expect(boundary.logout).not.toHaveBeenCalled();
    });

    it('does not apply an old Account confirmation to the newly active Account', async () => {
        boundary.confirm.mockImplementationOnce(async () => {
            storage.getState().activateProfileScope({ serverId: getActiveServerSnapshot().serverId, accountId: 'account-b' });
            return true;
        });
        const { AccountSessionSecuritySection } = await import('./AccountSessionSecuritySection');
        const screen = await renderScreen(<AccountSessionSecuritySection />);
        await screen.pressByTestIdAsync('settings-account-sign-out-everywhere');
        expect(boundary.logout).not.toHaveBeenCalled();
        // The settings view mocks render translation keys.
        expect(boundary.alertAsync).toHaveBeenCalledWith(expect.any(String), 'settingsApiTokens.errors.accountChanged');
    });

    it('signs out the Account it was confirmed for when nothing changed', async () => {
        boundary.confirm.mockResolvedValueOnce(true);
        const { AccountSessionSecuritySection } = await import('./AccountSessionSecuritySection');
        const screen = await renderScreen(<AccountSessionSecuritySection />);
        await screen.pressByTestIdAsync('settings-account-sign-out-everywhere');
        expect(boundary.logout).toHaveBeenCalledTimes(1);
    });
});
