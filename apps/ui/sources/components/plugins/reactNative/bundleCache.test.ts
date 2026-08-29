import { describe, expect, it, vi } from 'vitest';

import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
} from '@happier-dev/protocol/plugins/ui';

import { derivePluginUiPersistentArtifactKey } from '@/sync/domains/plugins/ui/artifactByteCache';

import {
    createPluginReactNativeArtifactLeaseCacheSink,
    createPluginReactNativeArtifactLeasePersistentScope,
    createPluginReactNativeBundleCache,
    derivePluginReactNativeBundleCacheKey,
    derivePluginReactNativePersistentArtifactKey,
    type PluginReactNativePersistentArtifactRecord,
    type PluginReactNativePersistentArtifactStore,
    type PluginReactNativeBundleCacheIdentity,
} from './bundleCache';

const identity = {
    pluginId: 'acme.preview',
    contributionId: 'native-preview',
    artifactDigest: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    hostAppVersion: '2.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.0.0',
    reactNativeVersion: '0.83.4',
    expoRuntimeVersion: '0.2.0-native',
    hermesVersion: '0.15.0',
    platform: 'ios',
    channel: 'internal',
    nativeCapabilitiesDigest: 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    projectionGeneration: 12,
} as const;

const persistentIdentity = {
    accountScope: { serverId: 'server-a', accountId: 'account-a' },
    releaseVersion: '1.2.3',
    pluginId: identity.pluginId,
    contributionId: identity.contributionId,
    tier: 'reactNative',
    platform: identity.platform,
    artifactDigest: identity.artifactDigest,
} as const;

function fileSetDigestFor(relativePath: string, bytes: Uint8Array) {
    return computePluginUiArtifactFileSetSha256DigestV1([{ relativePath, bytes }]);
}

/**
 * Every persisted record is the Artifact-owned exact file graph. A one-file
 * artifact is that graph with a single declared entry, never an entry-only
 * record.
 */
function singleFileRecord(
    identity: PluginReactNativePersistentArtifactRecord['persistentIdentity'],
    relativePath: string,
    bytes: Uint8Array,
): PluginReactNativePersistentArtifactRecord {
    return {
        persistentIdentity: identity,
        bytes,
        entryRelativePath: relativePath,
        files: [{
            relativePath,
            digest: computePluginUiArtifactSha256DigestV1(bytes),
            byteSize: bytes.byteLength,
            bytes,
        }],
    };
}

function createMemoryPersistentArtifactStore() {
    const records = new Map<string, PluginReactNativePersistentArtifactRecord>();
    const reads: string[] = [];
    const writes: string[] = [];
    const removals: string[] = [];
    const store: PluginReactNativePersistentArtifactStore = {
        read: async (requestedIdentity) => {
            const key = derivePluginReactNativePersistentArtifactKey(requestedIdentity);
            reads.push(key);
            return records.get(key) ?? null;
        },
        write: async (record) => {
            const key = derivePluginReactNativePersistentArtifactKey(record.persistentIdentity);
            writes.push(key);
            records.set(key, record);
        },
        remove: async (requestedIdentity) => {
            const key = derivePluginUiPersistentArtifactKey(requestedIdentity);
            removals.push(key);
            records.delete(key);
        },
        removeAccount: async (scope) => {
            for (const [key, record] of records.entries()) {
                if (
                    record.persistentIdentity.accountScope.serverId === scope.serverId
                    && record.persistentIdentity.accountScope.accountId === scope.accountId
                ) {
                    records.delete(key);
                    removals.push(key);
                }
            }
        },
    };
    return { store, records, reads, writes, removals };
}

