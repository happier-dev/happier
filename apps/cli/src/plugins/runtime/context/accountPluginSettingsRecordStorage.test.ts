import { describe, expect, it, vi } from 'vitest';

import {
    openAccountScopedBlobCiphertext,
    PLUGIN_ACCOUNT_SETTINGS_ACCOUNT_SCOPED_BLOB_KIND_V1,
    type AccountScopedCryptoMaterial,
} from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import type { StablePluginSettingsModel } from '../invocation/services/settings';
import {
    createAccountPluginSettingsRecordStorage,
} from './accountPluginSettingsRecordStorage';

const model = {
    identity: { pluginId: 'example.tasks', qualifiedId: 'example.tasks/settings/account' },
    scope: 'account',
    descriptors: [],
    fields: [],
} as unknown as StablePluginSettingsModel;

const plainCredentials: StoredCredentials = {
    token: 'plain-token',
    encryption: null,
};

const e2eeMaterial: AccountScopedCryptoMaterial = {
    type: 'dataKey',
    machineKey: new Uint8Array(32).fill(7),
};

const e2eeCredentials: StoredCredentials = {
    token: 'e2ee-token',
    encryption: {
        type: 'dataKey',
        publicKey: new Uint8Array(32).fill(3),
        machineKey: e2eeMaterial.machineKey,
    },
};

describe('Account plugin Settings record storage', () => {
    it('fails closed when the Account encryption mode and returned record envelope disagree', async () => {
        const get = vi.fn(async (url: string) => {
            if (url.endsWith('/v1/account/encryption')) {
                return { status: 200, data: { mode: 'e2ee', updatedAt: 1 } };
            }
            if (url.includes('/v1/account/plugin-settings/')) {
                return {
                    status: 200,
                    data: {
                        status: 'present',
                        revision: 4,
                        content: { t: 'plain', v: { v: 1, values: { theme: 'must-not-disclose' } } },
                    },
                };
            }
            throw new Error(`Unexpected URL ${url}`);
        });
        const adapter = createAccountPluginSettingsRecordStorage({
            readCredentials: async () => e2eeCredentials,
            isCurrentAccount: () => true,
            http: { get, post: vi.fn() },
            resolveBaseUrl: () => 'https://server.example',
        });

        await expect(adapter.readRecord(model)).resolves.toEqual({ status: 'unavailable' });
        expect(get).toHaveBeenCalledWith(
            'https://server.example/v1/account/encryption',
            expect.any(Object),
        );
    });

    it('reads and writes the dedicated plaintext record route without consulting host preference roots', async () => {
        const get = vi.fn()
            .mockResolvedValueOnce({
                status: 200,
                data: {
                    status: 'present',
                    revision: 4,
                    content: { t: 'plain', v: { v: 1, values: { theme: 'dark' } } },
                },
            })
            .mockResolvedValueOnce({ status: 200, data: { mode: 'plain', updatedAt: 1 } })
            .mockResolvedValueOnce({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
        const post = vi.fn().mockResolvedValue({
            status: 200,
            data: { status: 'updated', revision: 5 },
        });
        const adapter = createAccountPluginSettingsRecordStorage({
            readCredentials: async () => plainCredentials,
            isCurrentAccount: () => true,
            http: { get, post },
            resolveBaseUrl: () => 'https://server.example',
        });

        await expect(adapter.readRecord(model)).resolves.toEqual({
            status: 'present',
            revision: 4,
            values: { theme: 'dark' },
        });
        await expect(adapter.writeRecord(model, {
            expectedRevision: 4,
            values: { theme: 'light' },
        })).resolves.toEqual({ status: 'updated', revision: 5 });

        expect(get).toHaveBeenNthCalledWith(1,
            'https://server.example/v1/account/plugin-settings/example.tasks',
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer plain-token' }),
            }),
        );
        expect(get).toHaveBeenNthCalledWith(2,
            'https://server.example/v1/account/encryption',
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer plain-token' }),
            }),
        );
        expect(get).toHaveBeenNthCalledWith(3,
            'https://server.example/v1/account/encryption',
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer plain-token' }),
            }),
        );
        expect(post).toHaveBeenCalledWith(
            'https://server.example/v1/account/plugin-settings/example.tasks',
            {
                expectedRevision: 4,
                content: { t: 'plain', v: { v: 1, values: { theme: 'light' } } },
            },
            expect.objectContaining({
                headers: expect.objectContaining({ Authorization: 'Bearer plain-token' }),
            }),
        );
    });

    it('seals Account E2EE values with the dedicated settings domain and fails closed without material', async () => {
        const get = vi.fn().mockResolvedValue({ status: 200, data: { mode: 'e2ee', updatedAt: 1 } });
        const post = vi.fn().mockResolvedValue({
            status: 200,
            data: { status: 'updated', revision: 1 },
        });
        const adapter = createAccountPluginSettingsRecordStorage({
            readCredentials: async () => e2eeCredentials,
            isCurrentAccount: () => true,
            http: { get, post },
            resolveBaseUrl: () => 'https://server.example',
            randomBytes: (length) => new Uint8Array(length).fill(9),
        });

        await expect(adapter.writeRecord(model, {
            expectedRevision: 'absent',
            values: { theme: 'dark' },
        })).resolves.toEqual({ status: 'updated', revision: 1 });

        const request = post.mock.calls[0]?.[1] as {
            content: { t: 'encrypted'; c: string };
        };
        expect(request.content.t).toBe('encrypted');
        expect(openAccountScopedBlobCiphertext({
            kind: PLUGIN_ACCOUNT_SETTINGS_ACCOUNT_SCOPED_BLOB_KIND_V1,
            material: e2eeMaterial,
            ciphertext: request.content.c,
        })?.value).toEqual({ v: 1, values: { theme: 'dark' } });

        const locked = createAccountPluginSettingsRecordStorage({
            readCredentials: async () => plainCredentials,
            isCurrentAccount: () => true,
            http: {
                get: vi.fn().mockResolvedValue({
                    status: 200,
                    data: {
                        status: 'present',
                        revision: 1,
                        content: { t: 'encrypted', c: request.content.c },
                    },
                }),
                post: vi.fn(),
            },
            resolveBaseUrl: () => 'https://server.example',
        });
        await expect(locked.readRecord(model)).resolves.toEqual({ status: 'unavailable' });
    });
});
