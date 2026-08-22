import { createHash } from 'node:crypto';

import { PluginError, type Disposable } from '@happier-dev/plugin-sdk';
import type { PluginAccountStorageScope } from '@happier-dev/plugin-sdk/storage';
import { accountSettingsParse, type PluginResourceContextV1 } from '@happier-dev/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedContributionRegistry, ResolvedResourceContribution } from '@/plugins/projection/registry/types';
import { createAccountPluginDataStorageHost } from '@/plugins/runtime/context/accountPluginDataStorage';
import { createPluginResourceAccountStorageResolver } from '@/plugins/runtime/hostAccess/resolve';
import {
    resetActiveAccountSettingsSnapshotForTests,
    setActiveAccountSettingsSnapshot,
} from '@/settings/accountSettings/activeAccountSettingsSnapshot';

import {
    MAX_PLUGIN_RESOURCE_AGGREGATE_BYTES,
    MAX_PLUGIN_RESOURCE_BYTES,
    MAX_PLUGIN_RESOURCES_PER_GENERATION,
    createStablePluginResourcesOwner,
    type StableDynamicPluginResourceProducer,
    type StablePluginResourcesOwner,
} from './resources';

/**
 * Producer-side observation semantics for the dynamic arm of the resource
 * family (EU-4b §3.6.1). These are the facts a daemon→app invalidation
 * transport will faithfully propagate, so they are proven at the producer
 * owner before any transport consumes them.
 */

function digest(bytes: Uint8Array): `sha256:${string}` {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function dynamicContribution(
    pluginId: string,
    localId: string,
    scope: 'global' | 'session' | 'surface' = 'global',
    hostAccess?: readonly string[],
): ResolvedResourceContribution {
    return {
        provenance: 'external',
        source: { kind: 'archive' },
        pluginId,
        pluginRootPath: '/tmp/does-not-matter',
        manifestPath: '/tmp/does-not-matter/.happier-plugin/plugin.json',
        daemonEntryPath: null,
        sourceSpec: {
            kind: 'archive', locator: `${pluginId}.tgz`, trustPolicy: 'prompt', installPolicy: 'copy',
        },
        definition: {
            kindVersion: 1,
            id: localId,
            type: 'config',
            source: 'dynamic',
            contentType: 'application/json',
            ...(scope === 'global' ? {} : { scope }),
            ...(hostAccess === undefined ? {} : { hostAccess }),
        },
    };
}

function registry(
    resources: readonly ResolvedResourceContribution[],
): Pick<ResolvedContributionRegistry, 'resources'> {
    return { resources };
}

const DYNAMIC_GENERATION = 'immutable-alpha-dynamic';
const resolvePlainAccountEncryptionCurrentness = async () => Object.freeze({
    mode: 'plain' as const,
    version: 1,
    signingKeyFingerprint: null,
    contentKeyFingerprint: null,
    updatedAt: 1,
});
// r0.22 extends the incumbent per-generation Resource bound into the one
// owner-local aggregate cap for active exact Resource/Session contexts.
const ACTIVE_CONTEXT_LIMIT = MAX_PLUGIN_RESOURCES_PER_GENERATION;

function dynamicGenerationIds(): ReadonlyMap<string, string> {
    return new Map([['acme.alpha', DYNAMIC_GENERATION]]);
}

function accountStorageFixture(): PluginAccountStorageScope {
    // Dynamic Resource tests treat Account storage as an opaque host boundary.
    // They verify identity/lifetime propagation without inventing an Account
    // storage implementation or unavailable fallback surface.
    return Object.freeze({}) as unknown as PluginAccountStorageScope;
}

function establishSessionAccessWitness(
    owner: StablePluginResourcesOwner,
    params: Readonly<{
        accountId?: string;
        throughCursor?: number;
        entries?: readonly Readonly<{
            sessionId: string;
            cursor: number;
            status: 'available' | 'unavailable';
        }>[];
    }> = {},
): void {
    owner.applySessionAccessWitness({
        accountId: params.accountId ?? 'account-a',
        witness: {
            v: 1,
            throughCursor: params.throughCursor ?? 1,
            entries: params.entries ? [...params.entries] : [],
        },
    });
}

const allowSessionResourceAccess = async (params: Readonly<{
    accountId: string;
    sessionId: string;
    signal: AbortSignal;
}>) => {
    void params.sessionId;
    void params.signal;
    return {
        accountId: params.accountId,
        throughCursor: 1_000_000,
        status: 'available' as const,
    };
};

async function bindSessionResource(
    owner: StablePluginResourcesOwner,
    params: Readonly<{
        resourceId: string;
        sessionId: string;
        pluginId?: string;
    }>,
) {
    return await owner.bindForResource({
        pluginId: params.pluginId ?? 'acme.alpha',
        resourceId: params.resourceId,
        signal: new AbortController().signal,
        isGenerationCurrent: () => true,
        context: { kind: 'session', sessionId: params.sessionId },
    });
}

async function settle(): Promise<void> {
    await new Promise((resolve) => { setTimeout(resolve, 5); });
}

afterEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
});

