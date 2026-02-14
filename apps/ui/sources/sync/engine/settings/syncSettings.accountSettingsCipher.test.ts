import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Encryption } from '@/sync/encryption/encryption';
import { openAccountScopedBlobCiphertext } from '@happier-dev/protocol';

const mocks = vi.hoisted(() => {
    const settingsParse = vi.fn((value: unknown) => {
        const record =
            value && typeof value === 'object' && !Array.isArray(value)
                ? (value as Record<string, unknown>)
                : {};
        return {
            analyticsOptOut: false,
            ...record,
        };
    });

    return {
        getRandomBytes: vi.fn((length: number) => new Uint8Array(length).fill(4)),
        serverFetch: vi.fn(),
        applySettingsFn: vi.fn((base: Record<string, unknown>, delta: Record<string, unknown>) => ({
            ...base,
            ...delta,
        })),
        settingsParse,
        storageState: {
            settings: {
                analyticsOptOut: false,
            } as Record<string, unknown>,
            settingsVersion: 9,
            applySettings: vi.fn(),
            replaceSettings: vi.fn(),
            applySettingsLocal: vi.fn(),
        },
    };
});

vi.mock('@/track', () => ({
    tracking: null,
}));

vi.mock('@/utils/errors/errors', () => ({
    HappyError: class HappyError extends Error {
        constructor(message: string) {
            super(message);
        }
    },
}));

vi.mock('@/sync/domains/settings/settings', () => ({
    applySettings: mocks.applySettingsFn,
    settingsDefaults: { analyticsOptOut: false },
    settingsParse: mocks.settingsParse,
}));

vi.mock('@/sync/domains/settings/debugSettings', () => ({
    summarizeSettings: () => ({}),
    summarizeSettingsDelta: () => ({}),
    dbgSettings: () => {},
    isSettingsSyncDebugEnabled: () => false,
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverUrl: 'http://127.0.0.1:3009' }),
}));

vi.mock('@/sync/domains/state/storage', () => ({
    storage: {
        getState: () => mocks.storageState,
    },
}));

vi.mock('@/sync/encryption/secretSettings', () => ({
    sealSecretsDeep: (value: unknown) => value,
}));

vi.mock('@/sync/http/client', () => ({
    serverFetch: mocks.serverFetch,
}));

vi.mock('@/platform/cryptoRandom', () => ({
    getRandomBytes: mocks.getRandomBytes,
}));

import { syncSettings } from './syncSettings';

const credentials: AuthCredentials = {
    token: 'token',
    encryption: {
        publicKey: 'public',
        machineKey: 'machine',
    },
};

const TEST_MACHINE_KEY = new Uint8Array(32).fill(11);

describe('syncSettings account settings ciphertext', () => {
    beforeEach(() => {
        mocks.serverFetch.mockReset();
        mocks.applySettingsFn.mockClear();
        mocks.settingsParse.mockClear();
        mocks.getRandomBytes.mockClear();
        mocks.storageState.settings = {
            analyticsOptOut: false,
        };
        mocks.storageState.settingsVersion = 9;
        mocks.storageState.applySettings.mockReset();
        mocks.storageState.replaceSettings.mockReset();
        mocks.storageState.applySettingsLocal.mockReset();
    });

    it('POSTs settings as a canonical account_scoped_v1 ciphertext (no encryptRaw)', async () => {
        const encryptionStub = {
            getContentPrivateKey: () => TEST_MACHINE_KEY,
            decryptRaw: vi.fn(async () => null),
            encryptRaw: vi.fn(async () => {
                throw new Error('encryptRaw should not be used for account settings');
            }),
        } as unknown as Encryption;

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ settings: null, settingsVersion: 10 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: { claudeLocalPermissionBridgeEnabled: true } as any,
            clearPendingSettings: vi.fn(),
        });

        expect(mocks.serverFetch).toHaveBeenCalled();
        const [url, init] = mocks.serverFetch.mock.calls[0];
        expect(url).toBe('/v1/account/settings');
        expect(init?.method).toBe('POST');
        expect(typeof init?.body).toBe('string');

        const body = JSON.parse(String(init?.body)) as { settings?: string };
        expect(typeof body.settings).toBe('string');

        const opened = openAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            ciphertext: body.settings!,
        });
        expect(opened?.format).toBe('account_scoped_v1');
        expect(opened?.value).toEqual(
            expect.objectContaining({
                analyticsOptOut: false,
                claudeLocalPermissionBridgeEnabled: true,
            }),
        );

        expect((encryptionStub.encryptRaw as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    });

    it('prefers protocol decryption for canonical ciphertext (no decryptRaw)', async () => {
        const encryptionStub = {
            getContentPrivateKey: () => TEST_MACHINE_KEY,
            decryptRaw: vi.fn(async () => {
                throw new Error('decryptRaw should not be used for canonical account_scoped_v1 ciphertext');
            }),
        } as unknown as Encryption;

        const ciphertext = (await import('@happier-dev/protocol')).sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: { analyticsOptOut: true },
            randomBytes: mocks.getRandomBytes,
        });

        mocks.serverFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ settings: ciphertext, settingsVersion: 12 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: {},
            clearPendingSettings: vi.fn(),
        });

        expect((encryptionStub.decryptRaw as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
        expect(mocks.storageState.applySettings).toHaveBeenCalledWith(
            expect.objectContaining({ analyticsOptOut: true }),
            12,
        );
    });
});
