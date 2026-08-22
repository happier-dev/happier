import { describe, expect, it, vi } from 'vitest';
import {
    accountSettingsParse,
    normalizePluginAccountCollectionContractV1,
    type PluginAccountCollectionContributionV1,
} from '@happier-dev/protocol';
import type { PluginAccountCollectionDefinition } from '@happier-dev/plugin-sdk/collections';

import type { StoredCredentials } from '@/persistence';
import {
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';

import {
    createAccountPluginDataStorageHost,
    type PluginAccountCollectionWatchInvalidation,
} from './accountPluginDataStorage';
import { publishPluginAccountCollectionWatchInvalidation } from './pluginAccountSettingsChangeBroker';

const pluginId = 'example.collection-lifecycle';
const accountScopeKey = 'account-scope-collection-lifecycle';
const collectionDefinition = {
    id: 'rows',
    schemaVersion: 1,
    schema: {
        type: 'object',
        properties: {
            id: { type: 'string', maxLength: 256 },
            status: { type: 'string', maxLength: 256 },
        },
        required: ['id', 'status'],
        additionalProperties: false,
    },
    rowIdField: 'id',
    serverReadable: ['status'],
    indexes: [{
        id: 'by-status',
        fields: [{ field: 'status', direction: 'asc' as const }],
    }],
    uiQueries: [],
    relations: [],
    identityFields: [],
} satisfies PluginAccountCollectionDefinition;
const collectionContribution = {
    ...collectionDefinition,
    migrations: [],
} satisfies PluginAccountCollectionContributionV1;

const credentials = {
    token: 'account-token',
    encryption: null,
} satisfies StoredCredentials;

const resolvePlainAccountEncryptionCurrentness = async () => Object.freeze({
    mode: 'plain' as const,
    version: 1,
    signingKeyFingerprint: null,
    contentKeyFingerprint: null,
    updatedAt: 1,
});

describe('Account plugin Data collection watch lifecycle', () => {
    it('does not let a retired A binding become current again after A→B→A', async () => {
        const credentialsA = { token: 'account-a-token', encryption: null } satisfies StoredCredentials;
        const credentialsB = { token: 'account-b-token', encryption: null } satisfies StoredCredentials;
        const scopeA = resolveAccountSettingsScopeKey(credentialsA);
        const scopeB = resolveAccountSettingsScopeKey(credentialsB);
        const get = vi.fn(async () => ({ status: 200, data: { status: 'absent' } }));

        resetActiveAccountSettingsSnapshotForTests();
        try {
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 1,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                scopeKey: scopeA,
            });
            const host = createAccountPluginDataStorageHost({
                contracts: [],
                readCredentials: async () => credentialsA,
                resolveBaseUrl: () => 'https://data.example.test',
                resolveAccountEncryptionCurrentness: resolvePlainAccountEncryptionCurrentness,
                http: {
                    get,
                    post: async () => ({ status: 500, data: {} }),
                },
            });
            const account = host.bind({
                pluginId,
                generation: '1',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            });
            if (!account) throw new Error('Expected an Account A binding');

            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 1,
                loadedAtMs: 2,
                settingsSecretsReadKeys: [],
                scopeKey: scopeB,
            });
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 2,
                loadedAtMs: 3,
                settingsSecretsReadKeys: [],
                scopeKey: scopeA,
            });

            await expect(account.kv.get('cursor')).rejects.toMatchObject({
                code: 'plugin_account_storage_unavailable',
            });
            expect(get).not.toHaveBeenCalled();
        } finally {
            resetActiveAccountSettingsSnapshotForTests();
        }
    });

    it('keeps a bound Account A service usable when only its settings revision advances', async () => {
        const credentialsA = { token: 'account-a-token', encryption: null } satisfies StoredCredentials;
        const scopeA = resolveAccountSettingsScopeKey(credentialsA);
        const get = vi.fn(async () => ({ status: 200, data: { status: 'absent' } }));

        resetActiveAccountSettingsSnapshotForTests();
        try {
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 1,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                scopeKey: scopeA,
            });
            const host = createAccountPluginDataStorageHost({
                contracts: [],
                readCredentials: async () => credentialsA,
                resolveBaseUrl: () => 'https://data.example.test',
                resolveAccountEncryptionCurrentness: resolvePlainAccountEncryptionCurrentness,
                http: {
                    get,
                    post: async () => ({ status: 500, data: {} }),
                },
            });
            const account = host.bind({
                pluginId,
                generation: '1',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            });
            if (!account) throw new Error('Expected an Account A binding');

            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 2,
                loadedAtMs: 2,
                settingsSecretsReadKeys: [],
                scopeKey: scopeA,
            });

            await expect(account.kv.get('cursor')).resolves.toBeNull();
            expect(get).toHaveBeenCalledOnce();
        } finally {
            resetActiveAccountSettingsSnapshotForTests();
        }
    });

    it('disposes a retired A collection observer after Account A transitions through B and returns', () => {
        const credentialsA = { token: 'account-a-token', encryption: null } satisfies StoredCredentials;
        const credentialsB = { token: 'account-b-token', encryption: null } satisfies StoredCredentials;
        const scopeA = resolveAccountSettingsScopeKey(credentialsA);
        const scopeB = resolveAccountSettingsScopeKey(credentialsB);
        const upstreamSubscription: {
            listener: ((hint: PluginAccountCollectionWatchInvalidation) => void) | null;
        } = { listener: null };
        const unsubscribe = vi.fn();

        resetActiveAccountSettingsSnapshotForTests();
        try {
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 1,
                loadedAtMs: 1,
                settingsSecretsReadKeys: [],
                scopeKey: scopeA,
            });
            const host = createAccountPluginDataStorageHost({
                contracts: [normalizePluginAccountCollectionContractV1({
                    pluginId,
                    contribution: collectionContribution,
                })],
                readCredentials: async () => credentialsA,
                resolveBaseUrl: () => 'https://data.example.test',
                resolveAccountEncryptionCurrentness: resolvePlainAccountEncryptionCurrentness,
                http: {
                    get: async () => ({ status: 200, data: { status: 'absent' } }),
                    post: async () => ({ status: 500, data: {} }),
                },
                subscribeChanges(_subscription, listener) {
                    upstreamSubscription.listener = listener;
                    return unsubscribe;
                },
            });
            const account = host.bind({
                pluginId,
                generation: '1',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            });
            if (!account) throw new Error('Expected an Account A binding');
            const listener = vi.fn();
            const watcher = account.collection(collectionDefinition).watch({ kind: 'collection' }, listener);

            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 1,
                loadedAtMs: 2,
                settingsSecretsReadKeys: [],
                scopeKey: scopeB,
            });
            setActiveAccountSettingsSnapshot({
                source: 'network',
                settings: accountSettingsParse({}),
                settingsVersion: 2,
                loadedAtMs: 3,
                settingsSecretsReadKeys: [],
                scopeKey: scopeA,
            });

            const emitChange = upstreamSubscription.listener;
            if (!emitChange) throw new Error('Expected AccountChange subscription');
            emitChange({
                accountScopeKey: scopeA,
                kind: 'collection',
                pluginId,
                collectionId: collectionDefinition.id,
                contractDigest: normalizePluginAccountCollectionContractV1({
                    pluginId,
                    contribution: collectionContribution,
                }).contractDigest,
                changeCursor: 4,
            });

            expect(listener).not.toHaveBeenCalled();
            expect(unsubscribe).toHaveBeenCalledOnce();
            watcher.dispose();
        } finally {
            resetActiveAccountSettingsSnapshotForTests();
        }
    });

    it('releases its AccountChange listener when the bound generation is cancelled', () => {
        const upstreamSubscription: {
            listener: ((hint: PluginAccountCollectionWatchInvalidation) => void) | null;
        } = { listener: null };
        const unsubscribe = vi.fn();
        const controller = new AbortController();
        const host = createAccountPluginDataStorageHost({
            contracts: [normalizePluginAccountCollectionContractV1({
                pluginId,
                contribution: collectionContribution,
            })],
            readCredentials: async () => credentials,
            isCurrentAccount: () => true,
            resolveAccountScopeKey: () => accountScopeKey,
            resolveBaseUrl: () => 'https://data.example.test',
            resolveAccountEncryptionCurrentness: resolvePlainAccountEncryptionCurrentness,
            http: {
                get: async () => ({ status: 200, data: { mode: 'plain', updatedAt: 1 } }),
                post: async () => ({ status: 500, data: {} }),
            },
            subscribeChanges(_subscription, listener) {
                upstreamSubscription.listener = listener;
                return unsubscribe;
            },
        });
        const account = host.bind({
            pluginId,
            generation: '1',
            signal: controller.signal,
            isGenerationCurrent: () => true,
        });
        if (!account) throw new Error('Expected an Account Data binding');
        const listener = vi.fn();

        account.collection(collectionDefinition).watch({ kind: 'collection' }, listener);
        controller.abort();

        expect(unsubscribe).toHaveBeenCalledOnce();
        const emitChange = upstreamSubscription.listener;
        if (!emitChange) throw new Error('Expected AccountChange subscription');
        emitChange({
            accountScopeKey,
            kind: 'collection',
            pluginId,
            collectionId: collectionDefinition.id,
            contractDigest: normalizePluginAccountCollectionContractV1({
                pluginId,
                contribution: collectionContribution,
            }).contractDigest,
            changeCursor: 4,
        });
        expect(listener).not.toHaveBeenCalled();
    });

    it('catches up a change published between an initial query and watch registration', async () => {
        const initialCursor = 4_000_000;
        const host = createAccountPluginDataStorageHost({
            contracts: [normalizePluginAccountCollectionContractV1({
                pluginId,
                contribution: collectionContribution,
            })],
            readCredentials: async () => credentials,
            isCurrentAccount: () => true,
            resolveAccountScopeKey: () => accountScopeKey,
            resolveBaseUrl: () => 'https://data.example.test',
            resolveAccountEncryptionCurrentness: resolvePlainAccountEncryptionCurrentness,
            http: {
                get: async () => ({ status: 200, data: { mode: 'plain', updatedAt: 1 } }),
                post: async () => ({
                    status: 200,
                    data: { rows: [], changeCursor: initialCursor },
                }),
            },
        });
        const account = host.bind({
            pluginId,
            generation: '1',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        if (!account) throw new Error('Expected an Account Data binding');
        const collection = account.collection(collectionDefinition);

        await expect(collection.query({ index: 'by-status', prefix: ['open'], order: 'asc' }))
            .resolves.toMatchObject({ changeCursor: initialCursor });
        publishPluginAccountCollectionWatchInvalidation({
            accountScopeKey,
            kind: 'collection',
            pluginId,
            collectionId: collectionDefinition.id,
            contractDigest: normalizePluginAccountCollectionContractV1({
                pluginId,
                contribution: collectionContribution,
            }).contractDigest,
            changeCursor: initialCursor + 1,
        });

        const listener = vi.fn();
        const watcher = collection.watch({ kind: 'collection' }, listener);
        try {
            await Promise.resolve();
            expect(listener).toHaveBeenCalledExactlyOnceWith({
                kind: 'changed',
                changeCursor: initialCursor + 1,
            });
        } finally {
            watcher.dispose();
        }
    });
});