function deferred<T>(): Readonly<{
    promise: Promise<T>;
    resolve(value: T): void;
    reject(reason?: unknown): void;
}> {
    let resolvePromise!: (value: T) => void;
    let rejectPromise!: (reason?: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return Object.freeze({
        promise,
        resolve: (value: T) => { resolvePromise(value); },
        reject: (reason?: unknown) => { rejectPromise(reason); },
    });
}

describe('dynamic Resource HostAccess callback binding (SDK-RESOURCE-01)', () => {
    it('expires real Account storage captured from each completed admission or read callback', async () => {
        const httpGet = vi.fn(async () => ({
            status: 200,
            data: { mode: 'plain' as const, updatedAt: 1 },
        }));
        const httpPost = vi.fn(async () => ({ status: 500, data: {} }));
        const readCredentials = vi.fn(async () => ({ token: 'account-token', encryption: null }));
        const accountStorageHost = createAccountPluginDataStorageHost({
            contracts: [],
            readCredentials,
            isCurrentAccount: () => true,
            resolveAccountScopeKey: () => 'account-scope',
            resolveBaseUrl: () => 'https://data.example.test',
            resolveAccountEncryptionCurrentness: resolvePlainAccountEncryptionCurrentness,
            http: { get: httpGet, post: httpPost },
        });
        const capturedScopes: PluginAccountStorageScope[] = [];
        const owner = await createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'live', 'global', ['account-storage']),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            bindDynamicResourceAccountStorage: createPluginResourceAccountStorageResolver({
                accountStorage: accountStorageHost,
            }),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                hostAccessRequests: [{
                    required: true,
                    request: {
                        id: 'account-storage',
                        capability: 'storage.account',
                        reason: 'Read Account-scoped Resource state',
                        scope: { enabled: true },
                    },
                }],
                runtime: {
                    read: (options) => {
                        capturedScopes.push(options.accountStorage!);
                        return new Uint8Array(Buffer.from('current'));
                    },
                    observe: () => ({ dispose: () => undefined }),
                },
            }],
        });

        expect(capturedScopes).toHaveLength(1);
        await expect(capturedScopes[0]!.kv.get('after-admission')).rejects.toMatchObject({
            code: 'plugin_collection_cancelled',
        });

        const service = owner.bind({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        await service.read('live');
        expect(capturedScopes).toHaveLength(2);
        await expect(capturedScopes[1]!.kv.get('after-read')).rejects.toMatchObject({
            code: 'plugin_collection_cancelled',
        });
        expect(readCredentials).not.toHaveBeenCalled();
        expect(httpGet).not.toHaveBeenCalled();
        expect(httpPost).not.toHaveBeenCalled();
    });

    it('expires each completed watch-settlement read scope without retiring the live observe scope', async () => {
        // A Resource watch owns its `observe` callback until the shared watch
        // closes, but every settlement is a separate `read` invocation. Reusing
        // the observe lifetime for that read would let a producer retain an
        // Account leaf after its settlement completed.
        const httpGet = vi.fn(async (url: string) => (
            url.endsWith('/v1/account/encryption')
                ? { status: 200, data: { mode: 'plain' as const, updatedAt: 1 } }
                : { status: 200, data: { status: 'absent' as const } }
        ));
        const accountStorageHost = createAccountPluginDataStorageHost({
            contracts: [],
            readCredentials: async () => ({ token: 'account-token', encryption: null }),
            isCurrentAccount: () => true,
            resolveAccountScopeKey: () => 'account-scope',
            resolveBaseUrl: () => 'https://data.example.test',
            resolveAccountEncryptionCurrentness: resolvePlainAccountEncryptionCurrentness,
            http: {
                get: httpGet,
                post: async () => ({ status: 500, data: {} }),
            },
        });
        const readScopes: PluginAccountStorageScope[] = [];
        const observeScopes: PluginAccountStorageScope[] = [];
        const owner = await createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'live', 'global', ['account-storage']),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            bindDynamicResourceAccountStorage: createPluginResourceAccountStorageResolver({
                accountStorage: accountStorageHost,
            }),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                hostAccessRequests: [{
                    required: true,
                    request: {
                        id: 'account-storage',
                        capability: 'storage.account',
                        reason: 'Read Account-scoped Resource state',
                        scope: { enabled: true },
                    },
                }],
                runtime: {
                    read: (options) => {
                        readScopes.push(options.accountStorage!);
                        return new Uint8Array(Buffer.from('current'));
                    },
                    observe: (_invalidate, options) => {
                        observeScopes.push(options.accountStorage!);
                        return { dispose: () => undefined };
                    },
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const subscription = service.watch('live', () => undefined);
        try {
            await settle();
            expect(readScopes).toHaveLength(2); // admission + watch settlement
            expect(observeScopes).toHaveLength(1);

            await expect(readScopes[1]!.kv.get('after-settlement')).rejects.toMatchObject({
                code: 'plugin_collection_cancelled',
            });
            // Negative control: resolving the settlement lifetime by aborting
            // the producer callback would break the still-owned shared watch.
            await expect(observeScopes[0]!.kv.get('while-observing')).resolves.toBeNull();
        } finally {
            subscription.dispose();
        }
    });

    it('does not bind Account storage or invoke a globally stale producer during admission', async () => {
        const bindAccountStorage = vi.fn();
        const read = vi.fn(() => new Uint8Array(Buffer.from('must-not-run')));

        await expect(createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'live', 'global', ['account-storage']),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            isCommittedGenerationCurrent: async () => false,
            bindDynamicResourceAccountStorage: bindAccountStorage,
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                hostAccessRequests: [{
                    required: true,
                    request: {
                        id: 'account-storage',
                        capability: 'storage.account',
                        reason: 'Persist Account-scoped Resource state',
                        scope: { enabled: true },
                    },
                }],
                runtime: {
                    read,
                    observe: () => ({ dispose: () => undefined }),
                },
            }],
        })).rejects.toMatchObject({ code: 'plugin_generation_stale' });
        expect(bindAccountStorage).not.toHaveBeenCalled();
        expect(read).not.toHaveBeenCalled();
    });

    it('rejects late global admission bytes when committed generation currentness changes', async () => {
        const lateRead = deferred<Uint8Array>();
        let committedGenerationCurrent = true;
        let boundCurrent: (() => boolean | Promise<boolean>) | undefined;
        const bindAccountStorage = vi.fn((input: Parameters<NonNullable<Parameters<typeof createStablePluginResourcesOwner>[0]['bindDynamicResourceAccountStorage']>>[0]) => {
            boundCurrent = input.isGenerationCurrent;
            return Object.freeze({ marker: 'account-storage' }) as unknown as PluginAccountStorageScope;
        });
        const read = vi.fn(() => lateRead.promise);

        const pendingOwner = createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'live', 'global', ['account-storage']),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            isCommittedGenerationCurrent: async () => committedGenerationCurrent,
            bindDynamicResourceAccountStorage: bindAccountStorage,
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                hostAccessRequests: [{
                    required: true,
                    request: {
                        id: 'account-storage',
                        capability: 'storage.account',
                        reason: 'Persist Account-scoped Resource state',
                        scope: { enabled: true },
                    },
                }],
                runtime: {
                    read,
                    observe: () => ({ dispose: () => undefined }),
                },
            }],
        });
        await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
        committedGenerationCurrent = false;
        lateRead.resolve(new Uint8Array(Buffer.from('late')));

        await expect(pendingOwner).rejects.toMatchObject({ code: 'plugin_generation_stale' });
        expect(await boundCurrent?.()).toBe(false);
    });

    it('does not let a held global admission callback mutate Account storage after committed authority flips', async () => {
        // A post-read currentness fence alone is too late: the Resource
        // callback can retain its Account leaf and use it just before that
        // fence runs. This must fail against the real Account host, rather
        // than a Resource-local wrapper that only protects output bytes.
        const callbackStarted = deferred<void>();
        const releaseCallback = deferred<void>();
        let committedGenerationCurrent = true;
        const accountMutation = vi.fn(async () => ({
            status: 200,
            data: { status: 'updated' as const, revision: 1 },
        }));
        const accountStorageHost = createAccountPluginDataStorageHost({
            contracts: [],
            readCredentials: async () => ({ token: 'account-token', encryption: null }),
            isCurrentAccount: () => true,
            resolveAccountScopeKey: () => 'account-scope',
            resolveBaseUrl: () => 'https://data.example.test',
            resolveAccountEncryptionCurrentness: resolvePlainAccountEncryptionCurrentness,
            http: {
                get: async (url) => (
                    url.endsWith('/v1/account/encryption')
                        ? { status: 200, data: { mode: 'plain' as const, updatedAt: 1 } }
                        : { status: 200, data: { status: 'absent' as const } }
                ),
                post: accountMutation,
            },
        });
        const pendingOwner = createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'live', 'global', ['account-storage']),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            isCommittedGenerationCurrent: async () => committedGenerationCurrent,
            bindDynamicResourceAccountStorage: createPluginResourceAccountStorageResolver({
                accountStorage: accountStorageHost,
            }),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                hostAccessRequests: [{
                    required: true,
                    request: {
                        id: 'account-storage',
                        capability: 'storage.account',
                        reason: 'Persist Account-scoped Resource state',
                        scope: { enabled: true },
                    },
                }],
                runtime: {
                    read: async (options) => {
                        callbackStarted.resolve(undefined);
                        await releaseCallback.promise;
                        await options.accountStorage!.kv.set('resource-state', { saved: true }, {
                            expectedVersion: 'absent',
                        });
                        return new Uint8Array(Buffer.from('late'));
                    },
                    observe: () => ({ dispose: () => undefined }),
                },
            }],
        });

        await callbackStarted.promise;
        committedGenerationCurrent = false;
        releaseCallback.resolve(undefined);

        await expect(pendingOwner).rejects.toMatchObject({ code: 'plugin_generation_stale' });
        expect(accountMutation).not.toHaveBeenCalled();
    });

    it('does not let a held direct Resource read callback mutate Account storage after committed authority flips', async () => {
        const callbackStarted = deferred<void>();
        const releaseCallback = deferred<void>();
        let committedGenerationCurrent = true;
        let reads = 0;
        const accountMutation = vi.fn(async () => ({
            status: 200,
            data: { status: 'updated' as const, revision: 1 },
        }));
        const accountStorageHost = createAccountPluginDataStorageHost({
            contracts: [],
            readCredentials: async () => ({ token: 'account-token', encryption: null }),
            isCurrentAccount: () => true,
            resolveAccountScopeKey: () => 'account-scope',
            resolveBaseUrl: () => 'https://data.example.test',
            resolveAccountEncryptionCurrentness: resolvePlainAccountEncryptionCurrentness,
            http: {
                get: async (url) => (
                    url.endsWith('/v1/account/encryption')
                        ? { status: 200, data: { mode: 'plain' as const, updatedAt: 1 } }
                        : { status: 200, data: { status: 'absent' as const } }
                ),
                post: accountMutation,
            },
        });
        const owner = await createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'live', 'global', ['account-storage']),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            isCommittedGenerationCurrent: async () => committedGenerationCurrent,
            bindDynamicResourceAccountStorage: createPluginResourceAccountStorageResolver({
                accountStorage: accountStorageHost,
            }),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                hostAccessRequests: [{
                    required: true,
                    request: {
                        id: 'account-storage',
                        capability: 'storage.account',
                        reason: 'Persist Account-scoped Resource state',
                        scope: { enabled: true },
                    },
                }],
                runtime: {
                    read: async (options) => {
                        reads += 1;
                        if (reads === 1) return new Uint8Array(Buffer.from('admission'));
                        callbackStarted.resolve(undefined);
                        await releaseCallback.promise;
                        await options.accountStorage!.kv.set('resource-state', { saved: true }, {
                            expectedVersion: 'absent',
                        });
                        return new Uint8Array(Buffer.from('direct-read'));
                    },
                    observe: () => ({ dispose: () => undefined }),
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });

        const pendingRead = service.read('live');
        await callbackStarted.promise;
        committedGenerationCurrent = false;
        releaseCallback.resolve(undefined);

        await expect(pendingRead).rejects.toMatchObject({ code: 'plugin_generation_stale' });
        expect(accountMutation).not.toHaveBeenCalled();
    });

    it('does not let a retained Resource observation callback mutate Account storage after committed authority flips', async () => {
        let committedGenerationCurrent = true;
        let observedAccountStorage: PluginAccountStorageScope | undefined;
        const accountMutation = vi.fn(async () => ({
            status: 200,
            data: { status: 'updated' as const, revision: 1 },
        }));
        const accountStorageHost = createAccountPluginDataStorageHost({
            contracts: [],
            readCredentials: async () => ({ token: 'account-token', encryption: null }),
            isCurrentAccount: () => true,
            resolveAccountScopeKey: () => 'account-scope',
            resolveBaseUrl: () => 'https://data.example.test',
            resolveAccountEncryptionCurrentness: resolvePlainAccountEncryptionCurrentness,
            http: {
                get: async (url) => (
                    url.endsWith('/v1/account/encryption')
                        ? { status: 200, data: { mode: 'plain' as const, updatedAt: 1 } }
                        : { status: 200, data: { status: 'absent' as const } }
                ),
                post: accountMutation,
            },
        });
        const owner = await createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'live', 'global', ['account-storage']),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            isCommittedGenerationCurrent: async () => committedGenerationCurrent,
            bindDynamicResourceAccountStorage: createPluginResourceAccountStorageResolver({
                accountStorage: accountStorageHost,
            }),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                hostAccessRequests: [{
                    required: true,
                    request: {
                        id: 'account-storage',
                        capability: 'storage.account',
                        reason: 'Persist Account-scoped Resource state',
                        scope: { enabled: true },
                    },
                }],
                runtime: {
                    read: () => new Uint8Array(Buffer.from('admission')),
                    observe: (_notify, options) => {
                        observedAccountStorage = options.accountStorage;
                        return { dispose: () => undefined };
                    },
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const subscription = service.watch('live', () => undefined);
        if (!observedAccountStorage) throw new Error('Expected the Resource observation Account storage scope');

        committedGenerationCurrent = false;
        await expect(observedAccountStorage.kv.set('resource-state', { saved: true }, {
            expectedVersion: 'absent',
        })).rejects.toMatchObject({
            code: 'plugin_generation_stale',
        });
        expect(accountMutation).not.toHaveBeenCalled();
        subscription.dispose();
    });

    it('does not let a held Resource watch settlement callback mutate Account storage after committed authority flips', async () => {
        const callbackStarted = deferred<void>();
        const releaseCallback = deferred<void>();
        let committedGenerationCurrent = true;
        let reads = 0;
        let invalidate: (() => void) | undefined;
        const accountMutation = vi.fn(async () => ({
            status: 200,
            data: { status: 'updated' as const, revision: 1 },
        }));
        const accountStorageHost = createAccountPluginDataStorageHost({
            contracts: [],
            readCredentials: async () => ({ token: 'account-token', encryption: null }),
            isCurrentAccount: () => true,
            resolveAccountScopeKey: () => 'account-scope',
            resolveBaseUrl: () => 'https://data.example.test',
            resolveAccountEncryptionCurrentness: resolvePlainAccountEncryptionCurrentness,
            http: {
                get: async (url) => (
                    url.endsWith('/v1/account/encryption')
                        ? { status: 200, data: { mode: 'plain' as const, updatedAt: 1 } }
                        : { status: 200, data: { status: 'absent' as const } }
                ),
                post: accountMutation,
            },
        });
        const owner = await createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'live', 'global', ['account-storage']),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            isCommittedGenerationCurrent: async () => committedGenerationCurrent,
            bindDynamicResourceAccountStorage: createPluginResourceAccountStorageResolver({
                accountStorage: accountStorageHost,
            }),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                hostAccessRequests: [{
                    required: true,
                    request: {
                        id: 'account-storage',
                        capability: 'storage.account',
                        reason: 'Persist Account-scoped Resource state',
                        scope: { enabled: true },
                    },
                }],
                runtime: {
                    read: async (options) => {
                        reads += 1;
                        if (reads <= 2) return new Uint8Array(Buffer.from(`baseline-${reads}`));
                        callbackStarted.resolve(undefined);
                        await releaseCallback.promise;
                        await options.accountStorage!.kv.set('resource-state', { saved: true }, {
                            expectedVersion: 'absent',
                        });
                        return new Uint8Array(Buffer.from('settlement'));
                    },
                    observe: (notify) => {
                        invalidate = notify;
                        return { dispose: () => { invalidate = undefined; } };
                    },
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const subscription = service.watch('live', () => undefined);
        await vi.waitFor(() => expect(reads).toBe(2));
        if (!invalidate) throw new Error('Expected a dynamic Resource invalidation callback');

        invalidate();
        await callbackStarted.promise;
        committedGenerationCurrent = false;
        releaseCallback.resolve(undefined);
        await settle();

        expect(accountMutation).not.toHaveBeenCalled();
        subscription.dispose();
    });

    it('does not publish a settled Resource snapshot after committed authority flips', async () => {
        const callbackStarted = deferred<void>();
        const releaseCallback = deferred<void>();
        let committedGenerationCurrent = true;
        let reads = 0;
        let invalidate: (() => void) | undefined;
        const baseline = new Uint8Array(Buffer.from('baseline'));
        const changed = new Uint8Array(Buffer.from('changed'));
        const listener = vi.fn();
        const owner = await createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'live'),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            isCommittedGenerationCurrent: async () => committedGenerationCurrent,
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: {
                    read: async () => {
                        reads += 1;
                        if (reads <= 2) return baseline;
                        callbackStarted.resolve(undefined);
                        await releaseCallback.promise;
                        return changed;
                    },
                    observe: (notify) => {
                        invalidate = notify;
                        return { dispose: () => { invalidate = undefined; } };
                    },
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const subscription = service.watch('live', listener);
        await vi.waitFor(() => expect(reads).toBe(2));
        const before = service.describe('live');
        listener.mockClear();
        if (!invalidate) throw new Error('Expected a dynamic Resource invalidation callback');

        invalidate();
        await callbackStarted.promise;
        committedGenerationCurrent = false;
        releaseCallback.resolve(undefined);
        await settle();

        expect(service.describe('live')).toEqual(before);
        expect(listener).not.toHaveBeenCalled();
        subscription.dispose();
    });

    it('retires A observation before a B Account-unavailable rebind and later admits only B', async () => {
        const accountA = accountStorageFixture();
        const accountB = accountStorageFixture();
        let activeAccount = 'account-a';
        let accountBAvailable = false;
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 1,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: activeAccount,
        });
        const observations: Array<{
            accountStorage: typeof accountA;
            notify: () => void;
            disposed: boolean;
        }> = [];
        const reads: typeof accountA[] = [];
        const owner = await createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'live', 'global', ['account-storage']),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            bindDynamicResourceAccountStorage: () => (
                activeAccount === 'account-a' ? accountA : accountB
            ),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                hostAccessRequests: [{
                    required: true,
                    request: {
                        id: 'account-storage',
                        capability: 'storage.account',
                        reason: 'Read Account-scoped Resource state',
                        scope: { enabled: true },
                    },
                }],
                runtime: {
                    read: (options) => {
                        const accountStorage = options.accountStorage;
                        if (accountStorage !== accountA && accountStorage !== accountB) {
                            throw new Error('Expected the admitted Account storage scope');
                        }
                        reads.push(accountStorage);
                        if (accountStorage === accountB && !accountBAvailable) {
                            throw new PluginError({
                                code: 'collection_unavailable',
                                message: 'Account Collection is unavailable for the current Account',
                            });
                        }
                        return new Uint8Array(Buffer.from(
                            accountStorage === accountA ? 'A' : 'B',
                        ));
                    },
                    observe: (notify, options) => {
                        const accountStorage = options.accountStorage;
                        if (accountStorage !== accountA && accountStorage !== accountB) {
                            throw new Error('Expected the admitted Account storage scope');
                        }
                        const observation = {
                            accountStorage,
                            notify,
                            disposed: false,
                        };
                        observations.push(observation);
                        return {
                            dispose: () => { observation.disposed = true; },
                        };
                    },
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const changes: Array<{ digest: string }> = [];
        const subscription = service.watch('live', (change) => { changes.push(change); });
        await settle();
        expect(observations).toHaveLength(1);
        expect(observations[0]?.accountStorage).toBe(accountA);
        expect(service.describe('live')).toMatchObject({ digest: digest(Buffer.from('A')) });

        activeAccount = 'account-b';
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 1,
            loadedAtMs: 2,
            settingsSecretsReadKeys: [],
            scopeKey: activeAccount,
        });
        await settle();

        expect(observations).toHaveLength(2);
        expect(observations[0]?.disposed).toBe(true);
        expect(observations[1]?.accountStorage).toBe(accountB);
        expect(() => service.describe('live')).toThrowError(
            expect.objectContaining({ code: 'plugin_resource_context_unavailable' }),
        );
        await expect(service.read('live')).rejects.toMatchObject({ code: 'collection_unavailable' });
        expect(changes).toEqual([]);

        const readsAfterBRebind = reads.length;
        observations[0]?.notify();
        await settle();
        expect(reads).toHaveLength(readsAfterBRebind);
        expect(changes).toEqual([]);

        accountBAvailable = true;
        observations[1]?.notify();
        await vi.waitFor(() => {
            expect(changes).toEqual([{ digest: digest(Buffer.from('B')) }]);
        });
        expect(service.describe('live')).toMatchObject({ digest: digest(Buffer.from('B')) });

        subscription.dispose();
    });

    it.each([
        {
            code: 'collection_unavailable',
            failure: 'producer' as const,
            label: 'the Collection producer is temporarily unavailable',
        },
        {
            code: 'plugin_account_storage_unavailable',
            failure: 'hostAccess' as const,
            label: 'required Account HostAccess is temporarily unavailable',
        },
    ] as const)('retries a B observation in the same Account when $label', async ({ code, failure }) => {
        const accountA = accountStorageFixture();
        const accountB = accountStorageFixture();
        let activeAccount = 'account-a';
        let bObserveFailurePending = true;
        let bValue = 'B0';
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 1,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: activeAccount,
        });
        const observations: Array<{
            accountStorage: typeof accountA;
            notify: () => void;
            disposed: boolean;
        }> = [];
        const owner = await createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'live', 'global', ['account-storage']),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            bindDynamicResourceAccountStorage: () => {
                if (
                    activeAccount === 'account-b'
                    && failure === 'hostAccess'
                    && bObserveFailurePending
                ) {
                    bObserveFailurePending = false;
                    return undefined;
                }
                return activeAccount === 'account-a' ? accountA : accountB;
            },
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                hostAccessRequests: [{
                    required: true,
                    request: {
                        id: 'account-storage',
                        capability: 'storage.account',
                        reason: 'Read Account-scoped Resource state',
                        scope: { enabled: true },
                    },
                }],
                runtime: {
                    read: ({ accountStorage }) => {
                        if (accountStorage === accountA) return new Uint8Array(Buffer.from('A'));
                        if (accountStorage === accountB) return new Uint8Array(Buffer.from(bValue));
                        throw new Error('Expected an admitted Account storage scope');
                    },
                    observe: (notify, { accountStorage }) => {
                        if (
                            accountStorage === accountB
                            && failure === 'producer'
                            && bObserveFailurePending
                        ) {
                            bObserveFailurePending = false;
                            throw new PluginError({
                                code,
                                message: 'Account data is temporarily unavailable while B observation binds',
                            });
                        }
                        if (accountStorage !== accountA && accountStorage !== accountB) {
                            throw new Error('Expected an admitted Account storage scope');
                        }
                        const observation = { accountStorage, notify, disposed: false };
                        observations.push(observation);
                        return { dispose: () => { observation.disposed = true; } };
                    },
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const changes: Array<{ digest: string }> = [];
        const subscription = service.watch('live', (change) => { changes.push(change); });
        await settle();
        expect(observations).toHaveLength(1);
        expect(observations[0]?.accountStorage).toBe(accountA);

        activeAccount = 'account-b';
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 1,
            loadedAtMs: 2,
            settingsSecretsReadKeys: [],
            scopeKey: activeAccount,
        });

        await vi.waitFor(() => {
            expect(observations).toHaveLength(2);
            expect(observations[0]?.disposed).toBe(true);
            expect(observations[1]?.accountStorage).toBe(accountB);
            expect(changes).toContainEqual({ digest: digest(Buffer.from('B0')) });
        });

        bValue = 'B1';
        observations[1]?.notify();
        await vi.waitFor(() => {
            expect(changes.at(-1)).toEqual({ digest: digest(Buffer.from('B1')) });
        });

        subscription.dispose();
    });

    it('terminates an Account rebind watch after a generic observe failure instead of settling a detached B watch', async () => {
        const accountA = accountStorageFixture();
        const accountB = accountStorageFixture();
        let activeAccount = 'account-a';
        let bObserveFailurePending = true;
        const reads: typeof accountA[] = [];
        const observations: Array<{ accountStorage: typeof accountA; disposed: boolean }> = [];
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 1,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: activeAccount,
        });
        const owner = await createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'live', 'global', ['account-storage']),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            bindDynamicResourceAccountStorage: () => (
                activeAccount === 'account-a' ? accountA : accountB
            ),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                hostAccessRequests: [{
                    required: true,
                    request: {
                        id: 'account-storage',
                        capability: 'storage.account',
                        reason: 'Read Account-scoped Resource state',
                        scope: { enabled: true },
                    },
                }],
                runtime: {
                    read: ({ accountStorage }) => {
                        if (accountStorage !== accountA && accountStorage !== accountB) {
                            throw new Error('Expected an admitted Account storage scope');
                        }
                        reads.push(accountStorage);
                        return new Uint8Array(Buffer.from(accountStorage === accountA ? 'A' : 'B'));
                    },
                    observe: (_notify, { accountStorage }) => {
                        if (accountStorage === accountB && bObserveFailurePending) {
                            bObserveFailurePending = false;
                            throw new Error('Generic B observation failure');
                        }
                        if (accountStorage !== accountA && accountStorage !== accountB) {
                            throw new Error('Expected an admitted Account storage scope');
                        }
                        const observation = { accountStorage, disposed: false };
                        observations.push(observation);
                        return { dispose: () => { observation.disposed = true; } };
                    },
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const subscription = service.watch('live', vi.fn());
        await settle();
        const readsBeforeB = reads.length;

        activeAccount = 'account-b';
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 1,
            loadedAtMs: 2,
            settingsSecretsReadKeys: [],
            scopeKey: activeAccount,
        });
        await settle();

        expect(observations).toHaveLength(1);
        expect(observations[0]?.disposed).toBe(true);
        expect(reads).toHaveLength(readsBeforeB);
        expect(() => service.describe('live')).toThrowError(
            expect.objectContaining({ code: 'plugin_resource_context_unavailable' }),
        );

        subscription.dispose();
    });

    it('retires an unwatched Account-backed global observation before B can expose A', async () => {
        const accountA = accountStorageFixture();
        const accountB = accountStorageFixture();
        let activeAccount = 'account-a';
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 1,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: activeAccount,
        });
        const owner = await createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'live', 'global', ['account-storage']),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            bindDynamicResourceAccountStorage: () => (
                activeAccount === 'account-a' ? accountA : accountB
            ),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                hostAccessRequests: [{
                    required: true,
                    request: {
                        id: 'account-storage',
                        capability: 'storage.account',
                        reason: 'Read Account-scoped Resource state',
                        scope: { enabled: true },
                    },
                }],
                runtime: {
                    read: ({ accountStorage }) => {
                        if (accountStorage === accountB) {
                            throw new PluginError({
                                code: 'collection_unavailable',
                                message: 'Account Collection is unavailable for the current Account',
                            });
                        }
                        return new Uint8Array(Buffer.from('A'));
                    },
                    observe: () => ({ dispose: () => undefined }),
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });

        expect(service.describe('live')).toMatchObject({ digest: digest(Buffer.from('A')) });

        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 2,
            loadedAtMs: 2,
            settingsSecretsReadKeys: [],
            scopeKey: activeAccount,
        });
        expect(service.describe('live')).toMatchObject({ digest: digest(Buffer.from('A')) });

        activeAccount = 'account-b';
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 1,
            loadedAtMs: 3,
            settingsSecretsReadKeys: [],
            scopeKey: activeAccount,
        });

        expect(() => service.describe('live')).toThrowError(
            expect.objectContaining({ code: 'plugin_resource_context_unavailable' }),
        );
        await expect(service.read('live')).rejects.toMatchObject({ code: 'collection_unavailable' });
        expect(() => service.describe('live')).toThrowError(
            expect.objectContaining({ code: 'plugin_resource_context_unavailable' }),
        );
    });

    it('retries an initial approved Account observation failure without requiring an Account transition', async () => {
        const accountStorage = accountStorageFixture();
        let accountAvailable = false;
        let observeCalls = 0;
        const reads: string[] = [];
        const observations: Array<{ disposed: boolean }> = [];
        setActiveAccountSettingsSnapshot({
            source: 'network',
            settings: accountSettingsParse({}),
            settingsVersion: 1,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'account-a',
        });
        const owner = await createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'live', 'global', ['account-storage']),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            bindDynamicResourceAccountStorage: () => accountStorage,
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                hostAccessRequests: [{
                    required: true,
                    request: {
                        id: 'account-storage',
                        capability: 'storage.account',
                        reason: 'Read Account-scoped Resource state',
                        scope: { enabled: true },
                    },
                }],
                runtime: {
                    read: () => {
                        const value = accountAvailable ? 'ready' : 'pending';
                        reads.push(value);
                        return new Uint8Array(Buffer.from(value));
                    },
                    observe: () => {
                        observeCalls += 1;
                        if (!accountAvailable) {
                            throw new PluginError({
                                code: 'plugin_account_storage_unavailable',
                                message: 'Account Data is unavailable for the current Account',
                            });
                        }
                        const observation = { disposed: false };
                        observations.push(observation);
                        return { dispose: () => { observation.disposed = true; } };
                    },
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const changes: Array<{ digest: string }> = [];

        let subscription: Disposable | undefined;
        expect(() => {
            subscription = service.watch('live', (change) => { changes.push(change); });
        }).not.toThrow();
        expect(observeCalls).toBe(1);

        accountAvailable = true;
        await vi.waitFor(() => {
            expect(observeCalls).toBe(2);
            expect(observations).toHaveLength(1);
            expect(reads).toContain('ready');
            expect(changes).toEqual([{ digest: digest(Buffer.from('ready')) }]);
        });

        subscription?.dispose();
        expect(observations[0]?.disposed).toBe(true);
    });

    it.each([
        {
            code: 'collection_unavailable',
            initiallyBindsAccountStorage: true,
            label: 'the Account Collection producer is unavailable',
        },
        {
            code: 'plugin_account_storage_unavailable',
            initiallyBindsAccountStorage: false,
            label: 'required Account HostAccess is unavailable',
        },
    ] as const)('admits an initial Account-bound Resource without fabricating a snapshot when $label', async ({
        code,
        initiallyBindsAccountStorage,
    }) => {
        const accountStorage = accountStorageFixture();
        let accountAvailable = false;
        const read = vi.fn(() => {
            if (!accountAvailable) {
                throw new PluginError({
                    code: 'collection_unavailable',
                    message: 'Account Collection is unavailable for the current Account',
                });
            }
            return new Uint8Array(Buffer.from('ready'));
        });
        const owner = await createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'live', 'global', ['account-storage']),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            bindDynamicResourceAccountStorage: () => (
                initiallyBindsAccountStorage || accountAvailable ? accountStorage : undefined
            ),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                hostAccessRequests: [{
                    required: true,
                    request: {
                        id: 'account-storage',
                        capability: 'storage.account',
                        reason: 'Read Account-scoped Resource state',
                        scope: { enabled: true },
                    },
                }],
                runtime: {
                    read,
                    observe: () => ({ dispose: () => undefined }),
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });

        expect(owner.getPluginUiResourceCapability('acme.alpha')).toEqual({
            readable: true,
            dynamic: true,
        });
        expect(() => service.describe('live')).toThrowError(
            expect.objectContaining({ code: 'plugin_resource_context_unavailable' }),
        );
        await expect(service.read('live')).rejects.toMatchObject({ code });
        expect(() => service.describe('live')).toThrowError(
            expect.objectContaining({ code: 'plugin_resource_context_unavailable' }),
        );

        accountAvailable = true;
        await expect(service.read('live')).resolves.toMatchObject({
            bytes: new Uint8Array(Buffer.from('ready')),
            digest: digest(Buffer.from('ready')),
        });
        expect(service.describe('live')).toMatchObject({
            digest: digest(Buffer.from('ready')),
            size: Buffer.byteLength('ready'),
        });
    });

    it.each([
        {
            code: 'collection_unavailable',
            hostAccess: undefined,
            label: 'the same producer error has no Account HostAccess',
            read: () => {
                throw new PluginError({
                    code: 'collection_unavailable',
                    message: 'Collection is unavailable outside an Account-bound Resource',
                });
            },
        },
        {
            code: 'collection_content_mode_mismatch',
            hostAccess: ['account-storage'] as const,
            label: 'an Account-bound producer returns another typed failure',
            read: () => {
                throw new PluginError({
                    code: 'collection_content_mode_mismatch',
                    message: 'Collection content mode is inconsistent',
                });
            },
        },
        {
            code: 'plugin_resource_producer_invalid',
            hostAccess: ['account-storage'] as const,
            label: 'an Account-bound producer returns invalid bytes',
            // Plugin callbacks are an untyped external boundary; this fixture
            // deliberately violates the registered runtime return contract.
            read: () => ({ invalid: true } as unknown as Uint8Array),
        },
    ] as const)('keeps admission fatal when $label', async ({ code, hostAccess, read }) => {
        const hostAccessRequests = hostAccess === undefined
            ? []
            : [{
                required: true as const,
                request: {
                    id: 'account-storage',
                    capability: 'storage.account' as const,
                    reason: 'Read Account-scoped Resource state',
                    scope: { enabled: true as const },
                },
            }];

        await expect(createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'live', 'global', hostAccess),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            bindDynamicResourceAccountStorage: () => accountStorageFixture(),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                hostAccessRequests,
                runtime: {
                    read,
                    observe: () => ({ dispose: () => undefined }),
                },
            }],
        })).rejects.toMatchObject({ code });
    });

    it('binds admitted Account storage only for each read and observe lifetime', async () => {
        const callbackOptions: unknown[] = [];
        let invalidate: (() => void) | undefined;
        const accountStorage = Object.freeze({ marker: 'account-storage' }) as unknown as PluginAccountStorageScope;
        const bindAccountStorage = vi.fn(() => accountStorage);
        const owner = await createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'live', 'global', ['account-storage']),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            bindDynamicResourceAccountStorage: bindAccountStorage,
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                hostAccessRequests: [{
                    required: true,
                    request: {
                        id: 'account-storage',
                        capability: 'storage.account',
                        reason: 'Persist Account-scoped Resource state',
                        scope: { enabled: true },
                    },
                }],
                runtime: {
                    read: (options) => {
                        callbackOptions.push(options);
                        return new Uint8Array(Buffer.from('current'));
                    },
                    observe: (notify, options) => {
                        callbackOptions.push(options);
                        invalidate = notify;
                        return { dispose: () => undefined };
                    },
                },
            }],
        });

        expect(callbackOptions[0]).toMatchObject({
            accountStorage,
            context: { kind: 'global' },
            signal: expect.any(AbortSignal),
        });

        const bindingController = new AbortController();
        const service = owner.bind({
            pluginId: 'acme.alpha',
            signal: bindingController.signal,
            isGenerationCurrent: () => true,
        });
        await service.read('live');
        const watch = service.watch('live', () => undefined);
        expect(callbackOptions.at(-1)).toMatchObject({
            accountStorage,
            context: { kind: 'global' },
            signal: expect.any(AbortSignal),
        });
        (invalidate as unknown as () => void)();
        await settle();
        expect(callbackOptions.at(-1)).toMatchObject({
            accountStorage,
            context: { kind: 'global' },
            signal: expect.any(AbortSignal),
        });
        expect(bindAccountStorage).toHaveBeenCalledWith(expect.objectContaining({
            pluginId: 'acme.alpha',
            resourceId: 'live',
            generation: DYNAMIC_GENERATION,
            hostAccessRequests: [expect.objectContaining({ required: true })],
        }));
        watch.dispose();
        bindingController.abort();
    });
});