describe('React Native bundle cache', () => {
    it('does not expose a second Artifact byte-fetch path from the cache owner', async () => {
        const cacheModule = await import('./bundleCache');

        expect(cacheModule).not.toHaveProperty('preloadReactNativeInstalledArtifactBytes');
    });

    it('selects the Tauri Artifact store and registrar ahead of CacheStorage on desktop', async () => {
        const originalCaches = Object.getOwnPropertyDescriptor(globalThis, 'caches');
        const originalTauriInternals = Object.getOwnPropertyDescriptor(globalThis, '__TAURI_INTERNALS__');
        const createBrowserStore = vi.fn(() => ({
            read: async () => null,
            write: async () => undefined,
            remove: async () => undefined,
            removeAccount: async () => undefined,
        }));
        const createTauriStore = vi.fn(() => ({
            read: async () => null,
            write: async () => undefined,
            remove: async () => undefined,
            removeAccount: async () => undefined,
            describeNativeResource: async () => null,
        }));
        const createTauriRegistrar = vi.fn(() => ({
            register: async () => ({ kind: 'registered' as const }),
            unregister: () => true,
        }));

        try {
            Object.defineProperty(globalThis, 'caches', {
                configurable: true,
                value: {},
            });
            Object.defineProperty(globalThis, '__TAURI_INTERNALS__', {
                configurable: true,
                value: { invoke: () => undefined },
            });
            vi.resetModules();
            vi.doMock('@/sync/domains/plugins/ui/artifactByteCache.browser', () => ({
                createBrowserPluginUiPersistentArtifactStore: createBrowserStore,
            }));
            vi.doMock('@/sync/domains/plugins/ui/artifactByteCache.tauri', () => ({
                createTauriPluginUiPersistentArtifactStore: createTauriStore,
            }));
            vi.doMock('@/sync/domains/plugins/availability/nativeArtifactResourceRegistrar.tauri', () => ({
                createTauriPluginNativeArtifactResourceRegistrar: createTauriRegistrar,
            }));

            const cacheModule = await import('./bundleCache');

            expect(createTauriStore).toHaveBeenCalledOnce();
            expect(createTauriRegistrar).toHaveBeenCalledOnce();
            expect(createBrowserStore).not.toHaveBeenCalled();
            expect(cacheModule.getInstalledPluginNativeArtifactResources()).not.toBeNull();
        } finally {
            vi.doUnmock('@/sync/domains/plugins/ui/artifactByteCache.browser');
            vi.doUnmock('@/sync/domains/plugins/ui/artifactByteCache.tauri');
            vi.doUnmock('@/sync/domains/plugins/availability/nativeArtifactResourceRegistrar.tauri');
            vi.resetModules();
            if (originalCaches) {
                Object.defineProperty(globalThis, 'caches', originalCaches);
            } else {
                delete (globalThis as { caches?: unknown }).caches;
            }
            if (originalTauriInternals) {
                Object.defineProperty(globalThis, '__TAURI_INTERNALS__', originalTauriInternals);
            } else {
                delete (globalThis as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
            }
        }
    });

    it('adapts only the current Account lifetime into the canonical Artifact lease cache interfaces', async () => {
        const persistent = createMemoryPersistentArtifactStore();
        const cache = createPluginReactNativeBundleCache({ persistentStore: persistent.store });
        const bytes = new TextEncoder().encode('// canonical lease bytes');
        const fileDigest = computePluginUiArtifactSha256DigestV1(bytes);
        const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
            { relativePath: 'native/index.js', bytes },
        ]);
        const runtimeIdentity = { ...identity, artifactDigest };
        const stableIdentity = { ...persistentIdentity, artifactDigest };
        let current = true;
        let retire: (() => void) | null = null;
        const lifetime = {
            scope: stableIdentity.accountScope,
            isCurrent: () => current,
            onRetire: (cancel: () => void) => {
                retire = cancel;
                return { dispose: () => undefined };
            },
        };
        const cacheSink = createPluginReactNativeArtifactLeaseCacheSink({ cache, lifetime });
        const persistentScope = createPluginReactNativeArtifactLeasePersistentScope({ cache, lifetime });

        expect(cacheSink.writeVerifiedArtifact({
            identity: runtimeIdentity,
            accountScope: stableIdentity.accountScope,
            bytes,
            entryRelativePath: 'native/index.js',
            files: [{
                relativePath: 'native/index.js',
                digest: fileDigest,
                byteSize: bytes.byteLength,
                bytes,
            }],
        })).toEqual({
            ok: true,
            cacheKey: derivePluginReactNativeBundleCacheKey(runtimeIdentity),
        });
        await persistentScope.store.write({
            persistentIdentity: stableIdentity,
            bytes,
            entryRelativePath: 'native/index.js',
            files: [{
                relativePath: 'native/index.js',
                digest: fileDigest,
                byteSize: bytes.byteLength,
                bytes,
            }],
        });
        expect(await persistentScope.store.read(stableIdentity)).toMatchObject({ bytes });
        expect(persistentScope.isCurrent()).toBe(true);

        current = false;
        const retireNow = retire as (() => void) | null;
        retireNow?.();

        expect(persistentScope.isCurrent()).toBe(false);
        expect(cacheSink.writeVerifiedArtifact({
            identity: runtimeIdentity,
            accountScope: stableIdentity.accountScope,
            bytes,
            entryRelativePath: 'native/index.js',
            files: [{
                relativePath: 'native/index.js',
                digest: fileDigest,
                byteSize: bytes.byteLength,
                bytes,
            }],
        })).toMatchObject({ ok: false, code: 'artifact_cache_write_invalidated' });
        await expect(persistentScope.store.read(stableIdentity)).resolves.toBeNull();
        persistentScope.release();
    });

    it('keeps exact persistent removal available after its Artifact source operation releases', async () => {
        const persistent = createMemoryPersistentArtifactStore();
        const cache = createPluginReactNativeBundleCache({ persistentStore: persistent.store });
        const lifetime = {
            scope: persistentIdentity.accountScope,
            isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }),
        };
        const persistentScope = createPluginReactNativeArtifactLeasePersistentScope({ cache, lifetime });
        persistent.records.set(
            derivePluginReactNativePersistentArtifactKey(persistentIdentity),
            singleFileRecord(persistentIdentity, 'index.bundle', new Uint8Array([1])),
        );

        persistentScope.release();
        await persistentScope.store.remove(persistentIdentity);

        expect(persistent.removals).toEqual([
            derivePluginReactNativePersistentArtifactKey(persistentIdentity),
        ]);
        expect(persistent.records.has(derivePluginReactNativePersistentArtifactKey(persistentIdentity))).toBe(false);
    });

    it('orders captured Artifact reads behind an exact-key removal', async () => {
        const persistent = createMemoryPersistentArtifactStore();
        const bytes = new TextEncoder().encode('// captured read ordering');
        const identity = {
            ...persistentIdentity,
            artifactDigest: fileSetDigestFor('index.bundle', bytes),
        };
        const key = derivePluginReactNativePersistentArtifactKey(identity);
        persistent.records.set(key, singleFileRecord(identity, 'index.bundle', bytes));
        let beginRemoval!: () => void;
        const removalBegan = new Promise<void>((resolve) => {
            beginRemoval = resolve;
        });
        let allowRemoval!: () => void;
        const removalGate = new Promise<void>((resolve) => {
            allowRemoval = resolve;
        });
        const cache = createPluginReactNativeBundleCache({
            persistentStore: {
                ...persistent.store,
                remove: async (requestedIdentity) => {
                    beginRemoval();
                    await removalGate;
                    await persistent.store.remove(requestedIdentity);
                },
            },
        });
        const lifetime = {
            scope: identity.accountScope,
            isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }),
        };
        const scope = createPluginReactNativeArtifactLeasePersistentScope({ cache, lifetime });

        const removal = cache.removePersistentArtifact(identity);
        await removalBegan;
        const read = scope.store.read(identity);
        expect(persistent.reads).toEqual([]);

        allowRemoval();
        await removal;
        await expect(read).resolves.toBeNull();
        scope.release();
    });

    it('orders captured Artifact writes behind an exact-key removal', async () => {
        const persistent = createMemoryPersistentArtifactStore();
        const bytes = new TextEncoder().encode('// captured write ordering');
        const identity = {
            ...persistentIdentity,
            artifactDigest: fileSetDigestFor('index.bundle', bytes),
        };
        let beginRemoval!: () => void;
        const removalBegan = new Promise<void>((resolve) => {
            beginRemoval = resolve;
        });
        let allowRemoval!: () => void;
        const removalGate = new Promise<void>((resolve) => {
            allowRemoval = resolve;
        });
        const cache = createPluginReactNativeBundleCache({
            persistentStore: {
                ...persistent.store,
                remove: async (requestedIdentity) => {
                    beginRemoval();
                    await removalGate;
                    await persistent.store.remove(requestedIdentity);
                },
            },
        });
        const lifetime = {
            scope: identity.accountScope,
            isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }),
        };
        const scope = createPluginReactNativeArtifactLeasePersistentScope({ cache, lifetime });

        const removal = cache.removePersistentArtifact(identity);
        await removalBegan;
        const write = scope.store.write(singleFileRecord(identity, 'index.bundle', bytes));
        expect(persistent.writes).toEqual([]);

        allowRemoval();
        await removal;
        await expect(write).resolves.toBeUndefined();
        expect(persistent.records.get(derivePluginReactNativePersistentArtifactKey(identity))).toMatchObject({ bytes });
        scope.release();
    });

    it('reports a persistent write failure instead of claiming bytes were stored', async () => {
        const persistent = createMemoryPersistentArtifactStore();
        const diagnostics: string[] = [];
        const bytes = new TextEncoder().encode('// failed persistent write');
        const writeIdentity = {
            ...persistentIdentity,
            artifactDigest: fileSetDigestFor('index.bundle', bytes),
        };
        const cache = createPluginReactNativeBundleCache({
            persistentStore: {
                ...persistent.store,
                write: async () => {
                    throw new Error('storage unavailable');
                },
            },
            onPersistentCacheDiagnostic: (code) => diagnostics.push(code),
        });

        await expect(cache.writePersistentArtifact(
            singleFileRecord(writeIdentity, 'index.bundle', bytes),
        )).resolves.toBe(false);
        expect(diagnostics).toEqual(['plugin_ui_artifact_cache_write_failed']);
        expect(persistent.records.has(
            derivePluginReactNativePersistentArtifactKey(writeIdentity),
        )).toBe(false);
    });

    it('retains verified persistent Artifact bytes through an A-to-B-to-A Account lifetime transition', async () => {
        const persistent = createMemoryPersistentArtifactStore();
        const bytes = new TextEncoder().encode('// retained Account cache bytes');
        const retainedIdentity = {
            ...persistentIdentity,
            artifactDigest: fileSetDigestFor('index.bundle', bytes),
        };
        const runtimeIdentity = {
            ...identity,
            artifactDigest: retainedIdentity.artifactDigest,
        };
        const accountB = {
            ...retainedIdentity,
            accountScope: { serverId: 'server-a', accountId: 'account-b' },
        };
        const retainedKey = derivePluginReactNativePersistentArtifactKey(retainedIdentity);
        const evictedIdentityBatches: PluginReactNativeBundleCacheIdentity[][] = [];
        const cache = createPluginReactNativeBundleCache({
            persistentStore: persistent.store,
            diskGc: {
                evictForIdentities: async (identities) => {
                    evictedIdentityBatches.push([...identities]);
                },
            },
        });

        await expect(cache.writePersistentArtifact({
            ...singleFileRecord(retainedIdentity, 'index.bundle', bytes),
        })).resolves.toBe(true);
        expect(cache.putInstalledArtifact({
            identity: runtimeIdentity,
            accountScope: retainedIdentity.accountScope,
            bytes,
            format: 'plainJs',
        }).ok).toBe(true);

        await cache.retireAccount(retainedIdentity.accountScope);
        await Promise.resolve();

        expect(cache.isAccountCurrent(retainedIdentity.accountScope)).toBe(false);
        expect(cache.readInstalledArtifact(runtimeIdentity)).toBeNull();
        expect(evictedIdentityBatches).toEqual([[runtimeIdentity]]);
        expect(persistent.records.has(retainedKey)).toBe(true);
        expect(persistent.removals).toEqual([]);

        cache.bindAccountLifetime({
            scope: accountB.accountScope,
            isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }),
        });
        cache.bindAccountLifetime({
            scope: retainedIdentity.accountScope,
            isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }),
        });

        expect(cache.isAccountCurrent(retainedIdentity.accountScope)).toBe(true);
        await expect(cache.readPersistentArtifact(retainedIdentity)).resolves.toMatchObject({
            persistentIdentity: retainedIdentity,
            bytes,
        });
    });

    it('does not delete verified persistent bytes when an old Account write settles after retirement', async () => {
        const persistent = createMemoryPersistentArtifactStore();
        const bytes = new TextEncoder().encode('// delayed stale Account write');
        const delayedIdentity = {
            ...persistentIdentity,
            artifactDigest: fileSetDigestFor('index.bundle', bytes),
        };
        const delayedPersistentKey = derivePluginReactNativePersistentArtifactKey(delayedIdentity);
        let beginWrite!: () => void;
        const writeBegan = new Promise<void>((resolve) => {
            beginWrite = resolve;
        });
        let allowWrite!: () => void;
        const writeGate = new Promise<void>((resolve) => {
            allowWrite = resolve;
        });
        const removeAccount = vi.fn(persistent.store.removeAccount);
        const cache = createPluginReactNativeBundleCache({
            persistentStore: {
                ...persistent.store,
                removeAccount,
                write: async (record) => {
                    beginWrite();
                    await writeGate;
                    await persistent.store.write(record);
                },
            },
        });

        const staleWrite = cache.writePersistentArtifact(
            singleFileRecord(delayedIdentity, 'index.bundle', bytes),
        );
        await writeBegan;

        await cache.retireAccount(delayedIdentity.accountScope);
        cache.bindAccountLifetime({
            scope: delayedIdentity.accountScope,
            isCurrent: () => true,
            onRetire: () => ({ dispose: () => undefined }),
        });

        allowWrite();

        await expect(staleWrite).resolves.toBe(false);
        await Promise.resolve();
        expect(removeAccount).not.toHaveBeenCalled();
        expect(persistent.records.has(delayedPersistentKey)).toBe(true);
        await expect(cache.readPersistentArtifact(delayedIdentity)).resolves.toMatchObject({
            persistentIdentity: delayedIdentity,
            bytes,
        });
    });

    it('writes re-admitted exact bytes after a stale projection deletion has drained', async () => {
        const persistent = createMemoryPersistentArtifactStore();
        const bytes = new TextEncoder().encode('// re-admitted exact Artifact bytes');
        const reAdmittedIdentity = {
            ...persistentIdentity,
            artifactDigest: fileSetDigestFor('index.bundle', bytes),
        };
        const key = derivePluginReactNativePersistentArtifactKey(reAdmittedIdentity);
        persistent.records.set(key, singleFileRecord(reAdmittedIdentity, 'index.bundle', bytes));
        let beginRemoval!: () => void;
        const removalBegan = new Promise<void>((resolve) => {
            beginRemoval = resolve;
        });
        let allowRemoval!: () => void;
        const removalGate = new Promise<void>((resolve) => {
            allowRemoval = resolve;
        });
        const cache = createPluginReactNativeBundleCache({
            persistentStore: {
                ...persistent.store,
                remove: async (identity) => {
                    beginRemoval();
                    await removalGate;
                    await persistent.store.remove(identity);
                },
            },
        });
        let replacementCurrent = true;

        const staleRemoval = cache.removePersistentArtifact(
            reAdmittedIdentity,
            () => replacementCurrent,
        );
        await removalBegan;

        // A is current again while B's old physical deletion is still in the
        // storage adapter. The cache must serialize the new write after that
        // exact deletion rather than let the stale remove erase A's record.
        replacementCurrent = false;
        const reAdmittedWrite = cache.writePersistentArtifact(
            singleFileRecord(reAdmittedIdentity, 'index.bundle', bytes),
        );

        allowRemoval();
        await staleRemoval;
        await expect(reAdmittedWrite).resolves.toBe(true);
        await expect(cache.readPersistentArtifact(reAdmittedIdentity)).resolves.toMatchObject({
            persistentIdentity: reAdmittedIdentity,
            bytes,
        });
    });

    it('does not re-adopt an exact persistent Artifact through a cache read while its stale deletion drains', async () => {
        const persistent = createMemoryPersistentArtifactStore();
        const bytes = new TextEncoder().encode('// delayed persistent re-adoption read');
        const reAdmittedIdentity = {
            ...persistentIdentity,
            artifactDigest: fileSetDigestFor('index.bundle', bytes),
        };
        const key = derivePluginReactNativePersistentArtifactKey(reAdmittedIdentity);
        persistent.records.set(key, singleFileRecord(reAdmittedIdentity, 'index.bundle', bytes));
        let beginRemoval!: () => void;
        const removalBegan = new Promise<void>((resolve) => {
            beginRemoval = resolve;
        });
        let allowRemoval!: () => void;
        const removalGate = new Promise<void>((resolve) => {
            allowRemoval = resolve;
        });
        const cache = createPluginReactNativeBundleCache({
            persistentStore: {
                ...persistent.store,
                remove: async (identity) => {
                    beginRemoval();
                    await removalGate;
                    await persistent.store.remove(identity);
                },
            },
        });

        const staleRemoval = cache.removePersistentArtifact(reAdmittedIdentity);
        await removalBegan;

        // Read re-adoption shares the same exact-key ordering as writes. It
        // must not return bytes that the already-revoked removal will erase.
        const reAdmittedRead = cache.readPersistentArtifact(reAdmittedIdentity);
        expect(persistent.reads).toEqual([]);

        allowRemoval();
        await staleRemoval;
        await expect(reAdmittedRead).resolves.toBeNull();
        expect(persistent.reads).toEqual([
            derivePluginReactNativePersistentArtifactKey(reAdmittedIdentity),
        ]);
    });

    it('writes a valid exact Artifact only after its corrupt predecessor deletion has drained', async () => {
        const persistent = createMemoryPersistentArtifactStore();
        const validBytes = new TextEncoder().encode('// valid exact Artifact after corrupt cache entry');
        const identity = {
            ...persistentIdentity,
            artifactDigest: fileSetDigestFor('index.bundle', validBytes),
        };
        const key = derivePluginReactNativePersistentArtifactKey(identity);
        // Same identity but invalid content makes the cache reader start its
        // corrupt-entry exact deletion.
        persistent.records.set(key, singleFileRecord(
            identity,
            'index.bundle',
            new TextEncoder().encode('// corrupt cached Artifact bytes'),
        ));
        let beginCorruptRemoval!: () => void;
        const corruptRemovalBegan = new Promise<void>((resolve) => {
            beginCorruptRemoval = resolve;
        });
        let allowCorruptRemoval!: () => void;
        const corruptRemovalGate = new Promise<void>((resolve) => {
            allowCorruptRemoval = resolve;
        });
        const cache = createPluginReactNativeBundleCache({
            persistentStore: {
                ...persistent.store,
                remove: async (requestedIdentity) => {
                    beginCorruptRemoval();
                    await corruptRemovalGate;
                    await persistent.store.remove(requestedIdentity);
                },
            },
        });

        const corruptRead = cache.readPersistentArtifact(identity);
        await corruptRemovalBegan;

        // A later valid A must join the cache owner's pending exact deletion,
        // not write bytes that the earlier corrupt-delete will erase.
        const validWrite = cache.writePersistentArtifact(
            singleFileRecord(identity, 'index.bundle', validBytes),
        );
        allowCorruptRemoval();

        await expect(corruptRead).resolves.toBeNull();
        await expect(validWrite).resolves.toBe(true);
        await expect(cache.readPersistentArtifact(identity)).resolves.toMatchObject({
            persistentIdentity: identity,
            bytes: validBytes,
        });
    });

    it('retires only the exact identity when its physical deletion fails and keeps every other Account entry', async () => {
        const persistent = createMemoryPersistentArtifactStore();
        const diagnostics: string[] = [];
        const failedBytes = new TextEncoder().encode('// exact deletion failure');
        const failedIdentity = {
            ...persistentIdentity,
            artifactDigest: fileSetDigestFor('index.bundle', failedBytes),
        };
        const failedKey = derivePluginReactNativePersistentArtifactKey(failedIdentity);
        persistent.records.set(failedKey, singleFileRecord(failedIdentity, 'index.bundle', failedBytes));

        const neighborBytes = new TextEncoder().encode('// unrelated Account entry');
        const neighborIdentity = {
            ...persistentIdentity,
            contributionId: 'native-neighbor',
            artifactDigest: fileSetDigestFor('index.bundle', neighborBytes),
        };
        const neighborKey = derivePluginReactNativePersistentArtifactKey(neighborIdentity);
        persistent.records.set(neighborKey, singleFileRecord(neighborIdentity, 'index.bundle', neighborBytes));

        let exactRemovalFails = true;
        const removeAccount = vi.fn(persistent.store.removeAccount);
        const cache = createPluginReactNativeBundleCache({
            persistentStore: {
                ...persistent.store,
                remove: async (identity) => {
                    if (exactRemovalFails) throw new Error('exact persistent deletion failed');
                    await persistent.store.remove(identity);
                },
                removeAccount,
            },
            onPersistentCacheDiagnostic: (code) => diagnostics.push(code),
        });

        await cache.removePersistentArtifact(failedIdentity);

        // One bad entry must never escalate into destroying the Account cache.
        expect(removeAccount).not.toHaveBeenCalled();
        expect(diagnostics).toEqual(['plugin_ui_artifact_cache_delete_failed']);
        expect(persistent.records.has(neighborKey)).toBe(true);
        await expect(cache.readPersistentArtifact(neighborIdentity)).resolves.toMatchObject({
            persistentIdentity: neighborIdentity,
            bytes: neighborBytes,
        });

        // The exact identity is retired from lookup without a raw read while
        // its physical deletion is still owed.
        const rawReadsBeforeQuarantinedRead = persistent.reads.length;
        await expect(cache.readPersistentArtifact(failedIdentity)).resolves.toBeNull();
        expect(persistent.reads).toHaveLength(rawReadsBeforeQuarantinedRead);

        // Storage recovers: the owed deletion is retried for that exact entry,
        // the neighbouring entry is still untouched, and lookup reopens.
        exactRemovalFails = false;
        await expect(cache.readPersistentArtifact(failedIdentity)).resolves.toBeNull();
        await vi.waitFor(() => {
            expect(persistent.records.has(failedKey)).toBe(false);
        });
        expect(persistent.records.has(neighborKey)).toBe(true);
        expect(removeAccount).not.toHaveBeenCalled();

        const rawReadsBeforeReopenedRead = persistent.reads.length;
        await expect(cache.readPersistentArtifact(failedIdentity)).resolves.toBeNull();
        expect(persistent.reads.length).toBeGreaterThan(rawReadsBeforeReopenedRead);
    });

    it('stores installed plain-JS artifact bytes by full runtime identity and evicts only identities absent from current sources', () => {
        const cache = createPluginReactNativeBundleCache();
        const bytes = new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]);

        expect(cache.putInstalledArtifact({
            identity,
            bytes,
            format: 'plainJs',
        })).toEqual({ ok: true, cacheKey: derivePluginReactNativeBundleCacheKey(identity) });
        expect(cache.readInstalledArtifact(identity)?.bytes).toEqual(bytes);

        cache.reconcileActiveProjectionIdentities([]);
        expect(cache.readInstalledArtifact(identity)).toBeNull();
    });

    it('keeps concurrently owned artifact generations and retires one only after its final source withdraws', () => {
        const cache = createPluginReactNativeBundleCache();
        const bytes = new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]);
        const currentIdentity = { ...identity, projectionGeneration: 13 };
        cache.putInstalledArtifact({ identity, bytes, format: 'plainJs' });
        cache.putInstalledArtifact({ identity: currentIdentity, bytes, format: 'plainJs' });

        cache.reconcileActiveProjectionIdentities([identity, currentIdentity]);

        expect(cache.readInstalledArtifact(identity)).not.toBeNull();
        expect(cache.readInstalledArtifact(currentIdentity)).not.toBeNull();

        cache.reconcileActiveProjectionIdentities([currentIdentity]);

        expect(cache.readInstalledArtifact(identity)).toBeNull();
        expect(cache.readInstalledArtifact(currentIdentity)).not.toBeNull();
    });

    it('keeps a current identity write fence valid when a sibling source retires', () => {
        const cache = createPluginReactNativeBundleCache();
        const bytes = new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]);
        const siblingIdentity = { ...identity, contributionId: 'native-preview-sibling' };

        cache.reconcileActiveProjectionIdentities([identity, siblingIdentity]);
        const writeFence = cache.captureWriteFence(identity);

        cache.reconcileActiveProjectionIdentities([identity]);

        expect(cache.putInstalledArtifact({
            identity,
            bytes,
            format: 'plainJs',
        }, writeFence)).toEqual({
            ok: true,
            cacheKey: derivePluginReactNativeBundleCacheKey(identity),
        });
        expect(cache.readInstalledArtifact(identity)?.bytes).toEqual(bytes);
    });

    it('rejects an identity write fence after that identity retires', () => {
        const cache = createPluginReactNativeBundleCache();
        const bytes = new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]);
        const siblingIdentity = { ...identity, contributionId: 'native-preview-sibling' };

        cache.reconcileActiveProjectionIdentities([identity, siblingIdentity]);
        const writeFence = cache.captureWriteFence(identity);

        cache.reconcileActiveProjectionIdentities([siblingIdentity]);

        expect(cache.putInstalledArtifact({
            identity,
            bytes,
            format: 'plainJs',
        }, writeFence)).toMatchObject({
            ok: false,
            code: 'artifact_cache_write_invalidated',
        });
        expect(cache.readInstalledArtifact(identity)).toBeNull();
    });

    it('rejects an identity write fence after every current source retires', () => {
        const cache = createPluginReactNativeBundleCache();
        const bytes = new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]);

        cache.reconcileActiveProjectionIdentities([identity]);
        const writeFence = cache.captureWriteFence(identity);

        cache.reconcileActiveProjectionIdentities([]);

        expect(cache.putInstalledArtifact({
            identity,
            bytes,
            format: 'plainJs',
        }, writeFence)).toMatchObject({
            ok: false,
            code: 'artifact_cache_write_invalidated',
        });
        expect(cache.readInstalledArtifact(identity)).toBeNull();
    });

    it('keeps unchanged same-contribution executable bytes materialized without physical GC across compatibility replacement', async () => {
        const evictedIdentityBatches: PluginReactNativeBundleCacheIdentity[][] = [];
        const cache = createPluginReactNativeBundleCache({
            diskGc: {
                evictForIdentities: async (identities) => {
                    evictedIdentityBatches.push([...identities]);
                },
            },
        });
        const currentIdentity = { ...identity, projectionGeneration: 13 };
        const bytes = new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]);

        cache.putInstalledArtifact({ identity, bytes, format: 'plainJs' });
        cache.putInstalledArtifact({ identity: currentIdentity, bytes, format: 'plainJs' });
        cache.reconcileActiveProjectionIdentities([currentIdentity]);
        await Promise.resolve();

        expect(evictedIdentityBatches).toEqual([]);
        expect(cache.readInstalledArtifact(identity)).toBeNull();
        expect(cache.readInstalledArtifact(currentIdentity)).not.toBeNull();
    });

    it('deletes superseded same-contribution executable bytes when the Artifact digest changes', async () => {
        const evictedIdentityBatches: PluginReactNativeBundleCacheIdentity[][] = [];
        const cache = createPluginReactNativeBundleCache({
            diskGc: {
                evictForIdentities: async (identities) => {
                    evictedIdentityBatches.push([...identities]);
                },
            },
        });
        const replacementIdentity = {
            ...identity,
            artifactDigest: computePluginUiArtifactSha256DigestV1(new Uint8Array([12])),
            projectionGeneration: 13,
        };
        const bytes = new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]);

        cache.putInstalledArtifact({ identity, bytes, format: 'plainJs' });
        cache.putInstalledArtifact({ identity: replacementIdentity, bytes, format: 'plainJs' });
        cache.reconcileActiveProjectionIdentities([replacementIdentity]);
        await Promise.resolve();

        expect(evictedIdentityBatches).toEqual([[identity]]);
        expect(cache.readInstalledArtifact(identity)).toBeNull();
        expect(cache.readInstalledArtifact(replacementIdentity)).not.toBeNull();
    });

    it('drives disk-level GC for identities no active source still owns', async () => {
        const evictedIdentityBatches: PluginReactNativeBundleCacheIdentity[][] = [];
        const cache = createPluginReactNativeBundleCache({
            diskGc: {
                evictForIdentities: async (identities) => {
                    evictedIdentityBatches.push([...identities]);
                },
            },
        });
        const bytes = new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]);

        cache.putInstalledArtifact({ identity, bytes, format: 'plainJs' });
        cache.reconcileActiveProjectionIdentities([]);
        // Repeating an unchanged source snapshot must not invoke disk GC.
        cache.reconcileActiveProjectionIdentities([]);
        await Promise.resolve();

        expect(evictedIdentityBatches).toHaveLength(1);
        for (const batch of evictedIdentityBatches) {
            expect(batch).toEqual([identity]);
        }
    });

    it('reports failed physical executable cleanup without restoring cache reachability', async () => {
        const diagnostics: string[] = [];
        const cache = createPluginReactNativeBundleCache({
            diskGc: {
                evictForIdentities: async () => {
                    throw new Error('filesystem unavailable');
                },
            },
            onPersistentCacheDiagnostic: (code) => diagnostics.push(code),
        });
        const bytes = new TextEncoder().encode('// cleanup diagnostic');
        const runtimeIdentity = {
            ...identity,
            artifactDigest: computePluginUiArtifactSha256DigestV1(bytes),
        };

        expect(cache.putInstalledArtifact({
            identity: runtimeIdentity,
            bytes,
            format: 'plainJs',
        }).ok).toBe(true);
        cache.reconcileActiveProjectionIdentities([]);
        await Promise.resolve();

        expect(cache.readInstalledArtifact(runtimeIdentity)).toBeNull();
        expect(diagnostics).toContain('plugin_ui_artifact_executable_delete_failed');
    });

    it('returns cloned verified bytes so cache readers cannot mutate stored executable bytes', () => {
        const cache = createPluginReactNativeBundleCache();
        const bytes = new Uint8Array([47, 47, 32, 98, 117, 110, 100, 108, 101]);

        expect(cache.putInstalledArtifact({
            identity,
            bytes,
            format: 'plainJs',
        })).toEqual({ ok: true, cacheKey: derivePluginReactNativeBundleCacheKey(identity) });

        const firstRead = cache.readInstalledArtifact(identity);
        expect(firstRead?.bytes).toEqual(bytes);
        firstRead!.bytes[0] = 0;

        const secondRead = cache.readInstalledArtifact(identity);
        expect(secondRead?.bytes).toEqual(bytes);
        expect(secondRead?.bytes).not.toBe(firstRead?.bytes);
    });

    it('rejects Hermes bytecode arriving through the canonical verified-artifact write path', () => {
        // The lease sink is the only production writer, so the artifact format
        // has to be read off the verified entry bytes there. Hermes bytecode
        // opens with the 64-bit little-endian magic 0x1F1903C103BC1FC6 and can
        // reach this path under a plain `.js` entry path.
        const cache = createPluginReactNativeBundleCache();
        const hermesBytes = new Uint8Array([
            0xc6, 0x1f, 0xbc, 0x03, 0xc1, 0x03, 0x19, 0x1f,
            0x5b, 0x00, 0x00, 0x00,
        ]);
        const cacheSink = createPluginReactNativeArtifactLeaseCacheSink({
            cache,
            lifetime: {
                scope: persistentIdentity.accountScope,
                isCurrent: () => true,
                onRetire: () => ({ dispose: () => undefined }),
            },
        });

        expect(cacheSink.writeVerifiedArtifact({
            identity,
            accountScope: persistentIdentity.accountScope,
            bytes: hermesBytes,
            entryRelativePath: 'native/index.js',
            files: [{
                relativePath: 'native/index.js',
                digest: computePluginUiArtifactSha256DigestV1(hermesBytes),
                byteSize: hermesBytes.byteLength,
                bytes: hermesBytes,
            }],
        })).toEqual({
            ok: false,
            code: 'hermes_bytecode_unsupported',
            diagnostics: ['hermes_bytecode_unsupported'],
        });
        expect(cache.readInstalledArtifact(identity)).toBeNull();
    });

});
