import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_LOCK_RECOVERY_ROUTES } from '@happier-dev/protocol';

import { renderScreen } from '@/dev/testkit';
import { installSettingsViewCommonModuleMocks } from '../settingsViewTestHelpers';

const boundary = vi.hoisted(() => ({
    serverFetch: vi.fn(),
    prompt: vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => null),
    alert: vi.fn(),
}));

installSettingsViewCommonModuleMocks({
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({ spies: boundary }).module;
    },
});
// Keep the screen, app-lock state, validation and API adapter real below HTTP/native boundaries.
vi.mock('@/sync/http/client', () => ({ serverFetch: boundary.serverFetch }));
vi.mock('@/sync/domains/state/storageStore', async () => {
    const { createReactiveStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
    const { settingsDefaults } = await import('@/sync/domains/settings/settings');
    const storage = createReactiveStorageStoreMock({ settings: settingsDefaults, localSettings: localSettingsDefaults });
    return { storage, getStorage: () => storage };
});

const savedMail = {
    recoveryEmail: 'recipient@example.com',
    host: 'smtp.example.com', port: 587, security: 'starttls', username: 'smtp-user',
    fromAddress: 'sender@example.com', hasPassword: true,
};

const { AppLockSettingsView } = await import('./AppLockSettingsView');

describe('App lock test email recipient', () => {
    beforeEach(async () => {
        vi.stubGlobal('BroadcastChannel', undefined);
        boundary.prompt.mockClear();
        boundary.alert.mockClear();
        boundary.serverFetch.mockReset();
        boundary.serverFetch.mockImplementation(async (path: string) => {
            if (path === '/v1/features') return Response.json({ features: {
                appLock: { emailRecovery: { enabled: true } },
            } });
            if (path === APP_LOCK_RECOVERY_ROUTES.mailSettings) {
                return Response.json({ settings: savedMail });
            }
            if (path === APP_LOCK_RECOVERY_ROUTES.mailSettingsTest) return Response.json({ ok: true });
            throw new Error(`Unexpected request: ${path}`);
        });
        vi.stubGlobal('fetch', vi.fn(async () => Response.json({ features: {
            appLock: { emailRecovery: { enabled: true } },
        } })));
        const { deactivateAppLock } = await import('@/auth/appLock/appLockRuntime');
        await deactivateAppLock();
    });

    it('uses the saved account-wide recovery recipient without prompting or sending to the SMTP sender', async () => {
        const screen = await renderScreen(<AppLockSettingsView />);
        await screen.pressByTestIdAsync('app-lock-mail-test');
        expect(boundary.prompt).not.toHaveBeenCalled();
        expect(boundary.serverFetch).toHaveBeenCalledWith(APP_LOCK_RECOVERY_ROUTES.mailSettingsTest,
            expect.objectContaining({ body: JSON.stringify({}) }), {});
    });

    it('keeps the test button visible and disabled without a saved valid recipient', async () => {
        boundary.serverFetch.mockImplementation(async (path: string) => {
            if (path === '/v1/features') return Response.json({ features: { appLock: { emailRecovery: { enabled: true } } } });
            if (path === APP_LOCK_RECOVERY_ROUTES.mailSettings) return Response.json({ settings: { ...savedMail, recoveryEmail: null } });
            throw new Error(`Unexpected request: ${path}`);
        });
        const screen = await renderScreen(<AppLockSettingsView />);
        expect(screen.findByTestId('app-lock-mail-test')?.props.disabled).toBe(true);
        expect(screen.findByTestId('app-lock-settings-email')).not.toBeNull();
    });

    it('sends Test Email with no recipient body; the server uses its shared saved address', async () => {
        const screen = await renderScreen(<AppLockSettingsView />);
        await screen.pressByTestIdAsync('app-lock-mail-test');
        expect(boundary.serverFetch).toHaveBeenCalledWith(APP_LOCK_RECOVERY_ROUTES.mailSettingsTest,
            expect.objectContaining({ body: JSON.stringify({}) }), {});
        expect(boundary.prompt).not.toHaveBeenCalled();
    });

    it('saves the recovery address with the account-wide mail settings', async () => {
        const screen = await renderScreen(<AppLockSettingsView />);
        await act(async () => {
            screen.changeTextByTestId('app-lock-settings-email', 'new-recipient@example.net');
        });
        await screen.pressByTestIdAsync('app-lock-mail-save');
        expect(boundary.serverFetch).toHaveBeenCalledWith(APP_LOCK_RECOVERY_ROUTES.mailSettings,
            expect.objectContaining({
                method: 'PUT',
                body: expect.stringContaining('"recoveryEmail":"new-recipient@example.net"'),
            }), {});
    });

    it('requires the current device password before the mail editor can change recovery settings', async () => {
        const { createAppLockKeys } = await import('@/auth/appLock/appLockCrypto');
        const { activateAppLock } = await import('@/auth/appLock/appLockRuntime');
        const keys = await createAppLockKeys('current-password', { N: 1024, r: 8, p: 1 });
        await activateAppLock({
            v: 1, lockId: 'lock_0123456789abcdefghijkl', email: savedMail.recoveryEmail,
            serverUrl: 'https://relay.example.test', wrapped: keys.wrapped, autoLockMinutes: 5, biometric: false,
        }, keys.dataKey);
        const screen = await renderScreen(<AppLockSettingsView />);
        await act(async () => { screen.changeTextByTestId('app-lock-settings-email', 'new-recipient@example.net'); });
        boundary.prompt.mockResolvedValueOnce('wrong-password');
        await screen.pressByTestIdAsync('app-lock-mail-save');
        expect(boundary.prompt).toHaveBeenCalled();
        expect(boundary.serverFetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(0);
        boundary.prompt.mockResolvedValueOnce('current-password');
        await screen.pressByTestIdAsync('app-lock-mail-save');
        expect(boundary.serverFetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);

        // A password proof begun while unlocked cannot survive a re-lock during derivation.
        const runtime = await import('@/auth/appLock/appLockRuntime');
        boundary.prompt.mockImplementationOnce(async () => {
            const checking = runtime.verifyAppLockPassword('current-password');
            runtime.lockAppLock();
            expect(await checking).toBe(false);
            return 'current-password';
        });
        await screen.pressByTestIdAsync('app-lock-mail-save');
        expect(boundary.serverFetch.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1);
    });

    it('keeps the shared mail editor current after the guarded recovery-email change', async () => {
        const { createAppLockKeys } = await import('@/auth/appLock/appLockCrypto');
        const { activateAppLock } = await import('@/auth/appLock/appLockRuntime');
        const keys = await createAppLockKeys('current-password', { N: 1024, r: 8, p: 1 });
        await activateAppLock({
            v: 1, lockId: 'lock_0123456789abcdefghijkl', email: savedMail.recoveryEmail,
            serverUrl: 'https://relay.example.test', wrapped: keys.wrapped, autoLockMinutes: 5, biometric: false,
        }, keys.dataKey);
        boundary.serverFetch.mockImplementation(async (path: string, init?: RequestInit) => {
            if (path === '/v1/features') return Response.json({ features: {
                appLock: { emailRecovery: { enabled: true } },
            } });
            if (path === APP_LOCK_RECOVERY_ROUTES.mailSettings && init?.method === 'GET') {
                return Response.json({ settings: savedMail });
            }
            return Response.json({ ok: true });
        });
        const screen = await renderScreen(<AppLockSettingsView />);
        boundary.prompt.mockResolvedValueOnce('current-password').mockResolvedValueOnce('updated@example.net');
        await screen.pressByTestIdAsync('app-lock-change-email');
        expect(screen.findByTestId('app-lock-settings-email')?.props.value).toBe('updated@example.net');
        boundary.prompt.mockResolvedValueOnce('current-password');
        await screen.pressByTestIdAsync('app-lock-mail-save');
        expect(boundary.serverFetch.mock.calls.filter(([, init]) => init?.method === 'PUT').at(-1)?.[1]?.body)
            .toContain('"recoveryEmail":"updated@example.net"');
    });

    it('keeps Test Email disabled until server settings have been saved, even with a valid recipient', async () => {
        boundary.serverFetch.mockImplementation(async (path: string) => {
            if (path === APP_LOCK_RECOVERY_ROUTES.mailSettings) return Response.json({ settings: null });
            throw new Error(`Unexpected request: ${path}`);
        });
        const screen = await renderScreen(<AppLockSettingsView />);
        expect(screen.findByTestId('app-lock-mail-test')?.props.disabled).toBe(true);
    });
});