describe('dynamic resource invalidation is owed to observers, not to the last reader (EU-4b)', () => {
    it('does not treat an empty page-local Session witness as authority for an arbitrary Session', async () => {
        const read = vi.fn(() => new Uint8Array(Buffer.from('must-not-run')));
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'session-live', 'session')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'session-live',
                runtime: {
                    read,
                    observe: () => ({ dispose: () => undefined }),
                },
            }],
        });
        establishSessionAccessWitness(owner, { throughCursor: 12 });
        const session = owner.bind({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            context: { kind: 'session', sessionId: 'session-a' },
        });

        await expect(session.read('session-live')).rejects.toMatchObject({
            code: 'plugin_resource_session_access_unavailable',
        });
        expect(read).not.toHaveBeenCalled();
    });

    it('does not resurrect a removed Session when a replacement receives only a newer unrelated page', async () => {
        const read = vi.fn(() => new Uint8Array(Buffer.from('must-not-run')));
        const resolveSessionResourceAccess = vi.fn(async () => ({
            accountId: 'account-a',
            throughCursor: 12,
            status: 'unavailable' as const,
        }));
        const createOwner = async () => await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'session-live', 'session')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'session-live',
                runtime: {
                    read,
                    observe: () => ({ dispose: () => undefined }),
                },
            }],
            resolveSessionResourceAccess,
        });
        const predecessor = await createOwner();
        establishSessionAccessWitness(predecessor, {
            throughCursor: 11,
            entries: [{ sessionId: 'session-a', cursor: 11, status: 'unavailable' }],
        });
        await expect(predecessor.bindForResource({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            context: { kind: 'session', sessionId: 'session-a' },
            resourceId: 'session-live',
        })).rejects.toMatchObject({
            code: 'plugin_resource_session_access_unavailable',
        });

        // A reload replacement receives the latest carrier page (cursor 12),
        // not an ever-growing Session inventory. That empty unrelated page
        // must not turn omission of session-a into a grant.
        const replacement = await createOwner();
        establishSessionAccessWitness(replacement, { throughCursor: 12 });
        await expect(replacement.bindForResource({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            context: { kind: 'session', sessionId: 'session-a' },
            resourceId: 'session-live',
        })).rejects.toMatchObject({
            code: 'plugin_resource_session_access_unavailable',
        });
        expect(resolveSessionResourceAccess).toHaveBeenLastCalledWith({
            accountId: 'account-a',
            sessionId: 'session-a',
            signal: expect.any(AbortSignal),
        });
        expect(read).not.toHaveBeenCalled();
    });

    it('admits a new Session context only from an exact current server proof', async () => {
        const read = vi.fn(() => new Uint8Array(Buffer.from('session-a')));
        const resolveSessionResourceAccess = vi.fn(async () => ({
            accountId: 'account-a',
            throughCursor: 12,
            status: 'available' as const,
        }));
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'session-live', 'session')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'session-live',
                runtime: {
                    read,
                    observe: () => ({ dispose: () => undefined }),
                },
            }],
            resolveSessionResourceAccess,
        });
        establishSessionAccessWitness(owner, { throughCursor: 12 });

        const session = await owner.bindForResource({
            pluginId: 'acme.alpha',
            resourceId: 'session-live',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            context: { kind: 'session', sessionId: 'session-a' },
        });

        await expect(session.read('session-live')).resolves.toMatchObject({
            bytes: new Uint8Array(Buffer.from('session-a')),
        });
        expect(resolveSessionResourceAccess).toHaveBeenCalledExactlyOnceWith({
            accountId: 'account-a',
            sessionId: 'session-a',
            signal: expect.any(AbortSignal),
        });
        expect(read).toHaveBeenCalledTimes(1);
    });

    it('rejects an older available probe after a newer carrier retires the Session', async () => {
        const read = vi.fn(() => new Uint8Array(Buffer.from('must-not-run')));
        const observe = vi.fn(() => ({ dispose: () => undefined }));
        const probe = deferred<Readonly<{
            accountId: string;
            throughCursor: number;
            status: 'available';
        }>>();
        const resolveSessionResourceAccess = vi.fn(() => probe.promise);
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'session-live', 'session')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'session-live',
                runtime: { read, observe },
            }],
            resolveSessionResourceAccess,
        });
        establishSessionAccessWitness(owner, { throughCursor: 12 });

        const binding = bindSessionResource(owner, {
            resourceId: 'session-live',
            sessionId: 'session-a',
        });
        expect(resolveSessionResourceAccess).toHaveBeenCalledExactlyOnceWith({
            accountId: 'account-a',
            sessionId: 'session-a',
            signal: expect.any(AbortSignal),
        });

        // The Account carrier advances and permanently retires this Session
        // while the exact server probe is still in flight.
        establishSessionAccessWitness(owner, {
            throughCursor: 13,
            entries: [{ sessionId: 'session-a', cursor: 13, status: 'unavailable' }],
        });
        probe.resolve({ accountId: 'account-a', throughCursor: 12, status: 'available' });

        await expect(binding).rejects.toMatchObject({
            code: 'plugin_resource_session_access_unavailable',
        });

        // The synchronous service cannot bypass the failed async admission;
        // neither an on-demand read nor a watch may start the producer.
        const rejected = owner.bind({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            context: { kind: 'session', sessionId: 'session-a' },
        });
        await expect(rejected.read('session-live')).rejects.toMatchObject({
            code: 'plugin_resource_session_access_unavailable',
        });
        expect(() => rejected.watch('session-live', () => undefined)).toThrowError(
            expect.objectContaining({ code: 'plugin_resource_session_access_unavailable' }),
        );
        expect(read).not.toHaveBeenCalled();
        expect(observe).not.toHaveBeenCalled();
    });

    it('rejects a bound Session admission when a newer carrier retires it before first use', async () => {
        const read = vi.fn(() => new Uint8Array(Buffer.from('must-not-run')));
        const observe = vi.fn(() => ({ dispose: () => undefined }));
        const resolveSessionResourceAccess = vi.fn(async (input: Readonly<{
            accountId: string;
            sessionId: string;
            signal: AbortSignal;
        }>) => ({
            accountId: input.accountId,
            throughCursor: 12,
            status: 'available' as const,
        }));
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'session-live', 'session')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'session-live',
                runtime: { read, observe },
            }],
            resolveSessionResourceAccess,
        });
        establishSessionAccessWitness(owner, { throughCursor: 12 });

        const bound = await bindSessionResource(owner, {
            resourceId: 'session-live',
            sessionId: 'session-a',
        });
        owner.applySessionAccessWitness({
            accountId: 'account-a',
            witness: {
                v: 1,
                throughCursor: 13,
                entries: [{ sessionId: 'session-a', cursor: 13, status: 'unavailable' }],
            },
        });

        await expect(bound.read('session-live')).rejects.toMatchObject({
            code: 'plugin_resource_session_access_unavailable',
        });
        expect(() => bound.watch('session-live', () => undefined)).toThrowError(
            expect.objectContaining({ code: 'plugin_resource_session_access_unavailable' }),
        );
        expect(read).not.toHaveBeenCalled();
        expect(observe).not.toHaveBeenCalled();
    });

    it('fences a retired Session read after its final currentness check before observation admission', async () => {
        const lateBytes = new Uint8Array(MAX_PLUGIN_RESOURCE_BYTES);
        const survivorIds = ['survivor-1', 'survivor-2', 'survivor-3', 'survivor-4'] as const;
        let scheduleRetirement = true;
        let retirementChecks = 0;
        let owner!: StablePluginResourcesOwner;
        owner = await createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'retired', 'session'),
                ...survivorIds.map((localId) => dynamicContribution('acme.alpha', localId, 'session')),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            isCommittedGenerationCurrent: () => {
                if (scheduleRetirement && ++retirementChecks === 2) {
                    return new Promise<boolean>((resolve) => {
                        setImmediate(() => {
                            // Resolve the final inner guard first, then queue
                            // the carrier retirement before its outer `await`
                            // continuation can admit the observation.
                            resolve(true);
                            queueMicrotask(() => queueMicrotask(() => {
                                owner.applySessionAccessWitness({
                                    accountId: 'account-a',
                                    witness: {
                                        v: 1,
                                        throughCursor: 2,
                                        entries: [{ sessionId: 'session-a', cursor: 2, status: 'unavailable' }],
                                    },
                                });
                            }));
                        });
                    });
                }
                return true;
            },
            dynamicProducers: [
                {
                    pluginId: 'acme.alpha',
                    localId: 'retired',
                    runtime: {
                        read: () => lateBytes,
                        observe: () => ({ dispose: () => undefined }),
                    },
                },
                ...survivorIds.map((localId) => ({
                    pluginId: 'acme.alpha',
                    localId,
                    runtime: {
                        read: () => new Uint8Array(MAX_PLUGIN_RESOURCE_BYTES),
                        observe: () => ({ dispose: () => undefined }),
                    },
                })),
            ],
            resolveSessionResourceAccess: async (input) => ({
                accountId: input.accountId,
                throughCursor: 1_000_000,
                status: 'available',
            }),
        });
        establishSessionAccessWitness(owner);
        const retired = await bindSessionResource(owner, {
            resourceId: 'retired',
            sessionId: 'session-a',
        });

        const retiredOutcome = await retired.read('retired').then(
            () => null,
            (error: unknown) => error,
        );
        expect(retiredOutcome).toMatchObject({
            code: 'plugin_resource_context_unavailable',
        });
        expect(() => retired.describe('retired')).toThrowError(
            expect.objectContaining({ code: 'plugin_resource_session_access_unavailable' }),
        );

        // Filling the entire aggregate through a still-live Session proves the
        // removed Resource left neither a descriptor-bearing context nor late
        // aggregate accounting behind.
        scheduleRetirement = false;
        for (const resourceId of survivorIds) {
            const survivor = await bindSessionResource(owner, { resourceId, sessionId: 'session-b' });
            const observed = await survivor.read(resourceId);
            expect(observed.bytes.byteLength).toBe(MAX_PLUGIN_RESOURCE_BYTES);
        }
    });

    it('fences a retired Session watch settlement before it admits late aggregate bytes', async () => {
        const lateBytes = new Uint8Array(MAX_PLUGIN_RESOURCE_BYTES);
        const survivorIds = ['survivor-1', 'survivor-2', 'survivor-3', 'survivor-4'] as const;
        let targetSettlement = false;
        let settlementChecks = 0;
        let invalidate: (() => void) | null = null;
        const readInvalidation = (): (() => void) | null => invalidate;
        let owner!: StablePluginResourcesOwner;
        owner = await createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'retired', 'session'),
                ...survivorIds.map((localId) => dynamicContribution('acme.alpha', localId, 'session')),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            isCommittedGenerationCurrent: () => {
                if (targetSettlement && ++settlementChecks === 2) {
                    return new Promise<boolean>((resolve) => {
                        setImmediate(() => {
                            // The settlement's final committed-currentness
                            // check has resolved. Retire before its awaiting
                            // continuation may mutate this context's LKG.
                            resolve(true);
                            queueMicrotask(() => {
                                owner.applySessionAccessWitness({
                                    accountId: 'account-a',
                                    witness: {
                                        v: 1,
                                        throughCursor: 2,
                                        entries: [{ sessionId: 'session-a', cursor: 2, status: 'unavailable' }],
                                    },
                                });
                            });
                        });
                    });
                }
                return true;
            },
            dynamicProducers: [
                {
                    pluginId: 'acme.alpha',
                    localId: 'retired',
                    runtime: {
                        read: () => lateBytes,
                        observe: (notify) => {
                            invalidate = notify;
                            return { dispose: () => { invalidate = null; } };
                        },
                    },
                },
                ...survivorIds.map((localId) => ({
                    pluginId: 'acme.alpha',
                    localId,
                    runtime: {
                        read: () => new Uint8Array(MAX_PLUGIN_RESOURCE_BYTES),
                        observe: () => ({ dispose: () => undefined }),
                    },
                })),
            ],
            resolveSessionResourceAccess: async (input) => ({
                accountId: input.accountId,
                throughCursor: 1_000_000,
                status: 'available',
            }),
        });
        establishSessionAccessWitness(owner);
        const retired = await bindSessionResource(owner, {
            resourceId: 'retired',
            sessionId: 'session-a',
        });
        await retired.read('retired');
        const changes: Array<{ digest: string }> = [];
        const subscription = retired.watch('retired', (change) => { changes.push(change); });
        try {
            await settle();
            changes.length = 0;
            const invalidation = readInvalidation();
            if (!invalidation) throw new Error('Expected a Session Resource invalidation callback');

            targetSettlement = true;
            invalidation();
            await settle();

            expect(changes).toEqual([]);
            expect(() => retired.describe('retired')).toThrowError(
                expect.objectContaining({ code: 'plugin_resource_session_access_unavailable' }),
            );
            for (const resourceId of survivorIds) {
                const survivor = await bindSessionResource(owner, { resourceId, sessionId: 'session-b' });
                const observed = await survivor.read(resourceId);
                expect(observed.bytes.byteLength).toBe(MAX_PLUGIN_RESOURCE_BYTES);
            }
        } finally {
            subscription.dispose();
        }
    });

    it('requires the Account change Session-access witness for Session Resources while keeping global Resources available', async () => {
        const owner = await createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'session-live', 'session'),
                dynamicContribution('acme.alpha', 'account-live', 'global'),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: [
                {
                    pluginId: 'acme.alpha',
                    localId: 'session-live',
                    runtime: {
                        read: () => new Uint8Array(Buffer.from('session')),
                        observe: () => ({ dispose: () => undefined }),
                    },
                },
                {
                    pluginId: 'acme.alpha',
                    localId: 'account-live',
                    runtime: {
                        read: () => new Uint8Array(Buffer.from('account')),
                        observe: () => ({ dispose: () => undefined }),
                    },
                },
            ],
            resolveSessionResourceAccess: allowSessionResourceAccess,
        });
        const session = owner.bind({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            context: { kind: 'session', sessionId: 'session-1' },
        });
        const global = owner.bind({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });

        // An old server has no additive witness. Only the Session-scoped
        // operation fails closed; Account-global Resource operations remain
        // independent of Session availability.
        await expect(session.read('session-live')).rejects.toMatchObject({
            code: 'plugin_resource_session_access_unavailable',
        });
        await expect(global.read('account-live')).resolves.toMatchObject({
            bytes: new Uint8Array(Buffer.from('account')),
        });

        owner.applySessionAccessWitness({
            accountId: 'account-a',
            witness: {
                v: 1,
                throughCursor: 7,
                entries: [{
                    sessionId: 'session-1',
                    cursor: 7,
                    status: 'available',
                }],
            },
        });
        const admittedSession = await bindSessionResource(owner, {
            resourceId: 'session-live',
            sessionId: 'session-1',
        });
        await expect(admittedSession.read('session-live')).resolves.toMatchObject({
            bytes: new Uint8Array(Buffer.from('session')),
        });

        owner.applySessionAccessWitness({
            accountId: 'account-a',
            witness: {
                v: 1,
                throughCursor: 8,
                entries: [{
                    sessionId: 'session-1',
                    cursor: 8,
                    status: 'unavailable',
                }],
            },
        });
        await expect(admittedSession.read('session-live')).rejects.toMatchObject({
            code: 'plugin_resource_session_access_unavailable',
        });
        await expect(global.read('account-live')).resolves.toMatchObject({
            bytes: new Uint8Array(Buffer.from('account')),
        });
    });

    it('retires Session contexts on an Account switch without retiring Account-global Resources', async () => {
        const owner = await createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'session-live', 'session'),
                dynamicContribution('acme.alpha', 'account-live', 'global'),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: [
                {
                    pluginId: 'acme.alpha',
                    localId: 'session-live',
                    runtime: {
                        read: () => new Uint8Array(Buffer.from('session')),
                        observe: () => ({ dispose: () => undefined }),
                    },
                },
                {
                    pluginId: 'acme.alpha',
                    localId: 'account-live',
                    runtime: {
                        read: () => new Uint8Array(Buffer.from('account')),
                        observe: () => ({ dispose: () => undefined }),
                    },
                },
            ],
            resolveSessionResourceAccess: allowSessionResourceAccess,
        });
        establishSessionAccessWitness(owner, { accountId: 'account-a' });
        const session = await bindSessionResource(owner, {
            resourceId: 'session-live',
            sessionId: 'session-1',
        });
        const global = owner.bind({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        await session.read('session-live');
        const globalBeforeSwitch = global.describe('account-live');

        establishSessionAccessWitness(owner, {
            accountId: 'account-b',
            throughCursor: 2,
        });

        expect(() => session.describe('session-live')).toThrowError(
            expect.objectContaining({ code: 'plugin_resource_session_access_unavailable' }),
        );
        const sessionAfterSwitch = await bindSessionResource(owner, {
            resourceId: 'session-live',
            sessionId: 'session-1',
        });
        await expect(sessionAfterSwitch.read('session-live')).resolves.toMatchObject({
            bytes: new Uint8Array(Buffer.from('session')),
        });
        expect(global.describe('account-live')).toEqual(globalBeforeSwitch);
    });

    it('lazily owns exact Session contexts without aliasing producer bytes or watches', async () => {
        const reads: Array<string | null> = [];
        const observes: Array<string | null> = [];
        const disposals: string[] = [];
        const invalidators = new Map<string, () => void>();
        const currentBySession = new Map<string, string>();
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'live', 'session')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: {
                    read: (options: { signal: AbortSignal; context: { kind: 'global' } | { kind: 'session'; sessionId: string } }) => {
                        const sessionId = options.context.kind === 'session' ? options.context.sessionId : null;
                        reads.push(sessionId);
                        return new Uint8Array(Buffer.from(
                            sessionId === null ? 'missing-context' : (currentBySession.get(sessionId) ?? sessionId),
                        ));
                    },
                    observe: (
                        notify: () => void,
                        options: { signal: AbortSignal; context: { kind: 'global' } | { kind: 'session'; sessionId: string } },
                    ) => {
                        const sessionId = options.context.kind === 'session' ? options.context.sessionId : null;
                        observes.push(sessionId);
                        if (sessionId !== null) invalidators.set(sessionId, notify);
                        return {
                            dispose: () => {
                                if (sessionId !== null) invalidators.delete(sessionId);
                                disposals.push(sessionId ?? 'missing-context');
                            },
                        };
                    },
                },
            }],
            resolveSessionResourceAccess: allowSessionResourceAccess,
        });
        establishSessionAccessWitness(owner);

        // Session declarations are structural only. Construction must not call
        // a producer before a host-owned exact Session context exists.
        expect(reads).toEqual([]);

        const bind = async (sessionId?: string) => sessionId === undefined
            ? owner.bind({
                pluginId: 'acme.alpha',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            })
            : await bindSessionResource(owner, { resourceId: 'live', sessionId });
        const missing = await bind();
        await expect(missing.read('live')).rejects.toMatchObject({ code: 'plugin_resource_context_unavailable' });

        const sessionA = await bind('session-a');
        const sessionB = await bind('session-b');
        await expect(sessionA.read('live')).resolves.toMatchObject({ bytes: new Uint8Array(Buffer.from('session-a')) });
        await expect(sessionB.read('live')).resolves.toMatchObject({ bytes: new Uint8Array(Buffer.from('session-b')) });
        expect(reads).toEqual(['session-a', 'session-b']);

        const changesA: Array<{ digest: string }> = [];
        const changesA2: Array<{ digest: string }> = [];
        const changesB: Array<{ digest: string }> = [];
        const firstA = sessionA.watch('live', (change) => { changesA.push(change); });
        const secondA = sessionA.watch('live', (change) => { changesA2.push(change); });
        const firstB = sessionB.watch('live', (change) => { changesB.push(change); });
        await settle();

        // Same exact Session shares the one producer observe; a distinct
        // Session has an independent producer context and cannot alias it.
        expect(observes).toEqual(['session-a', 'session-b']);
        currentBySession.set('session-a', 'session-a-updated');
        invalidators.get('session-a')?.();
        await settle();
        expect(changesB).toEqual([]);
        expect(changesA.length + changesA2.length).toBeGreaterThan(0);
        const retainedSessionADescriptor = sessionA.describe('live');

        firstA.dispose();
        secondA.dispose();
        expect(disposals).toContain('session-a');
        // A departing surface stops producer observation but cannot erase the
        // still-live Session's LKG. A future mount reuses that exact context.
        expect(sessionA.describe('live')).toEqual(retainedSessionADescriptor);
        sessionA.watch('live', () => undefined);
        await settle();
        expect(observes).toEqual(['session-a', 'session-b', 'session-a']);
        firstB.dispose();
    });

    it('bounds aggregate active exact Resource/Session contexts without treating UI unmount as Session removal', async () => {
        const disposalsBySession = new Map<string, number>();
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'live', 'session')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: {
                    read: () => new Uint8Array(),
                    observe: (_notify, options: { signal: AbortSignal; context: { kind: 'global' } | { kind: 'session'; sessionId: string } }) => {
                        const sessionId = options.context.kind === 'session' ? options.context.sessionId : 'missing';
                        return {
                            dispose: () => {
                                disposalsBySession.set(
                                    sessionId,
                                    (disposalsBySession.get(sessionId) ?? 0) + 1,
                                );
                            },
                        };
                    },
                },
            }],
            resolveSessionResourceAccess: allowSessionResourceAccess,
        });
        establishSessionAccessWitness(owner);
        const bind = async (sessionId: string) => await bindSessionResource(owner, {
            resourceId: 'live',
            sessionId,
        });
        const subscriptions = (await Promise.all(Array.from(
            { length: ACTIVE_CONTEXT_LIMIT },
            async (_unused, index) => (await bind(`session-${index}`)).watch('live', () => undefined),
        )));
        // A second observer of one exact Resource/Session pair consumes no
        // additional active-context slot.
        const shared = (await bind('session-0')).watch('live', () => undefined);

        const overflow = await bind('session-overflow');
        expect(() => overflow.watch('live', () => undefined)).toThrowError(
            expect.objectContaining({ code: 'plugin_resource_capacity_exceeded' }),
        );

        subscriptions[0]!.dispose();
        shared.dispose();
        expect(disposalsBySession.get('session-0')).toBe(1);
        const overflowAfterUnmount = await bind('session-overflow');
        expect(() => overflowAfterUnmount.watch('live', () => undefined)).toThrowError(
            expect.objectContaining({ code: 'plugin_resource_capacity_exceeded' }),
        );

        for (const subscription of subscriptions.slice(1)) subscription.dispose();
    });

    it('retires every Resource context for one permanently removed Session without touching peers or admitting a late aborted settlement', async () => {
        const removedSessionId = 'session-removed';
        const retainedSessionId = 'session-retained';
        const lateSettlement = deferred<Uint8Array>();
        const readsByResourceAndSession = new Map<string, number>();
        const invalidators = new Map<string, () => void>();
        const disposalCounts = new Map<string, number>();
        let removedSettlementSignal: AbortSignal | undefined;
        const owner = await createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'first', 'session'),
                dynamicContribution('acme.alpha', 'second', 'session'),
                dynamicContribution('acme.alpha', 'global', 'global'),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: ['first', 'second', 'global'].map((localId) => ({
                pluginId: 'acme.alpha',
                localId,
                runtime: {
                    read: (options: {
                        signal: AbortSignal;
                        context: PluginResourceContextV1;
                    }) => {
                        const sessionId = options.context.kind === 'session'
                            ? options.context.sessionId
                            : options.context.kind === 'surface'
                                ? `surface:${options.context.mountInstanceKey}`
                                : 'global';
                        const key = `${localId}:${sessionId}`;
                        const reads = (readsByResourceAndSession.get(key) ?? 0) + 1;
                        readsByResourceAndSession.set(key, reads);
                        if (localId === 'first' && sessionId === removedSessionId && reads === 3) {
                            removedSettlementSignal = options.signal;
                            return lateSettlement.promise;
                        }
                        return new Uint8Array(Buffer.from(`${key}:${reads}`));
                    },
                    observe: (notify, options: {
                        context: PluginResourceContextV1;
                        signal: AbortSignal;
                    }) => {
                        const sessionId = options.context.kind === 'session'
                            ? options.context.sessionId
                            : options.context.kind === 'surface'
                                ? `surface:${options.context.mountInstanceKey}`
                                : 'global';
                        const key = `${localId}:${sessionId}`;
                        invalidators.set(key, notify);
                        return {
                            dispose: () => {
                                invalidators.delete(key);
                                disposalCounts.set(key, (disposalCounts.get(key) ?? 0) + 1);
                            },
                        };
                    },
                },
            })),
            resolveSessionResourceAccess: allowSessionResourceAccess,
        });
        establishSessionAccessWitness(owner);
        const bind = async (sessionId?: string) => sessionId === undefined
            ? owner.bind({
                pluginId: 'acme.alpha',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            })
            : await bindSessionResource(owner, { resourceId: 'first', sessionId });
        const removed = await bind(removedSessionId);
        const retained = await bind(retainedSessionId);
        const global = await bind();

        await removed.read('first');
        await removed.read('second');
        await retained.read('first');
        await retained.read('second');
        await global.read('global');
        const removedChanges: Array<{ digest: string }> = [];
        const removedWatch = removed.watch('first', (change) => { removedChanges.push(change); });
        const retainedWatch = retained.watch('first', () => undefined);
        const globalWatch = global.watch('global', () => undefined);
        await settle();
        // Observation establishment legitimately resettles its own snapshot;
        // the permanent-removal assertion begins after that baseline.
        const retainedFirstDescriptor = retained.describe('first');
        const retainedSecondDescriptor = retained.describe('second');
        const globalDescriptor = global.describe('global');
        removedChanges.length = 0;

        invalidators.get(`first:${removedSessionId}`)!();
        await settle();
        expect(removedSettlementSignal).toBeDefined();

        establishSessionAccessWitness(owner, {
            throughCursor: 2,
            entries: [{
                sessionId: removedSessionId,
                cursor: 2,
                status: 'unavailable',
            }],
        });
        establishSessionAccessWitness(owner, {
            throughCursor: 2,
            entries: [{
                sessionId: removedSessionId,
                cursor: 2,
                status: 'unavailable',
            }],
        });
        expect(removedSettlementSignal?.aborted).toBe(true);
        expect(disposalCounts.get(`first:${removedSessionId}`)).toBe(1);
        expect(disposalCounts.get(`first:${retainedSessionId}`) ?? 0).toBe(0);
        expect(disposalCounts.get('global:global') ?? 0).toBe(0);
        expect(() => removed.describe('first')).toThrowError(
            expect.objectContaining({ code: 'plugin_resource_session_access_unavailable' }),
        );
        expect(() => removed.describe('second')).toThrowError(
            expect.objectContaining({ code: 'plugin_resource_session_access_unavailable' }),
        );

        lateSettlement.resolve(new Uint8Array(Buffer.from('must-not-admit')));
        await settle();

        expect(retained.describe('first')).toEqual(retainedFirstDescriptor);
        expect(retained.describe('second')).toEqual(retainedSecondDescriptor);
        expect(global.describe('global')).toEqual(globalDescriptor);
        expect(removedChanges).toEqual([]);
        removedWatch.dispose();
        retainedWatch.dispose();
        globalWatch.dispose();
    });

    it('reclaims active contextual capacity only when a Session is permanently retired', async () => {
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'live', 'session')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: {
                    read: () => new Uint8Array(),
                    observe: () => ({ dispose: () => undefined }),
                },
            }],
            resolveSessionResourceAccess: allowSessionResourceAccess,
        });
        establishSessionAccessWitness(owner);
        const bind = async (sessionId: string) => await bindSessionResource(owner, {
            resourceId: 'live',
            sessionId,
        });

        for (let index = 0; index < ACTIVE_CONTEXT_LIMIT; index += 1) {
            await (await bind(`session-${index}`)).read('live');
        }
        await expect((await bind('session-overflow')).read('live')).rejects.toMatchObject({
            code: 'plugin_resource_capacity_exceeded',
        });

        establishSessionAccessWitness(owner, {
            throughCursor: 2,
            entries: [{ sessionId: 'session-0', cursor: 2, status: 'unavailable' }],
        });
        establishSessionAccessWitness(owner, {
            throughCursor: 2,
            entries: [{ sessionId: 'session-0', cursor: 2, status: 'unavailable' }],
        });
        await expect((await bind('session-overflow')).read('live')).resolves.toMatchObject({
            bytes: new Uint8Array(),
        });
    });

    it('reclaims aggregate active contextual capacity when a plugin generation retires', async () => {
        const retiredDisposals = new Map<string, number>();
        const owner = await createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'live', 'session'),
                dynamicContribution('acme.beta', 'live', 'session'),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: new Map([
                ['acme.alpha', DYNAMIC_GENERATION],
                ['acme.beta', 'immutable-beta-dynamic'],
            ]),
            dynamicProducers: [
                {
                    pluginId: 'acme.alpha',
                    localId: 'live',
                    runtime: {
                        read: () => new Uint8Array(),
                        observe: (_notify, options: { signal: AbortSignal; context: { kind: 'global' } | { kind: 'session'; sessionId: string } }) => ({
                            dispose: () => {
                                const sessionId = options.context.kind === 'session' ? options.context.sessionId : 'missing';
                                retiredDisposals.set(
                                    sessionId,
                                    (retiredDisposals.get(sessionId) ?? 0) + 1,
                                );
                            },
                        }),
                    },
                },
                {
                    pluginId: 'acme.beta',
                    localId: 'live',
                    runtime: {
                        read: () => new Uint8Array(),
                        observe: () => ({ dispose: () => undefined }),
                    },
                },
            ],
            resolveSessionResourceAccess: allowSessionResourceAccess,
        });
        establishSessionAccessWitness(owner);
        const bind = async (pluginId: 'acme.alpha' | 'acme.beta', sessionId: string) => await bindSessionResource(owner, {
            pluginId,
            resourceId: 'live',
            sessionId,
        });
        const alphaSubscriptions = await Promise.all(Array.from(
            { length: ACTIVE_CONTEXT_LIMIT },
            async (_unused, index) => (await bind('acme.alpha', `session-${index}`)).watch('live', () => undefined),
        ));

        const betaBeforeRetire = await bind('acme.beta', 'beta-before-retire');
        expect(() => betaBeforeRetire.watch('live', () => undefined)).toThrowError(
            expect.objectContaining({ code: 'plugin_resource_capacity_exceeded' }),
        );

        owner.retirePlugin('acme.alpha');
        expect([...retiredDisposals.values()]).toHaveLength(ACTIVE_CONTEXT_LIMIT);
        expect([...retiredDisposals.values()].every((count) => count === 1)).toBe(true);
        const betaAfterRetire = await bind('acme.beta', 'beta-after-retire');
        expect(() => betaAfterRetire.watch('live', () => undefined)).not.toThrow();

        for (const subscription of alphaSubscriptions) subscription.dispose();
    });

    it('still delivers a change the watcher never saw after an unrelated caller already read it', async () => {
        // The defect: `observedDigest` conflated "most recently read bytes" with
        // "what watchers were told". An unrelated read of the new bytes made the
        // settlement see "unchanged" and the watcher was never told at all.
        let current = Buffer.from('A');
        let invalidate: (() => void) | null = null;
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'live')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: {
                    read: () => new Uint8Array(current),
                    observe: (notify: () => void) => {
                        invalidate = notify;
                        return { dispose: () => { invalidate = null; } };
                    },
                },
            }],
        });
        const watcherService = owner.bind({
            pluginId: 'acme.alpha', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const unrelatedService = owner.bind({
            pluginId: 'acme.alpha', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });

        const first = await watcherService.read('live');
        expect(first.digest).toBe(digest(Buffer.from('A')));

        const changes: { digest: string }[] = [];
        watcherService.watch('live', (change) => { changes.push(change); });
        await settle();
        expect(changes).toEqual([]);

        current = Buffer.from('B');
        // Some other caller — a different bound consumer of the same owner —
        // reads the new bytes first. That must not settle the invalidation the
        // watcher is still owed.
        const unrelated = await unrelatedService.read('live');
        expect(unrelated.digest).toBe(digest(Buffer.from('B')));

        invalidate!();
        await settle();

        expect(changes).toEqual([{ digest: digest(Buffer.from('B')) }]);
    });

    it('does not drop an invalidation a producer raises synchronously from observe', async () => {
        // Nothing in the producer contract forbids a synchronous first notify.
        // Establishing the subscription after `observe()` returned made that
        // notify land on an unregistered watch and be discarded.
        let current = Buffer.from('A');
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'live')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: {
                    read: () => new Uint8Array(current),
                    observe: (notify: () => void) => {
                        current = Buffer.from('B');
                        notify();
                        return { dispose: () => undefined };
                    },
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const changes: { digest: string }[] = [];
        service.watch('live', (change) => { changes.push(change); });
        await settle();

        expect(changes).toEqual([{ digest: digest(Buffer.from('B')) }]);
    });

    it('resynchronizes a watcher whose bytes changed between its read and its subscription', async () => {
        let current = Buffer.from('A');
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'live')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: {
                    read: () => new Uint8Array(current),
                    observe: () => ({ dispose: () => undefined }),
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        await service.read('live');
        current = Buffer.from('B');

        const changes: { digest: string }[] = [];
        service.watch('live', (change) => { changes.push(change); });
        await settle();

        expect(changes).toEqual([{ digest: digest(Buffer.from('B')) }]);
    });

    it('does not resynchronize a watcher that is already holding the current bytes', async () => {
        // Discriminating control for the test above: establishment must not
        // manufacture a change the observer already has.
        const bytes = Buffer.from('stable');
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'live')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: {
                    read: () => new Uint8Array(bytes),
                    observe: () => ({ dispose: () => undefined }),
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const changes: { digest: string }[] = [];
        service.watch('live', (change) => { changes.push(change); });
        await settle();

        expect(changes).toEqual([]);
    });

    it('aborts and fences an ignored-abort settlement after its final watcher closes', async () => {
        const baseline = new Uint8Array(Buffer.from('A'));
        const lateBytes = new Uint8Array(Buffer.from('B'));
        const lateSettlement = deferred<Uint8Array>();
        let reads = 0;
        let settlementSignal: AbortSignal | undefined;
        let invalidate: (() => void) | null = null;
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'live')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: {
                    read: (options?: { signal?: AbortSignal }) => {
                        reads += 1;
                        if (reads <= 2) return baseline;
                        settlementSignal = options?.signal;
                        // This intentionally ignores `signal`: cancellation
                        // correctness belongs to the Resource owner after await.
                        return lateSettlement.promise;
                    },
                    observe: (notify) => {
                        invalidate = notify;
                        return { dispose: () => undefined };
                    },
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const changes: Array<{ digest: string }> = [];
        const subscription = service.watch('live', (change) => { changes.push(change); });
        await settle(); // watch-establishment resync is read #2

        invalidate!();
        await settle(); // settlement read #3 is deliberately still pending
        expect(settlementSignal).toBeDefined();

        subscription.dispose();
        expect(settlementSignal?.aborted).toBe(true);
        lateSettlement.resolve(lateBytes);
        await settle();

        // A closed observer cannot let a late producer result overwrite the
        // retained global descriptor or create a later synthetic wakeup.
        expect(service.describe('live')).toMatchObject({ digest: digest(baseline) });
        expect(changes).toEqual([]);
        expect(reads).toBe(3);
    });

    it('does not late-admit ignored-abort settlement bytes after generation retirement', async () => {
        const empty = new Uint8Array();
        const maximum = new Uint8Array(MAX_PLUGIN_RESOURCE_BYTES);
        const lateSettlement = deferred<Uint8Array>();
        let alphaReads = 0;
        let betaProbeReads = 0;
        let settlementSignal: AbortSignal | undefined;
        let invalidate: (() => void) | null = null;
        const owner = await createStablePluginResourcesOwner({
            registry: registry([
                dynamicContribution('acme.alpha', 'live'),
                dynamicContribution('acme.beta', 'fill-0'),
                dynamicContribution('acme.beta', 'fill-1'),
                dynamicContribution('acme.beta', 'fill-2'),
                dynamicContribution('acme.beta', 'probe'),
            ]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: new Map([
                ['acme.alpha', DYNAMIC_GENERATION],
                ['acme.beta', 'immutable-beta-dynamic'],
            ]),
            dynamicProducers: [
                {
                    pluginId: 'acme.alpha',
                    localId: 'live',
                    runtime: {
                        read: (options?: { signal?: AbortSignal }) => {
                            alphaReads += 1;
                            if (alphaReads <= 2) return empty;
                            settlementSignal = options?.signal;
                            return lateSettlement.promise;
                        },
                        observe: (notify) => {
                            invalidate = notify;
                            return { dispose: () => undefined };
                        },
                    },
                },
                ...['fill-0', 'fill-1', 'fill-2'].map((localId) => ({
                    pluginId: 'acme.beta',
                    localId,
                    runtime: {
                        read: () => maximum,
                        observe: () => ({ dispose: () => undefined }),
                    },
                })),
                {
                    pluginId: 'acme.beta',
                    localId: 'probe',
                    runtime: {
                        read: () => {
                            betaProbeReads += 1;
                            return betaProbeReads === 1 ? empty : maximum;
                        },
                        observe: () => ({ dispose: () => undefined }),
                    },
                },
            ],
        });
        const alpha = owner.bind({
            pluginId: 'acme.alpha',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const beta = owner.bind({
            pluginId: 'acme.beta',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        alpha.watch('live', () => undefined);
        await settle(); // alpha watch-establishment resync is read #2
        invalidate!();
        await settle();
        expect(settlementSignal).toBeDefined();

        owner.retirePlugin('acme.alpha');
        expect(settlementSignal?.aborted).toBe(true);
        lateSettlement.resolve(maximum);
        await settle();

        // The three beta fills retain 48 MiB. The beta probe can grow from
        // zero to exactly 16 MiB only if alpha's retired late result was
        // fenced before aggregate admission.
        await expect(beta.read('probe')).resolves.toMatchObject({
            bytes: expect.any(Uint8Array),
        });
        expect(alphaReads).toBe(3);
    });

    it('wakes the digest-only convergence path once on a settlement failure and again on recovery', async () => {
        vi.useFakeTimers();
        try {
            const bytes = new Uint8Array(Buffer.from('stable'));
            let reads = 0;
            let invalidate: (() => void) | null = null;
            const owner = await createStablePluginResourcesOwner({
                registry: registry([dynamicContribution('acme.alpha', 'live')]),
                generations: new Map(),
                immutableGenerationIdsByPluginId: dynamicGenerationIds(),
                dynamicProducers: [{
                    pluginId: 'acme.alpha',
                    localId: 'live',
                    runtime: {
                        read: () => {
                            reads += 1;
                            // Admission and watch establishment are stable;
                            // one failure episode then recovers to the same
                            // digest, which still needs generic re-read wakes.
                            if (reads === 3 || reads === 4) {
                                throw new Error('temporary producer failure');
                            }
                            return bytes;
                        },
                        observe: (notify) => {
                            invalidate = notify;
                            return { dispose: () => undefined };
                        },
                    },
                }],
            });
            const service = owner.bind({
                pluginId: 'acme.alpha',
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            });
            const changes: Array<{ digest: string }> = [];
            service.watch('live', (change) => { changes.push(change); });
            await vi.advanceTimersByTimeAsync(1);

            invalidate!();
            await vi.advanceTimersByTimeAsync(1);
            expect(changes).toEqual([{ digest: digest(bytes) }]);

            await vi.advanceTimersByTimeAsync(300);
            // Repeated failures in the same episode do not make the generic
            // store churn stale/error snapshots indefinitely.
            expect(changes).toEqual([{ digest: digest(bytes) }]);

            await vi.advanceTimersByTimeAsync(300);
            expect(changes).toEqual([
                { digest: digest(bytes) },
                { digest: digest(bytes) },
            ]);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('dynamic resource producer callbacks are bounded at the boundary (EU-4b)', () => {
    it('fails admission with a bounded typed failure when a producer read never answers', async () => {
        vi.useFakeTimers();
        try {
            let admissionSignal: AbortSignal | undefined;
            const pending = createStablePluginResourcesOwner({
                registry: registry([dynamicContribution('acme.alpha', 'live')]),
                generations: new Map(),
                immutableGenerationIdsByPluginId: dynamicGenerationIds(),
                dynamicProducers: [{
                    pluginId: 'acme.alpha',
                    localId: 'live',
                    runtime: {
                        read: (options?: { signal?: AbortSignal }) => {
                            admissionSignal = options?.signal;
                            return new Promise<Uint8Array>(() => undefined);
                        },
                        observe: () => ({ dispose: () => undefined }),
                    },
                }],
            });
            let settled: unknown = 'still pending';
            void pending.then(
                () => { settled = 'admitted'; },
                (error: unknown) => { settled = error; },
            );
            await vi.advanceTimersByTimeAsync(60_000);
            for (let flush = 0; flush < 10; flush += 1) await Promise.resolve();

            expect(settled).toMatchObject({ code: 'plugin_resource_producer_timed_out' });
            expect(admissionSignal?.aborted).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it('normalizes a producer that throws from observe into a typed resource failure', async () => {
        let observeCalls = 0;
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'live')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: {
                    read: () => new Uint8Array(Buffer.from('A')),
                    observe: () => {
                        observeCalls += 1;
                        throw new Error('producer exploded');
                    },
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });

        expect(() => service.watch('live', () => undefined)).toThrowError(
            expect.objectContaining({ code: 'plugin_resource_producer_invalid' }),
        );
        // The failed establishment must not leave a poisoned watch behind: a
        // second attempt reaches the producer again rather than silently
        // joining a subscription that never existed.
        expect(() => service.watch('live', () => undefined)).toThrowError(
            expect.objectContaining({ code: 'plugin_resource_producer_invalid' }),
        );
        expect(observeCalls).toBe(2);
    });

    it('rejects a producer subscription that is not disposable', async () => {
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'live')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: {
                    read: () => new Uint8Array(Buffer.from('A')),
                    observe: () => (undefined as unknown as Disposable),
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });

        expect(() => service.watch('live', () => undefined)).toThrowError(
            expect.objectContaining({ code: 'plugin_resource_producer_invalid' }),
        );
    });

    it('disposes a producer subscription once across repeated, late and retirement disposal', async () => {
        let disposals = 0;
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'live')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'live',
                runtime: {
                    read: () => new Uint8Array(Buffer.from('A')),
                    observe: () => ({
                        dispose: () => {
                            disposals += 1;
                            throw new Error('producer disposal exploded');
                        },
                    }),
                },
            }],
        });
        const service = owner.bind({
            pluginId: 'acme.alpha', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });
        const subscription = service.watch('live', () => undefined);
        await settle();

        expect(() => subscription.dispose()).not.toThrow();
        expect(() => subscription.dispose()).not.toThrow();
        expect(() => owner.retirePlugin('acme.alpha')).not.toThrow();
        expect(() => subscription.dispose()).not.toThrow();
        expect(disposals).toBe(1);
    });
});

describe('dynamic resource reads stay inside the aggregate byte bound (EU-4b)', () => {
    it('bounds later dynamic reads by size delta and retains the last known good descriptor', async () => {
        // The aggregate was only ever checked against the admission snapshot,
        // so producers could grow past 64 MiB afterwards while `describe` kept
        // reporting the new sizes.
        const admittedBytes = 12 * 1024 * 1024;
        const grownBytes = MAX_PLUGIN_RESOURCE_BYTES;
        const admitted = Buffer.alloc(admittedBytes, 1);
        const grown = Buffer.alloc(grownBytes, 2);
        const localIds = ['r0', 'r1', 'r2', 'r3', 'r4'];
        expect(localIds.length * admittedBytes).toBeLessThanOrEqual(MAX_PLUGIN_RESOURCE_AGGREGATE_BYTES);
        const currentById = new Map(localIds.map((localId) => [localId, admitted]));
        const producers: StableDynamicPluginResourceProducer[] = localIds.map((localId) => ({
            pluginId: 'acme.alpha',
            localId,
            runtime: {
                read: () => new Uint8Array(currentById.get(localId)!),
                observe: () => ({ dispose: () => undefined }),
            },
        }));
        const owner = await createStablePluginResourcesOwner({
            registry: registry(
                localIds.map((localId) => dynamicContribution('acme.alpha', localId)),
            ),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: producers,
        });
        const service = owner.bind({
            pluginId: 'acme.alpha', signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        });

        // 60 MiB admitted; growing one resource to 16 MiB lands exactly on the
        // 64 MiB bound and must be admitted.
        currentById.set('r0', grown);
        const grownRead = await service.read('r0');
        expect(grownRead.bytes.byteLength).toBe(grownBytes);
        expect(service.describe('r0').size).toBe(grownBytes);

        // The next 4 MiB of growth breaches the aggregate bound.
        currentById.set('r1', grown);
        // Captured rather than asserted through `rejects`: on the RED run the
        // read resolves with 16 MiB of bytes and a matcher diff of that payload
        // exhausts the worker heap.
        const outcome = await service.read('r1').then(
            () => 'resolved' as const,
            (error: unknown) => error,
        );
        expect(outcome).toMatchObject({ code: 'plugin_resource_capacity_exceeded' });
        expect(service.describe('r1')).toMatchObject({
            size: admittedBytes,
            digest: digest(new Uint8Array(admitted)),
        });
    });
});

describe('surface-scoped dynamic Resources (SDK-EU-28)', () => {
    it('rejects a surface binding without its host-stamped launch input before invoking its producer', async () => {
        const read = vi.fn(() => new Uint8Array(Buffer.from('unexpected')));
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'targeted-document', 'surface')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'targeted-document',
                runtime: {
                    read,
                    observe: () => ({ dispose: () => undefined }),
                },
            }],
        });

        await expect(owner.bindForResource({
            pluginId: 'acme.alpha',
            resourceId: 'targeted-document',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
            context: {
                kind: 'surface',
                mountInstanceKey: 'target/acme.target/point/contributor/detail/entry-7',
            // Boundary fixture: exercise the runtime's invalid external input
            // rejection before it can reach a dynamic Resource producer.
            } as unknown as PluginResourceContextV1,
        })).rejects.toMatchObject({ code: 'plugin_resource_context_unavailable' });
        expect(read).not.toHaveBeenCalled();
    });

    it('admits only the host Resource path and atomically replaces a same-instance launch input', async () => {
        const observedContexts: unknown[] = [];
        const read = vi.fn((options: Readonly<{ context: unknown }>) => {
            observedContexts.push(options.context);
            if (
                typeof options.context !== 'object'
                || options.context === null
                || !('kind' in options.context)
                || options.context.kind !== 'surface'
                || !('launchInput' in options.context)
            ) {
                throw new Error('surface context was not stamped');
            }
            return new Uint8Array(Buffer.from(JSON.stringify(options.context.launchInput)));
        });
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'targeted-document', 'surface')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'targeted-document',
                runtime: {
                    read,
                    observe: () => ({ dispose: () => undefined }),
                },
            }],
        });
        const common = {
            pluginId: 'acme.alpha',
            resourceId: 'targeted-document',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        };

        // `bind` is the raw Resource service path. A surface scope is not a
        // caller-selectable contextual Resource and cannot start its producer.
        const raw = owner.bind({
            ...common,
            context: {
                kind: 'surface',
                mountInstanceKey: 'target/acme.target/point/contributor/detail/entry-7',
                launchInput: { revision: 1 },
            },
        });
        await expect(raw.read('targeted-document')).rejects.toMatchObject({
            code: 'plugin_resource_context_unavailable',
        });
        expect(read).not.toHaveBeenCalled();

        await expect(owner.bindForResource({ ...common })).rejects.toMatchObject({
            code: 'plugin_resource_context_unavailable',
        });
        await expect(owner.bindForResource({
            ...common,
            context: { kind: 'global' },
        })).rejects.toMatchObject({
            code: 'plugin_resource_context_unavailable',
        });
        expect(read).not.toHaveBeenCalled();

        const first = await owner.bindForResource({
            ...common,
            context: {
                kind: 'surface',
                mountInstanceKey: 'target/acme.target/point/contributor/detail/entry-7',
                launchInput: { revision: 1 },
            },
        });
        await expect(first.read('targeted-document')).resolves.toMatchObject({
            bytes: new Uint8Array(Buffer.from('{"revision":1}')),
        });

        // An existing mount state is not a capability. Otherwise a raw
        // service caller could wait for a host mount and then replay its
        // context without the host-private binding proof.
        const replayedRaw = owner.bind({
            ...common,
            context: {
                kind: 'surface',
                mountInstanceKey: 'target/acme.target/point/contributor/detail/entry-7',
                launchInput: { revision: 1 },
            },
        });
        await expect(replayedRaw.read('targeted-document')).rejects.toMatchObject({
            code: 'plugin_resource_context_unavailable',
        });
        expect(read).toHaveBeenCalledTimes(1);

        const replacement = await owner.bindForResource({
            ...common,
            context: {
                kind: 'surface',
                mountInstanceKey: 'target/acme.target/point/contributor/detail/entry-7',
                launchInput: { revision: 2 },
            },
        });
        await expect(replacement.read('targeted-document')).resolves.toMatchObject({
            bytes: new Uint8Array(Buffer.from('{"revision":2}')),
        });

        // A replacement input is not merged into, or served through, the old
        // mount context: late work from it is stale before it reaches author code.
        await expect(first.read('targeted-document')).rejects.toMatchObject({
            code: 'plugin_resource_context_unavailable',
        });
        expect(observedContexts).toEqual([
            {
                kind: 'surface',
                mountInstanceKey: 'target/acme.target/point/contributor/detail/entry-7',
                launchInput: { revision: 1 },
            },
            {
                kind: 'surface',
                mountInstanceKey: 'target/acme.target/point/contributor/detail/entry-7',
                launchInput: { revision: 2 },
            },
        ]);
    });

    it('aborts and fences an old surface watch before a replacement can admit late bytes', async () => {
        const baseline = new Uint8Array(Buffer.from('baseline'));
        const replacementBytes = new Uint8Array(Buffer.from('replacement'));
        const lateSettlement = deferred<Uint8Array>();
        let firstRevisionReads = 0;
        let invalidate: (() => void) | undefined;
        let settlementSignal: AbortSignal | undefined;
        let observeSignal: AbortSignal | undefined;
        let disposals = 0;
        const owner = await createStablePluginResourcesOwner({
            registry: registry([dynamicContribution('acme.alpha', 'targeted-document', 'surface')]),
            generations: new Map(),
            immutableGenerationIdsByPluginId: dynamicGenerationIds(),
            dynamicProducers: [{
                pluginId: 'acme.alpha',
                localId: 'targeted-document',
                runtime: {
                    read: (options) => {
                        if (options.context.kind !== 'surface') throw new Error('surface context was not stamped');
                        const launchInput = options.context.launchInput;
                        const launchInputRecord = launchInput !== null
                            && typeof launchInput === 'object'
                            && !Array.isArray(launchInput)
                            ? launchInput as Readonly<Record<string, unknown>>
                            : null;
                        const revision = launchInputRecord?.revision;
                        if (revision === 2) return replacementBytes;
                        firstRevisionReads += 1;
                        if (firstRevisionReads <= 2) return baseline;
                        settlementSignal = options.signal;
                        // Deliberately ignore abort. The Resource context owner
                        // must fence this late result after mount replacement.
                        return lateSettlement.promise;
                    },
                    observe: (notify, options) => {
                        observeSignal = options.context.kind === 'surface' ? options.signal : undefined;
                        invalidate = notify;
                        return {
                            dispose: () => { disposals += 1; },
                        };
                    },
                },
            }],
        });
        const common = {
            pluginId: 'acme.alpha',
            resourceId: 'targeted-document',
            signal: new AbortController().signal,
            isGenerationCurrent: () => true,
        };
        const first = await owner.bindForResource({
            ...common,
            context: {
                kind: 'surface',
                mountInstanceKey: 'target/acme.target/point/contributor/detail/entry-7',
                launchInput: { revision: 1 },
            },
        });
        await first.read('targeted-document');
        const changes: Array<{ digest: string }> = [];
        first.watch('targeted-document', (change) => { changes.push(change); });
        await settle(); // existing snapshot causes the canonical watch resync

        invalidate!();
        await settle();
        expect(settlementSignal).toBeDefined();

        const replacement = await owner.bindForResource({
            ...common,
            context: {
                kind: 'surface',
                mountInstanceKey: 'target/acme.target/point/contributor/detail/entry-7',
                launchInput: { revision: 2 },
            },
        });
        expect(settlementSignal?.aborted).toBe(true);
        expect(observeSignal?.aborted).toBe(true);
        expect(disposals).toBe(1);

        lateSettlement.resolve(new Uint8Array(Buffer.from('late')));
        await settle();

        await expect(first.read('targeted-document')).rejects.toMatchObject({
            code: 'plugin_resource_context_unavailable',
        });
        await expect(replacement.read('targeted-document')).resolves.toMatchObject({
            bytes: replacementBytes,
        });
        expect(changes).toEqual([]);
    });
});
