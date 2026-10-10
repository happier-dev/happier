import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    openAccountScopedBlobCiphertext,
    accountSettingsParse,
    PLUGIN_ACCOUNT_SETTINGS_ACCOUNT_SCOPED_BLOB_KIND_V1,
    sealAccountScopedBlobCiphertext,
    type AccountScopedCryptoMaterial,
} from '@happier-dev/protocol';

import type { StoredCredentials } from '@/persistence';
import {
    clearActiveAccountSettingsSnapshot,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
    createAccountSettingsBackedSettingsRecordStore,
    createStablePluginSettingsModel,
    parseCanonicalPluginSettingsRecord,
    type StablePluginSettingsModel,
} from '../invocation/services/settings';
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

const settingsModel = createStablePluginSettingsModel({ pluginId: 'example.tasks', contribution: {
    id: 'preferences', version: 1, title: 'Preferences', target: { kind: 'plugin' }, scope: 'account',
    fields: [{ id: 'theme', title: 'Theme', schema: { type: 'string' } }],
    presentation: { sections: [], subagentSections: [] },
} });

describe('Account plugin Settings record storage', () => {
    afterEach(() => clearActiveAccountSettingsSnapshot());

    it('accepts successful record reads and writes after fifteen seconds', async () => {
        vi.useFakeTimers();
        try {
            const delayed = (data: unknown, config: Readonly<Record<string, unknown>>) => new Promise<{ status: number; data: unknown }>((resolve, reject) => {
                // HTTP is the genuine external boundary; emulate its configured deadline.
                const timeout = typeof config.timeout === 'number' && config.timeout > 0
                    ? setTimeout(() => reject(new Error('HTTP deadline elapsed')), config.timeout) : undefined;
                setTimeout(() => { clearTimeout(timeout); resolve({ status: 200, data }); }, 16_000);
            });
            const adapter = createAccountPluginSettingsRecordStorage({
                readCredentials: async () => plainCredentials, isCurrentAccount: () => true,
                resolveBaseUrl: () => 'https://server.example',
                http: {
                    get: async (url, config) => url.endsWith('/encryption')
                        ? { status: 200, data: { mode: 'plain', updatedAt: 1 } }
                        : delayed({ status: 'present', revision: 4, content: { t: 'plain', v: { v: 1, values: { theme: 'dark' } } } }, config),
                    post: async (_url, _body, config) => delayed({ status: 'updated', revision: 5 }, config),
                },
            });
            const access = await adapter.bindOperation();
            const read = access.readRecord(model);
            await vi.advanceTimersByTimeAsync(16_000);
            expect(await read).toMatchObject({ status: 'present', revision: 4 });
            const write = access.writeRecord(model, { expectedRevision: 4, values: { theme: 'light' } });
            await vi.advanceTimersByTimeAsync(16_000);
            expect(await write).toEqual({ status: 'updated', revision: 5 });
        } finally { vi.useRealTimers(); }
    });

    it.each(['plain', 'e2ee'] as const)('never retargets a %s logical update after its initial Account read', async (mode) => {
        const accountA = mode === 'plain' ? plainCredentials : e2eeCredentials;
        const accountB: StoredCredentials = mode === 'plain'
            ? { token: 'account-b', encryption: null }
            : { ...e2eeCredentials, token: 'account-b', encryption: {
                type: 'dataKey', publicKey: new Uint8Array(32).fill(4), machineKey: new Uint8Array(32).fill(8),
            } };
        let current = accountA;
        const values = { v: 1, values: { theme: 'dark', opaque: 'Account A private value' } };
        const post = vi.fn(async () => ({ status: 200, data: { status: 'updated', revision: 5 } }));
        const adapter = createAccountPluginSettingsRecordStorage({
            readCredentials: async () => current,
            isCurrentAccount: (credentials) => credentials === current,
            resolveBaseUrl: () => 'https://server.example',
            http: {
                get: async (url) => url.endsWith('/encryption')
                    ? { status: 200, data: { mode, updatedAt: 1 } }
                    : { status: 200, data: { status: 'present', revision: 4, content: mode === 'plain'
                        ? { t: 'plain', v: values }
                        : { t: 'encrypted', c: sealAccountScopedBlobCiphertext({
                            kind: PLUGIN_ACCOUNT_SETTINGS_ACCOUNT_SCOPED_BLOB_KIND_V1,
                            material: e2eeMaterial, payload: values, randomBytes: (size) => new Uint8Array(size).fill(9),
                        }) } } },
                post,
            },
        });
        const store = createAccountSettingsBackedSettingsRecordStore(adapter);
        let calls = 0;
        await expect(store.update(settingsModel, (raw) => {
            const record = parseCanonicalPluginSettingsRecord(raw);
            calls += 1;
            expect(record.values.opaque).toBe('Account A private value');
            current = accountB;
            return { record: { ...record, revision: 5, values: { ...record.values, theme: 'light' } }, result: 'updated' };
        })).rejects.toMatchObject({ code: 'plugin_settings_persistence_unavailable' });
        expect(calls).toBe(1);
        expect(post).not.toHaveBeenCalled();
    });

    it.each(['outcomeUnknown', 'conflict', 'cancelledSameAccount'] as const)(
        'reconciles %s only inside the submitting Account', async (outcome) => {
            const controller = new AbortController();
            let current = plainCredentials;
            let posted = false;
            const get = vi.fn(async (url: string, config: Readonly<Record<string, unknown>>) => {
                expect(config.headers).toMatchObject({ Authorization: 'Bearer plain-token' });
                if (posted) expect(config.signal).toBeUndefined();
                return url.endsWith('/encryption')
                    ? { status: 200, data: { mode: 'plain', updatedAt: 1 } }
                    : { status: 200, data: { status: 'present', revision: posted ? 5 : 4,
                        content: { t: 'plain', v: { v: 1, values: { theme: posted ? 'light' : 'dark' } } } } };
            });
            const adapter = createAccountPluginSettingsRecordStorage({
                readCredentials: async () => current,
                isCurrentAccount: (credentials) => credentials === current,
                resolveBaseUrl: () => 'https://server.example',
                http: { get, post: async () => {
                    posted = true;
                    if (outcome === 'cancelledSameAccount') controller.abort();
                    else current = { token: 'account-b', encryption: null };
                    if (outcome === 'conflict') return { status: 200, data: { status: 'conflict', revision: 5 } };
                    throw new Error('response_lost');
                } },
            });
            const settle = vi.fn((record: { values: Readonly<Record<string, unknown>> }) => (
                record.values.theme === 'light' ? 'satisfied' : undefined
            ));
            const result = createAccountSettingsBackedSettingsRecordStore(adapter).update(settingsModel, (raw) => ({
                record: { ...parseCanonicalPluginSettingsRecord(raw), revision: 5, values: { theme: 'light' } },
                result: 'updated',
            }), { signal: controller.signal, settleConflict: settle, settleOutcomeUnknown: settle });
            if (outcome === 'cancelledSameAccount') {
                await expect(result).resolves.toBe('satisfied');
                expect(settle).toHaveBeenCalledOnce();
            } else {
                await expect(result).rejects.toMatchObject({ code: outcome === 'conflict'
                    ? 'plugin_settings_revision_conflict' : 'plugin_settings_outcome_unknown' });
                expect(settle).not.toHaveBeenCalled();
                // Initial record, read-mode, and write-mode requests only. No
                // replacement Account read can falsely satisfy A's mutation.
                expect(get).toHaveBeenCalledTimes(3);
            }
        },
    );

    it.each(['beforeRead', 'duringRead'] as const)('rejects a retired A→B→A lifetime %s', async (phase) => {
        const select = (scopeKey: string) => setActiveAccountSettingsSnapshot({
            source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
            loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey,
        });
        const reselect = () => { select('account-b'); select('account-a'); };
        select('account-a');
        const get = vi.fn(async () => {
            if (phase === 'duringRead') reselect();
            return { status: 200, data: { status: 'present', revision: 4,
                content: { t: 'plain', v: { v: 1, values: { theme: 'private' } } } } };
        });
        const post = vi.fn();
        const adapter = createAccountPluginSettingsRecordStorage({
            readCredentials: async () => plainCredentials, isCurrentAccount: () => true,
            resolveBaseUrl: () => 'https://server.example', http: { get, post },
        });
        const access = await adapter.bindOperation();
        if (phase === 'beforeRead') reselect();
        await expect(access.readRecord(settingsModel)).resolves.toEqual({ status: 'unavailable' });
        await expect(access.writeRecord(settingsModel, { expectedRevision: 4, values: { theme: 'light' } }))
            .resolves.toEqual({ status: 'unavailable' });
        expect(get).toHaveBeenCalledTimes(phase === 'beforeRead' ? 0 : 1);
        expect(post).not.toHaveBeenCalled();
    });

    it('does not send captured credentials to a newly selected server', async () => {
        let baseUrl = 'https://server-a.example';
        const get = vi.fn();
        const post = vi.fn();
        const adapter = createAccountPluginSettingsRecordStorage({
            readCredentials: async () => plainCredentials, isCurrentAccount: () => true,
            resolveBaseUrl: () => baseUrl, http: { get, post },
        });
        const access = await adapter.bindOperation();
        baseUrl = 'https://server-b.example';
        await expect(access.readRecord(settingsModel)).resolves.toEqual({ status: 'unavailable' });
        await expect(access.writeRecord(settingsModel, { expectedRevision: 4, values: { theme: 'light' } }))
            .resolves.toEqual({ status: 'unavailable' });
        expect(get).not.toHaveBeenCalled();
        expect(post).not.toHaveBeenCalled();
    });

    it('keeps a watch baseline and later refreshes inside their original Account', async () => {
        let current = plainCredentials;
        let hint: (() => void) | undefined;
        const get = vi.fn(async (url: string) => url.endsWith('/encryption')
            ? { status: 200, data: { mode: 'plain', updatedAt: 1 } }
            : { status: 200, data: { status: 'present', revision: 4,
                content: { t: 'plain', v: { v: 1, values: { theme: current.token } } } } });
        const adapter = createAccountPluginSettingsRecordStorage({
            readCredentials: async () => current,
            isCurrentAccount: (credentials) => credentials === current,
            resolveBaseUrl: () => 'https://server.example',
            http: { get, post: vi.fn() },
            subscribeChanges: (listener) => {
                hint = () => listener({ kind: 'full' });
                return () => { hint = undefined; };
            },
        });
        const changes: unknown[] = [];
        const watch = createAccountSettingsBackedSettingsRecordStore(adapter).watch?.(
            settingsModel, (change) => changes.push(change),
        );
        try {
            await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2));
            current = { token: 'account-b', encryption: null };
            hint?.();
            // The refresh uses only fulfilled in-process promises when retired.
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(get).toHaveBeenCalledTimes(2);
            expect(changes).toEqual([]);
        } finally {
            await watch?.dispose();
        }
    });

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

        await expect((await adapter.bindOperation()).readRecord(model)).resolves.toEqual({ status: 'unavailable' });
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

        await expect((await adapter.bindOperation()).readRecord(model)).resolves.toEqual({
            status: 'present',
            revision: 4,
            values: { theme: 'dark' },
        });
        await expect((await adapter.bindOperation()).writeRecord(model, {
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

    it('distinguishes a proved no-effect response from an ambiguous post-submission outcome', async () => {
        const get = vi.fn().mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
        const post = vi.fn()
            .mockResolvedValueOnce({ status: 200, data: { unexpected: true } })
            .mockResolvedValueOnce({
                status: 503,
                data: { error: 'plugin_account_settings_storage_unavailable' },
            })
            .mockRejectedValueOnce(new Error('response_lost'));
        const adapter = createAccountPluginSettingsRecordStorage({
            readCredentials: async () => plainCredentials,
            isCurrentAccount: () => true,
            http: { get, post },
            resolveBaseUrl: () => 'https://server.example',
        });
        const request = {
            expectedRevision: 4 as const,
            values: { theme: 'light' },
        };

        await expect((await adapter.bindOperation()).writeRecord(model, request)).resolves.toEqual({ status: 'outcomeUnknown' });
        await expect((await adapter.bindOperation()).writeRecord(model, request)).resolves.toEqual({ status: 'unavailable' });
        await expect((await adapter.bindOperation()).writeRecord(model, request)).resolves.toEqual({ status: 'outcomeUnknown' });
    });

    it('does not accept a success-shaped mutation body from a non-success HTTP status', async () => {
        const get = vi.fn().mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
        const post = vi.fn().mockResolvedValue({
            status: 409,
            data: { status: 'updated', revision: 5 },
        });
        const adapter = createAccountPluginSettingsRecordStorage({
            readCredentials: async () => plainCredentials,
            isCurrentAccount: () => true,
            http: { get, post },
            resolveBaseUrl: () => 'https://server.example',
        });

        await expect((await adapter.bindOperation()).writeRecord(model, {
            expectedRevision: 4,
            values: { theme: 'light' },
        })).resolves.toEqual({ status: 'outcomeUnknown' });
    });

    it('accepts an exact applied response after caller cancellation begins post-submit', async () => {
        const controller = new AbortController();
        const get = vi.fn().mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
        const post = vi.fn(async () => {
            controller.abort(new Error('caller retired after issue'));
            return { status: 200, data: { status: 'updated', revision: 5 } };
        });
        const adapter = createAccountPluginSettingsRecordStorage({
            readCredentials: async () => plainCredentials,
            isCurrentAccount: () => true,
            http: { get, post },
            resolveBaseUrl: () => 'https://server.example',
        });

        await expect((await adapter.bindOperation()).writeRecord(model, {
            expectedRevision: 4,
            values: { theme: 'light' },
        }, { signal: controller.signal })).resolves.toEqual({ status: 'updated', revision: 5 });
    });

    it('accepts an exact applied response after the active Account changes post-submit', async () => {
        let current = true;
        const get = vi.fn().mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
        const post = vi.fn(async () => {
            current = false;
            return { status: 200, data: { status: 'updated', revision: 5 } };
        });
        const adapter = createAccountPluginSettingsRecordStorage({
            readCredentials: async () => plainCredentials,
            isCurrentAccount: () => current,
            http: { get, post },
            resolveBaseUrl: () => 'https://server.example',
        });

        await expect((await adapter.bindOperation()).writeRecord(model, {
            expectedRevision: 4,
            values: { theme: 'light' },
        })).resolves.toEqual({ status: 'updated', revision: 5 });
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

        await expect((await adapter.bindOperation()).writeRecord(model, {
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
        await expect((await locked.bindOperation()).readRecord(model)).resolves.toEqual({ status: 'unavailable' });
    });
});
