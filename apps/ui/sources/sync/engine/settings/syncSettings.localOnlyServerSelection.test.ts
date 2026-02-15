import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Encryption } from '@/sync/encryption/encryption';
import { openAccountScopedBlobCiphertext, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

const mocks = vi.hoisted(() => {
    const settingsParse = vi.fn((value: unknown) => {
        const record =
            value && typeof value === 'object' && !Array.isArray(value)
                ? (value as Record<string, unknown>)
                : {};
        return {
            analyticsOptOut: false,
            terminalConnectLegacySecretExportEnabled: false,
            ...record,
        };
    });

    return {
        serverFetch: vi.fn(),
        applySettingsFn: vi.fn((base: Record<string, unknown>, delta: Record<string, unknown>) => ({
            ...base,
            ...delta,
        })),
        settingsParse,
        storageState: {
            settings: {
                analyticsOptOut: false,
                claudeLocalPermissionBridgeEnabled: true,
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

import { applySettingsLocalDelta, syncSettings } from './syncSettings';

const credentials: AuthCredentials = {
    token: 'token',
    encryption: {
        publicKey: 'public',
        machineKey: 'machine',
    },
};
const TEST_MACHINE_KEY = new Uint8Array(32).fill(11);
const encryptionStub = {
    getContentPrivateKey: () => TEST_MACHINE_KEY,
    decryptRaw: vi.fn(async () => null),
    encryptRaw: vi.fn(async () => 'ciphertext'),
} as unknown as Encryption;

describe('syncSettings local-only server-selection settings', () => {
    beforeEach(() => {
        mocks.serverFetch.mockReset();
        mocks.applySettingsFn.mockClear();
        mocks.settingsParse.mockClear();
        mocks.storageState.settings = {
            analyticsOptOut: false,
            claudeLocalPermissionBridgeEnabled: true,
            terminalConnectLegacySecretExportEnabled: false,
        };
        mocks.storageState.settingsVersion = 9;
        mocks.storageState.applySettings.mockReset();
        mocks.storageState.replaceSettings.mockReset();
        mocks.storageState.applySettingsLocal.mockReset();
        (encryptionStub.decryptRaw as unknown as ReturnType<typeof vi.fn>).mockReset();
        (encryptionStub.encryptRaw as unknown as ReturnType<typeof vi.fn>).mockReset();
    });

    it('does not rewrite server settings when GET ciphertext cannot be decrypted', async () => {
        mocks.serverFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ settings: 'ciphertext', settingsVersion: 12 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );
        (encryptionStub.decryptRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: {},
            clearPendingSettings: () => {},
        });

        expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
        expect(encryptionStub.encryptRaw).not.toHaveBeenCalled();
        expect(mocks.storageState.applySettings).toHaveBeenCalledWith(
            {
                analyticsOptOut: false,
                serverSelectionGroups: undefined,
                serverSelectionActiveTargetKind: undefined,
                serverSelectionActiveTargetId: undefined,
                terminalConnectLegacySecretExportEnabled: false,
            },
            12,
        );
    });

    it('does not rewrite when GET ciphertext is decryptable', async () => {
        const ciphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: { analyticsOptOut: true, claudeLocalPermissionBridgeEnabled: false },
            randomBytes: () => new Uint8Array(24).fill(1),
        });
        mocks.serverFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ settings: ciphertext, settingsVersion: 4 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: {},
            clearPendingSettings: () => {},
        });

        expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
        expect(encryptionStub.decryptRaw).not.toHaveBeenCalled();
        expect(mocks.storageState.applySettings).toHaveBeenCalledWith(
            {
                analyticsOptOut: true,
                claudeLocalPermissionBridgeEnabled: false,
                serverSelectionGroups: undefined,
                serverSelectionActiveTargetKind: undefined,
                serverSelectionActiveTargetId: undefined,
                terminalConnectLegacySecretExportEnabled: false,
            },
            4,
        );
    });

    it('preserves local server-selection settings when applying fetched settings', async () => {
        mocks.storageState.settings = {
            analyticsOptOut: false,
            serverSelectionGroups: [{ id: 'grp-dev', name: 'Dev', serverIds: ['server-a', 'server-b'], presentation: 'grouped' }],
            serverSelectionActiveTargetKind: 'group',
            serverSelectionActiveTargetId: 'grp-dev',
            terminalConnectLegacySecretExportEnabled: true,
        };

        const ciphertext = sealAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            payload: { analyticsOptOut: true },
            randomBytes: () => new Uint8Array(24).fill(2),
        });
        mocks.serverFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ settings: ciphertext, settingsVersion: 7 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: {},
            clearPendingSettings: () => {},
        });

        expect(mocks.storageState.applySettings).toHaveBeenCalledWith(
            {
                analyticsOptOut: true,
                serverSelectionGroups: [{ id: 'grp-dev', name: 'Dev', serverIds: ['server-a', 'server-b'], presentation: 'grouped' }],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'grp-dev',
                terminalConnectLegacySecretExportEnabled: true,
            },
            7,
        );
    });

    it('does not sync server-selection settings keys to account settings payload', async () => {
        mocks.storageState.settings = {
            analyticsOptOut: false,
            featureToggles: { 'zen.navigation': false },
            serverSelectionGroups: [{ id: 'grp-dev', name: 'Dev', serverIds: ['server-a', 'server-b'], presentation: 'grouped' }],
            serverSelectionActiveTargetKind: 'group',
            serverSelectionActiveTargetId: 'grp-dev',
            terminalConnectLegacySecretExportEnabled: true,
        };
        mocks.storageState.settingsVersion = 10;

        mocks.serverFetch
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            )
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ settings: null, settingsVersion: 11 }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );
        (encryptionStub.encryptRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('ciphertext');
        const clearPendingSettings = vi.fn();

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: { featureToggles: { 'zen.navigation': true } },
            clearPendingSettings,
        });

        expect(clearPendingSettings).toHaveBeenCalledTimes(1);
        expect(encryptionStub.encryptRaw).not.toHaveBeenCalled();
        const body = JSON.parse(String((mocks.serverFetch.mock.calls[0]?.[1] as RequestInit | undefined)?.body ?? 'null')) as { settings?: unknown } | null;
        expect(typeof body?.settings).toBe('string');
        const opened = openAccountScopedBlobCiphertext({
            kind: 'account_settings',
            material: { type: 'dataKey', machineKey: TEST_MACHINE_KEY },
            ciphertext: String(body?.settings ?? ''),
        });
        expect(opened?.value && typeof opened.value === 'object').toBe(true);
        const record = opened?.value as Record<string, unknown>;
        expect(record.serverSelectionGroups).toBeUndefined();
        expect(record.serverSelectionActiveTargetKind).toBeUndefined();
        expect(record.serverSelectionActiveTargetId).toBeUndefined();
        expect(record.terminalConnectLegacySecretExportEnabled).toBeUndefined();
        expect(record.featureToggles).toEqual({ 'zen.navigation': true });
    });

    it('keeps local empty server-selection state when fetched server settings include legacy selection keys', async () => {
        mocks.storageState.settings = {
            analyticsOptOut: false,
            serverSelectionGroups: [],
            serverSelectionActiveTargetKind: null,
            serverSelectionActiveTargetId: null,
        };

        mocks.serverFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ settings: 'decryptable-ciphertext', settingsVersion: 8 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );
        (encryptionStub.decryptRaw as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
            analyticsOptOut: true,
            serverSelectionGroups: [{ id: 'legacy', name: 'Legacy', serverIds: ['server-a'] }],
            serverSelectionActiveTargetKind: 'group',
            serverSelectionActiveTargetId: 'legacy',
        });

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: {},
            clearPendingSettings: () => {},
        });

        expect(mocks.storageState.applySettings).toHaveBeenCalledWith(
            {
                analyticsOptOut: true,
                serverSelectionGroups: [],
                serverSelectionActiveTargetKind: null,
                serverSelectionActiveTargetId: null,
                terminalConnectLegacySecretExportEnabled: false,
            },
            8,
        );
    });

    it('clears pending settings when pending delta only contains local server-selection keys', async () => {
        mocks.serverFetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ settings: null, settingsVersion: 4 }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );
        const clearPendingSettings = vi.fn();

        await syncSettings({
            credentials,
            encryption: encryptionStub,
            pendingSettings: {
                serverSelectionGroups: [{ id: 'grp-dev', name: 'Dev', serverIds: ['server-a'] }],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'grp-dev',
            },
            clearPendingSettings,
        });

        expect(clearPendingSettings).toHaveBeenCalledTimes(1);
        expect(encryptionStub.encryptRaw).not.toHaveBeenCalled();
        expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
    });
});

describe('applySettingsLocalDelta server-selection local-only keys', () => {
    beforeEach(() => {
        mocks.storageState.settings = {
            analyticsOptOut: false,
            serverSelectionGroups: [],
            serverSelectionActiveTargetKind: null,
            serverSelectionActiveTargetId: null,
        };
        mocks.storageState.applySettingsLocal.mockReset();
    });

    it('applies local server-selection delta without adding pending sync keys', () => {
        const setPendingSettings = vi.fn();
        const schedulePendingSettingsFlush = vi.fn();

        applySettingsLocalDelta({
            delta: {
                serverSelectionGroups: [
                    { id: 'grp-dev', name: 'Dev', serverIds: ['server-a', 'server-b'], presentation: 'grouped' },
                ],
                serverSelectionActiveTargetKind: 'group',
                serverSelectionActiveTargetId: 'grp-dev',
            },
            settingsSecretsKey: null,
            getPendingSettings: () => ({}),
            setPendingSettings,
            schedulePendingSettingsFlush,
        });

        expect(mocks.storageState.applySettingsLocal).toHaveBeenCalledTimes(1);
        expect(setPendingSettings).not.toHaveBeenCalled();
        expect(schedulePendingSettingsFlush).not.toHaveBeenCalled();
    });

    it('applies local terminal-connect compatibility delta without adding pending sync keys', () => {
        const setPendingSettings = vi.fn();
        const schedulePendingSettingsFlush = vi.fn();

        applySettingsLocalDelta({
            delta: {
                terminalConnectLegacySecretExportEnabled: true,
            },
            settingsSecretsKey: null,
            getPendingSettings: () => ({}),
            setPendingSettings,
            schedulePendingSettingsFlush,
        });

        expect(mocks.storageState.applySettingsLocal).toHaveBeenCalledTimes(1);
        expect(setPendingSettings).not.toHaveBeenCalled();
        expect(schedulePendingSettingsFlush).not.toHaveBeenCalled();
    });
});
