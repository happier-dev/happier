import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const activeAccountHostedArtifactSource = vi.hoisted(() => ({
    create: vi.fn(),
    publish: vi.fn(async (_input: unknown) => undefined),
}));

const bundledAppExactArtifactSource = vi.hoisted(() => ({
    create: vi.fn(),
}));

const availabilityProjectionFixture = vi.hoisted(() => ({
    cache: null as unknown,
    lifetime: null as unknown,
}));

vi.mock('@/sync/api/plugins/availability/activePluginAccountHostedArtifactRead', () => ({
    createActivePluginAccountHostedArtifactSourceCandidate: (input: unknown) => (
        activeAccountHostedArtifactSource.create(input)
    ),
    publishActivePluginAccountHostedArtifact: (input: unknown) => (
        activeAccountHostedArtifactSource.publish(input)
    ),
}));

vi.mock('@/sync/domains/plugins/availability/bundledAppExactArtifactSource', () => ({
    createBundledPluginUiAppExactArtifactSource: () => bundledAppExactArtifactSource.create(),
}));

vi.mock('@/components/plugins/reactNative/bundleCache', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/plugins/reactNative/bundleCache')>();
    return {
        ...actual,
        getInstalledPluginReactNativeBundleCache: () => {
            const cache = availabilityProjectionFixture.cache;
            if (!cache) throw new Error('Expected an Availability projection cache fixture.');
            return cache as ReturnType<typeof actual.getInstalledPluginReactNativeBundleCache>;
        },
    };
});

vi.mock('@/sync/domains/scope/activeServerAccountScope', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/scope/activeServerAccountScope')>();
    return {
        ...actual,
        captureActiveServerAccountScopeLifetime: () => (
            availabilityProjectionFixture.lifetime as ActiveServerAccountScopeLifetime | null
        ),
    };
});

import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    PluginHostedWebSecurityPolicyV1Schema,
    type HostedWebAssetPolicyInput,
} from '@happier-dev/protocol/plugins/ui';
import {
    PluginReleaseFactsV1Schema,
    type PluginAccountAvailabilityIntentReadResponseV1,
} from '@happier-dev/protocol/plugins/availability';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    createPluginReactNativeBundleCacheWithNativeArtifactResources,
} from '@/components/plugins/reactNative/bundleCache';
import type {
    PluginUiPersistentArtifactRecord,
    PluginUiPersistentArtifactStore,
} from '@/sync/domains/plugins/ui/artifactByteCache';

import {
    createPluginNativeArtifactResourcePersistentStore,
    createPluginNativeArtifactResourceRegistry,
    type PluginNativeArtifactPersistentStore,
    type PluginNativeArtifactResourceRegistrar,
} from './nativeArtifactResource';
import {
    createPluginAccountAvailabilityReaderStore,
    type PluginAccountAvailabilitySnapshot,
} from './reader';
import {
    clearPluginAccountAvailabilityProjection,
    replacePluginAccountAvailabilityProjection,
} from './projection';
import { createPluginHostedWebArtifactAvailabilityProducer } from './hostedWebArtifactLease';

const scope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });
const projectionCleanupScope = Object.freeze({ serverId: 'server-cleanup', accountId: 'account-cleanup' });
const slot = Object.freeze({
    pluginId: 'com.acme.hosted',
    contributionId: 'hosted',
    tier: 'hostedWeb' as const,
    platform: 'web' as const,
});
const nativeRegistrationAccepted = Object.freeze({ kind: 'registered' as const });

function fixture() {
    const entryPath = 'hosted-web/acme/index.html';
    const scriptPath = 'hosted-web/acme/assets/app.js';
    const entryBytes = new TextEncoder().encode('<!doctype html><script src="assets/app.js"></script>');
    const scriptBytes = new TextEncoder().encode('export const mounted = true;');
    const files = [
        {
            relativePath: entryPath,
            digest: computePluginUiArtifactSha256DigestV1(entryBytes),
            byteSize: entryBytes.byteLength,
        },
        {
            relativePath: scriptPath,
            digest: computePluginUiArtifactSha256DigestV1(scriptBytes),
            byteSize: scriptBytes.byteLength,
        },
    ] as const;
    const digest = computePluginUiArtifactFileSetSha256DigestV1([
        { relativePath: entryPath, bytes: entryBytes },
        { relativePath: scriptPath, bytes: scriptBytes },
    ]);
    const response: PluginAccountAvailabilityIntentReadResponseV1 = {
        availabilityCursor: 1,
        hostingCapability: { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 },
        intent: {
            pluginId: slot.pluginId,
            desiredVersion: '1.2.3',
            enabled: true,
            offlineUiHosting: 'enabled',
            writableCollections: [],
            revision: 'intent-1',
        },
        release: PluginReleaseFactsV1Schema.parse({
            ref: { pluginId: slot.pluginId, version: '1.2.3' },
            archiveDigestSha256: `sha256:${'a'.repeat(64)}`,
            normalizedManifest: {
                schemaVersion: 2,
                id: slot.pluginId,
                version: '1.2.3',
                displayName: 'Hosted fixture',
                engines: { happier: '^1.0.0' },
                runtime: { apiVersion: 1 },
                contributes: {},
            },
            collectionContracts: [],
            uiSlots: [{
                contributionId: slot.contributionId,
                tier: slot.tier,
                platform: slot.platform,
                artifactDigest: digest,
                compatibility: { hostUiApiVersion: '1.0.0' },
            }],
            packageAssetArchive: {
                archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
                resources: [],
            },
        }),
        uiArtifacts: [{
            release: { pluginId: slot.pluginId, version: '1.2.3' },
            contributionId: slot.contributionId,
            tier: slot.tier,
            platform: slot.platform,
            artifactId: '00000000-0000-4000-8000-000000000001',
            artifactDigest: digest,
            compatibility: {
                hostAppVersion: '1.0.0',
                hostUiApiVersion: '1.0.0',
                reactVersion: '19.0.0',
                platform: 'web',
                channel: 'store',
                nativeCapabilities: [],
            },
        }],
    };
    return Object.freeze({
        graph: Object.freeze({
            contributionId: slot.contributionId,
            tier: slot.tier,
            platform: slot.platform,
            entry: entryPath,
            files,
            digest,
            builtWith: { bundler: 'vite' as const, version: '7.0.0' },
            hostUiApiVersion: '1.0.0',
            compat: {},
        }),
        cacheIdentity: Object.freeze({
            pluginId: slot.pluginId,
            contributionId: slot.contributionId,
            artifactDigest: digest,
            platform: 'web' as const,
            projectionGeneration: 1,
        }),
        snapshot: Object.freeze({
            availabilityCursor: 1,
            intentReads: [{ pluginId: slot.pluginId, response }],
            materializations: [],
            snapshots: [],
        } satisfies PluginAccountAvailabilitySnapshot),
        bytesByPath: new Map<string, Uint8Array>([
            [entryPath, entryBytes],
            [scriptPath, scriptBytes],
        ]),
    });
}

function createLifetime() {
    let retired = false;
    const listeners = new Set<() => void>();
    const lifetime: ActiveServerAccountScopeLifetime = Object.freeze({
        scope,
        isCurrent: () => !retired,
        onRetire: (listener) => {
            listeners.add(listener);
            return Object.freeze({ dispose: () => listeners.delete(listener) });
        },
    });
    return Object.freeze({
        lifetime,
        retire: () => {
            retired = true;
            for (const listener of [...listeners]) listener();
        },
    });
}

function createReader(snapshot: PluginAccountAvailabilitySnapshot) {
    const store = createPluginAccountAvailabilityReaderStore();
    store.replace({ scope, snapshot });
    return store.bind(scope);
}

function hostedWebPolicy(graph: ReturnType<typeof fixture>['graph']): HostedWebAssetPolicyInput {
    return Object.freeze({
        assetRootId: 'hosted-web/acme',
        entryPath: graph.entry,
        files: graph.files.map((file) => file.relativePath),
        digest: graph.digest,
        routeMode: 'pathFallback',
        requestPath: '/',
        security: PluginHostedWebSecurityPolicyV1Schema.parse({}),
        sourceMaps: Object.freeze({ enabled: false }),
    });
}

function createNativePersistentStore(input: Readonly<{
    initialRecord?: PluginUiPersistentArtifactRecord | null;
    onRemove?: (identity: PluginUiPersistentArtifactRecord['persistentIdentity']) => Promise<void>;
    onRemoveAccount?: () => Promise<void>;
}> = {}) {
    let record: PluginUiPersistentArtifactRecord | null = input.initialRecord ?? null;
    const read = vi.fn(async () => record);
    const write = vi.fn(async (next: PluginUiPersistentArtifactRecord) => {
        record = next;
    });
    const remove = vi.fn(async (identity: PluginUiPersistentArtifactRecord['persistentIdentity']) => {
        await input.onRemove?.(identity);
        record = null;
    });
    const removeAccount = vi.fn(async () => {
        await input.onRemoveAccount?.();
        record = null;
    });
    const rawStore: PluginNativeArtifactPersistentStore = Object.freeze({
        read,
        write,
        remove,
        removeAccount,
        describeNativeResource: async ({ files }) => (
            record
                ? Object.freeze({
                    locator: Object.freeze({
                        namespace: 'happier-plugin-ui-artifacts-v1' as const,
                        accountKeyHash: 'account-hash',
                        artifactKeyHash: 'artifact-hash',
                    }),
                    resources: Object.freeze(files.map((file, index) => Object.freeze({
                        storedFileName: `stored-${index}.bin`,
                        digest: file.digest,
                        byteSize: file.byteSize,
                    }))),
                })
                : null
        ),
    });
    return Object.freeze({ rawStore, read, write, remove, removeAccount, readRecord: () => record });
}

function persistentRecordFor(current: ReturnType<typeof fixture>): PluginUiPersistentArtifactRecord {
    const files = current.graph.files.map((file) => {
        const bytes = current.bytesByPath.get(file.relativePath);
        if (!bytes) throw new Error('Fixture must contain every declared file.');
        return Object.freeze({ ...file, bytes: new Uint8Array(bytes) });
    });
    const entry = files.find((file) => file.relativePath === current.graph.entry);
    if (!entry) throw new Error('Fixture must contain its entry file.');
    return Object.freeze({
        persistentIdentity: Object.freeze({
            accountScope: scope,
            releaseVersion: '1.2.3',
            pluginId: slot.pluginId,
            contributionId: slot.contributionId,
            tier: 'hostedWeb',
            platform: 'web',
            artifactDigest: current.graph.digest,
        }),
        bytes: new Uint8Array(entry.bytes),
        entryRelativePath: current.graph.entry,
        files: Object.freeze(files),
    });
}

function snapshotWithAvailability(input: Readonly<{
    current: ReturnType<typeof fixture>;
    availabilityCursor: number;
    enabled?: boolean;
    version?: string;
}>): PluginAccountAvailabilitySnapshot {
    const response = input.current.snapshot.intentReads[0]?.response;
    if (!response?.intent || !response.release || !response.intent.desiredVersion) {
        throw new Error('Fixture must contain an enabled release intent.');
    }
    const version = input.version ?? response.intent.desiredVersion;
    const release = version === response.release.ref.version
        ? response.release
        : PluginReleaseFactsV1Schema.parse({
            ...response.release,
            ref: { ...response.release.ref, version },
            normalizedManifest: { ...response.release.normalizedManifest, version },
        });
    return Object.freeze({
        availabilityCursor: input.availabilityCursor,
        intentReads: Object.freeze([Object.freeze({
            pluginId: slot.pluginId,
            response: {
                ...response,
                availabilityCursor: input.availabilityCursor,
                intent: {
                    ...response.intent,
                    desiredVersion: version,
                    enabled: input.enabled ?? response.intent.enabled,
                    revision: `intent-${input.availabilityCursor}`,
                },
                release,
                uiArtifacts: response.uiArtifacts.map((artifact) => ({
                    ...artifact,
                    release: { ...artifact.release, version },
                })),
            },
        })]),
        materializations: input.current.snapshot.materializations,
        snapshots: input.current.snapshot.snapshots,
    } satisfies PluginAccountAvailabilitySnapshot);
}

/**
 * The same admitted release with NO committed Account Artifact link, which is
 * the only state in which hosting publication is admitted at all.
 */
function snapshotWithoutHostedLink(
    current: ReturnType<typeof fixture>,
): PluginAccountAvailabilitySnapshot {
    const response = current.snapshot.intentReads[0]?.response;
    if (!response) throw new Error('Fixture must contain an intent read.');
    return Object.freeze({
        availabilityCursor: current.snapshot.availabilityCursor,
        intentReads: Object.freeze([Object.freeze({
            pluginId: slot.pluginId,
            response: { ...response, uiArtifacts: [] },
        })]),
        materializations: current.snapshot.materializations,
        snapshots: current.snapshot.snapshots,
    } satisfies PluginAccountAvailabilitySnapshot);
}

function createPersistentStore() {
    let record: PluginUiPersistentArtifactRecord | null = null;
    const read = vi.fn(async () => record);
    const write = vi.fn(async (next: PluginUiPersistentArtifactRecord) => {
        record = next;
    });
    const store: PluginUiPersistentArtifactStore = Object.freeze({
        read,
        write,
        remove: async () => {
            record = null;
        },
        removeAccount: async () => {
            record = null;
        },
    });
    return Object.freeze({ store, read, write });
}

function createCurrentPersistentAccountOperation() {
    return Object.freeze({
        scope,
        isCurrent: () => true,
        isCacheCurrent: () => true,
        isOpen: () => true,
        awaitPendingPersistentArtifactRemoval: async () => undefined,
        removePersistentArtifact: async () => undefined,
        removePersistentArtifactsForAccount: async () => undefined,
        release: () => undefined,
    });
}

beforeEach(() => {
    bundledAppExactArtifactSource.create.mockReset();
    bundledAppExactArtifactSource.create.mockReturnValue(Object.freeze({
        kind: 'appExact' as const,
        readFile: async () => null,
    }));
});

afterEach(() => {
    availabilityProjectionFixture.cache = null;
    availabilityProjectionFixture.lifetime = null;
    // Drop a predecessor retained by the singleton projection writer without
    // letting one test's Account-A transition affect the next test's Account-A
    // setup. Scope mismatch intentionally performs no persistent cleanup.
    replacePluginAccountAvailabilityProjection({
        scope: projectionCleanupScope,
        snapshot: fixture().snapshot,
    });
});

describe('hosted-web Artifact availability producer', () => {
    it('adopts app-bundled exact hosted bytes into an opaque native handle before Account-hosted bytes', async () => {
        const current = fixture();
        const persistent = createNativePersistentStore();
        const register = vi.fn(async () => nativeRegistrationAccepted);
        const unregister = vi.fn(() => true);
        const registrar: PluginNativeArtifactResourceRegistrar = Object.freeze({ register, unregister });
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar,
            createOpaqueId: () => 'opaque-app-exact',
        });
        const bindAccountLifetime = vi.fn();
        const nativePersistentStore = createPluginNativeArtifactResourcePersistentStore({
            store: persistent.rawStore,
            registry,
        });
        const producer = createPluginHostedWebArtifactAvailabilityProducer({
            getHostRuntimeIdentity: () => null,
            getNativeResources: () => Object.freeze({ nativePersistentStore, registry }),
            getCache: () => Object.freeze({
                bindAccountLifetime,
                capturePersistentAccountOperation: () => createCurrentPersistentAccountOperation(),
                removePersistentArtifact: async () => undefined,
            }),
        });
        const { lifetime } = createLifetime();
        const appExact = vi.fn(async ({ relativePath }: Readonly<{ relativePath: string }>) => (
            current.bytesByPath.get(relativePath) ?? null
        ));
        bundledAppExactArtifactSource.create.mockReset();
        bundledAppExactArtifactSource.create.mockReturnValue(Object.freeze({
            kind: 'appExact' as const,
            readFile: appExact,
        }));
        const accountHosted = vi.fn(async ({ relativePath }: Readonly<{ relativePath: string }>) => (
            current.bytesByPath.get(relativePath) ?? null
        ));
        activeAccountHostedArtifactSource.create.mockReset();
        activeAccountHostedArtifactSource.create.mockReturnValue(Object.freeze({
            kind: 'accountHosted' as const,
            readFile: accountHosted,
        }));

        const acquired = await producer.acquire({
            reader: createReader(current.snapshot),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicy(current.graph),
        });

        expect(acquired).toMatchObject({
            kind: 'available',
            handle: expect.objectContaining({ token: 'opaque-app-exact' }),
        });
        if (acquired.kind !== 'available') throw new Error('expected app-exact native Artifact handle');
        expect(bundledAppExactArtifactSource.create).toHaveBeenCalledOnce();
        expect(appExact).toHaveBeenCalled();
        expect(accountHosted).not.toHaveBeenCalled();
        expect(persistent.read).toHaveBeenCalled();
        expect(acquired.handle).not.toHaveProperty('bytes');
        expect(acquired.handle).not.toHaveProperty('readFile');

        acquired.handle.dispose();
        expect(unregister).toHaveBeenCalledWith('opaque-app-exact');
    });

    it('projects a Host-injected Account-hosted candidate through the native revocation gate without exposing bytes to the host', async () => {
        const current = fixture();
        const persistent = createNativePersistentStore();
        const register = vi.fn(async () => nativeRegistrationAccepted);
        const unregister = vi.fn(() => true);
        const registrar: PluginNativeArtifactResourceRegistrar = Object.freeze({ register, unregister });
        let nextOpaqueId = 0;
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar,
            createOpaqueId: () => `opaque-${++nextOpaqueId}`,
        });
        const nativePersistentStore = createPluginNativeArtifactResourcePersistentStore({
            store: persistent.rawStore,
            registry,
        });
        const bindAccountLifetime = vi.fn();
        const producer = createPluginHostedWebArtifactAvailabilityProducer({
            getHostRuntimeIdentity: () => null,
            getNativeResources: () => Object.freeze({ nativePersistentStore, registry }),
            getCache: () => Object.freeze({
                bindAccountLifetime,
                capturePersistentAccountOperation: () => createCurrentPersistentAccountOperation(),
                removePersistentArtifact: async () => undefined,
            }),
        });
        const { lifetime } = createLifetime();
        const accountHosted = vi.fn(async ({ relativePath }: Readonly<{ relativePath: string }>) => (
            current.bytesByPath.get(relativePath) ?? null
        ));
        const accountHostedCandidate = Object.freeze({
            kind: 'accountHosted' as const,
            readFile: accountHosted,
        });
        activeAccountHostedArtifactSource.create.mockReset();
        activeAccountHostedArtifactSource.create.mockReturnValue(accountHostedCandidate);
        const input = Object.freeze({
            reader: createReader(current.snapshot),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicy(current.graph),
        });

        const first = await producer.acquire(input);

        expect(first).toMatchObject({
            kind: 'available',
            handle: expect.objectContaining({ token: 'opaque-1' }),
        });
        if (first.kind !== 'available') throw new Error('expected Account-hosted native Artifact handle');
        expect(accountHosted).toHaveBeenCalledTimes(2);
        expect(activeAccountHostedArtifactSource.create).toHaveBeenCalledWith({ accountLifetime: lifetime });
        expect(persistent.write).toHaveBeenCalledOnce();
        expect(bindAccountLifetime).toHaveBeenCalledWith(lifetime);
        expect(first.handle).not.toHaveProperty('bytes');
        expect(first.handle).not.toHaveProperty('persistentStore');

        first.handle.dispose();
        expect(unregister).toHaveBeenCalledWith('opaque-1');

        const second = await producer.acquire(input);

        expect(second).toMatchObject({
            kind: 'available',
            handle: expect.objectContaining({ token: 'opaque-2' }),
        });
        expect(persistent.write).toHaveBeenCalledOnce();
        expect(accountHosted).toHaveBeenCalledTimes(2);
        if (second.kind === 'available') second.handle.dispose();
    });

    it('publishes the verified hosted-web archive to Account hosting when the slot has no committed link', async () => {
        const current = fixture();
        const custodyEvents: string[] = [];
        const persistent = createNativePersistentStore();
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar: Object.freeze({
                register: vi.fn(async () => nativeRegistrationAccepted),
                unregister: vi.fn(() => true),
            }),
            createOpaqueId: () => 'opaque-publish',
        });
        const nativePersistentStore = createPluginNativeArtifactResourcePersistentStore({
            store: persistent.rawStore,
            registry,
        });
        const producer = createPluginHostedWebArtifactAvailabilityProducer({
            getHostRuntimeIdentity: () => Object.freeze({
                platform: 'ios' as const,
                channel: 'store' as const,
                appVersion: '1.4.2',
                availableNativeCapabilities: [],
            }),
            getNativeResources: () => Object.freeze({ nativePersistentStore, registry }),
            getCache: () => Object.freeze({
                bindAccountLifetime: vi.fn(),
                capturePersistentAccountOperation: () => createCurrentPersistentAccountOperation(),
                removePersistentArtifact: async () => undefined,
            }),
        });
        const { lifetime } = createLifetime();
        bundledAppExactArtifactSource.create.mockReset();
        bundledAppExactArtifactSource.create.mockReturnValue(Object.freeze({
            kind: 'appExact' as const,
            readFile: async ({ relativePath }: Readonly<{ relativePath: string }>) => {
                custodyEvents.push(`verified:${relativePath}`);
                return current.bytesByPath.get(relativePath) ?? null;
            },
        }));
        activeAccountHostedArtifactSource.create.mockReset();
        activeAccountHostedArtifactSource.create.mockReturnValue(Object.freeze({
            kind: 'accountHosted' as const,
            readFile: async () => null,
        }));
        activeAccountHostedArtifactSource.publish.mockClear();
        activeAccountHostedArtifactSource.publish.mockImplementationOnce(async () => {
            custodyEvents.push('published');
        });

        const acquired = await producer.acquire({
            reader: createReader(snapshotWithoutHostedLink(current)),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicy(current.graph),
        });

        expect(acquired.kind).toBe('available');
        expect(activeAccountHostedArtifactSource.publish).toHaveBeenCalledOnce();
        // A hosted-web frame declares no framework compatibility at all: the one
        // version that decides which hosts a stored link may serve comes from
        // the verified graph, and the app/channel facts are this host's own.
        expect(activeAccountHostedArtifactSource.publish).toHaveBeenCalledWith(expect.objectContaining({
            accountLifetime: lifetime,
            release: { pluginId: slot.pluginId, version: '1.2.3' },
            slot: expect.objectContaining({
                contributionId: slot.contributionId,
                tier: 'hostedWeb',
                platform: 'web',
                artifactDigest: current.graph.digest,
            }),
            hostCompatibility: {
                hostAppVersion: '1.4.2',
                hostUiApiVersion: '1.0.0',
                platform: 'web',
                channel: 'store',
                nativeCapabilities: [],
            },
            artifactGraph: current.graph,
        }));
        const published = activeAccountHostedArtifactSource.publish.mock.calls[0]?.[0] as
            | Readonly<{ files: readonly Readonly<{ relativePath: string; bytes: Uint8Array }>[] }>
            | undefined;
        expect(published?.files.map((file) => file.relativePath))
            .toEqual(current.graph.files.map((file) => file.relativePath));
        expect(custodyEvents).toEqual([
            ...current.graph.files.map((file) => `verified:${file.relativePath}`),
            'published',
        ]);
        if (acquired.kind === 'available') acquired.handle.dispose();
    });

    it('cancels hosted-web Account publication when the Account lifetime retires during verification', async () => {
        const current = fixture();
        const persistent = createNativePersistentStore();
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar: Object.freeze({
                register: vi.fn(async () => nativeRegistrationAccepted),
                unregister: vi.fn(() => true),
            }),
            createOpaqueId: () => 'opaque-retired-before-publish',
        });
        const nativePersistentStore = createPluginNativeArtifactResourcePersistentStore({
            store: persistent.rawStore,
            registry,
        });
        const producer = createPluginHostedWebArtifactAvailabilityProducer({
            getHostRuntimeIdentity: () => Object.freeze({
                platform: 'ios' as const,
                channel: 'store' as const,
                appVersion: '1.4.2',
                availableNativeCapabilities: [],
            }),
            getNativeResources: () => Object.freeze({ nativePersistentStore, registry }),
            getCache: () => Object.freeze({
                bindAccountLifetime: vi.fn(),
                capturePersistentAccountOperation: () => createCurrentPersistentAccountOperation(),
                removePersistentArtifact: async () => undefined,
            }),
        });
        const { lifetime, retire } = createLifetime();
        let verifiedFiles = 0;
        bundledAppExactArtifactSource.create.mockReset();
        bundledAppExactArtifactSource.create.mockReturnValue(Object.freeze({
            kind: 'appExact' as const,
            readFile: async ({ relativePath }: Readonly<{ relativePath: string }>) => {
                const bytes = current.bytesByPath.get(relativePath) ?? null;
                verifiedFiles += 1;
                if (verifiedFiles === current.graph.files.length) retire();
                return bytes;
            },
        }));
        activeAccountHostedArtifactSource.create.mockReset();
        activeAccountHostedArtifactSource.create.mockReturnValue(Object.freeze({
            kind: 'accountHosted' as const,
            readFile: async () => null,
        }));
        activeAccountHostedArtifactSource.publish.mockClear();

        const acquired = await producer.acquire({
            reader: createReader(snapshotWithoutHostedLink(current)),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicy(current.graph),
        });

        expect(verifiedFiles).toBe(current.graph.files.length);
        expect(acquired).toEqual({ kind: 'unavailable', code: 'artifact_lease_revoked' });
        expect(activeAccountHostedArtifactSource.publish).not.toHaveBeenCalled();
    });

    it('publishes nothing when the host cannot describe its own adoption facts', async () => {
        const current = fixture();
        const persistent = createNativePersistentStore();
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar: Object.freeze({
                register: vi.fn(async () => nativeRegistrationAccepted),
                unregister: vi.fn(() => true),
            }),
            createOpaqueId: () => 'opaque-no-identity',
        });
        const nativePersistentStore = createPluginNativeArtifactResourcePersistentStore({
            store: persistent.rawStore,
            registry,
        });
        const producer = createPluginHostedWebArtifactAvailabilityProducer({
            // Same admitted slot, same verified bytes; only the host's ability to
            // name itself is missing. A fabricated key would publish a link whose
            // recorded provenance no host actually reported.
            getHostRuntimeIdentity: () => null,
            getNativeResources: () => Object.freeze({ nativePersistentStore, registry }),
            getCache: () => Object.freeze({
                bindAccountLifetime: vi.fn(),
                capturePersistentAccountOperation: () => createCurrentPersistentAccountOperation(),
                removePersistentArtifact: async () => undefined,
            }),
        });
        const { lifetime } = createLifetime();
        bundledAppExactArtifactSource.create.mockReset();
        bundledAppExactArtifactSource.create.mockReturnValue(Object.freeze({
            kind: 'appExact' as const,
            readFile: async ({ relativePath }: Readonly<{ relativePath: string }>) => (
                current.bytesByPath.get(relativePath) ?? null
            ),
        }));
        activeAccountHostedArtifactSource.create.mockReset();
        activeAccountHostedArtifactSource.create.mockReturnValue(Object.freeze({
            kind: 'accountHosted' as const,
            readFile: async () => null,
        }));
        activeAccountHostedArtifactSource.publish.mockClear();

        const acquired = await producer.acquire({
            reader: createReader(snapshotWithoutHostedLink(current)),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicy(current.graph),
        });

        expect(acquired.kind).toBe('available');
        expect(activeAccountHostedArtifactSource.publish).not.toHaveBeenCalled();
        if (acquired.kind === 'available') acquired.handle.dispose();
    });

    it('keeps retained native Artifact bytes unreadable while the Account lifetime is retired', async () => {
        const current = fixture();
        const recordFiles = current.graph.files.map((file) => {
            const bytes = current.bytesByPath.get(file.relativePath);
            if (!bytes) throw new Error('Fixture must contain every declared file.');
            return Object.freeze({ ...file, bytes: new Uint8Array(bytes) });
        });
        const entry = recordFiles.find((file) => file.relativePath === current.graph.entry);
        if (!entry) throw new Error('Fixture must contain its entry file.');
        let record: PluginUiPersistentArtifactRecord | null = Object.freeze({
            persistentIdentity: Object.freeze({
                accountScope: scope,
                releaseVersion: '1.2.3',
                pluginId: slot.pluginId,
                contributionId: slot.contributionId,
                tier: 'hostedWeb' as const,
                platform: 'web',
                artifactDigest: current.graph.digest,
            }),
            bytes: new Uint8Array(entry.bytes),
            entryRelativePath: current.graph.entry,
            files: Object.freeze(recordFiles),
        });
        const read = vi.fn(async () => record);
        const removeAccount = vi.fn(async () => {
            record = null;
        });
        const rawStore: PluginNativeArtifactPersistentStore = Object.freeze({
            read,
            write: async (next) => {
                record = next;
            },
            remove: async () => {
                record = null;
            },
            removeAccount,
            describeNativeResource: async ({ files }) => (
                record
                    ? Object.freeze({
                        locator: Object.freeze({
                            namespace: 'happier-plugin-ui-artifacts-v1' as const,
                            accountKeyHash: 'account-hash',
                            artifactKeyHash: 'artifact-hash',
                        }),
                        resources: Object.freeze(files.map((file, index) => Object.freeze({
                            storedFileName: `stored-${index}.bin`,
                            digest: file.digest,
                            byteSize: file.byteSize,
                        }))),
                    })
                    : null
            ),
        });
        const registrar: PluginNativeArtifactResourceRegistrar = Object.freeze({
            register: async () => nativeRegistrationAccepted,
            unregister: () => true,
        });
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar,
            createOpaqueId: () => 'opaque-fenced-raw-store',
        });
        const composition = createPluginReactNativeBundleCacheWithNativeArtifactResources({
            persistentStore: rawStore,
            registry,
        });
        const producer = createPluginHostedWebArtifactAvailabilityProducer({
            getHostRuntimeIdentity: () => null,
            getNativeResources: () => Object.freeze({
                nativePersistentStore: composition.nativePersistentStore,
                registry,
            }),
            getCache: () => composition.cache,
        });
        const { lifetime, retire } = createLifetime();
        composition.cache.bindAccountLifetime(lifetime);
        bundledAppExactArtifactSource.create.mockReset();
        bundledAppExactArtifactSource.create.mockReturnValue(Object.freeze({
            kind: 'appExact' as const,
            readFile: async () => null,
        }));
        activeAccountHostedArtifactSource.create.mockReset();
        activeAccountHostedArtifactSource.create.mockReturnValue(Object.freeze({
            kind: 'accountHosted' as const,
            readFile: async () => null,
        }));

        retire();
        await vi.waitFor(() => {
            expect(composition.cache.isAccountCurrent(scope)).toBe(false);
        });

        await expect(producer.acquire({
            reader: createReader(current.snapshot),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicy(current.graph),
        })).resolves.toEqual({ kind: 'unavailable', code: 'artifact_lease_revoked' });
        expect(read).not.toHaveBeenCalled();
        expect(removeAccount).not.toHaveBeenCalled();
        expect(record).not.toBeNull();
    });

    it('keeps retained native bytes available to a fresh Account lifetime while an old read settles stale', async () => {
        const current = fixture();
        let record: PluginUiPersistentArtifactRecord | null = persistentRecordFor(current);
        let rawReadCount = 0;
        let beginOldExistenceRead!: () => void;
        const oldExistenceReadBegan = new Promise<void>((resolve) => {
            beginOldExistenceRead = resolve;
        });
        let allowOldExistenceRead!: () => void;
        const oldExistenceReadGate = new Promise<void>((resolve) => {
            allowOldExistenceRead = resolve;
        });
        const read = vi.fn(async () => {
            rawReadCount += 1;
            if (rawReadCount === 1) {
                beginOldExistenceRead();
                await oldExistenceReadGate;
                return null;
            }
            return record;
        });
        const write = vi.fn(async (next: PluginUiPersistentArtifactRecord) => {
            record = next;
        });
        const removeAccount = vi.fn(async () => {
            record = null;
        });
        const rawStore: PluginNativeArtifactPersistentStore = Object.freeze({
            read,
            write,
            remove: async () => {
                record = null;
            },
            removeAccount,
            describeNativeResource: async ({ files }) => (
                record
                    ? Object.freeze({
                        locator: Object.freeze({
                            namespace: 'happier-plugin-ui-artifacts-v1' as const,
                            accountKeyHash: 'account-hash',
                            artifactKeyHash: 'artifact-hash',
                        }),
                        resources: Object.freeze(files.map((file, index) => Object.freeze({
                            storedFileName: `stored-${index}.bin`,
                            digest: file.digest,
                            byteSize: file.byteSize,
                        }))),
                    })
                    : null
            ),
        });
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar: Object.freeze({
                register: async () => nativeRegistrationAccepted,
                unregister: () => true,
            }),
            createOpaqueId: () => 'opaque-stale-existence-read',
        });
        const composition = createPluginReactNativeBundleCacheWithNativeArtifactResources({
            persistentStore: rawStore,
            registry,
        });
        const producer = createPluginHostedWebArtifactAvailabilityProducer({
            getHostRuntimeIdentity: () => null,
            getNativeResources: () => Object.freeze({
                nativePersistentStore: composition.nativePersistentStore,
                registry,
            }),
            getCache: () => composition.cache,
        });
        const oldLifetime = createLifetime();
        const freshLifetime = createLifetime();
        bundledAppExactArtifactSource.create.mockReset();
        bundledAppExactArtifactSource.create.mockReturnValue(Object.freeze({
            kind: 'appExact' as const,
            readFile: async ({ relativePath }: Readonly<{ relativePath: string }>) => (
                current.bytesByPath.get(relativePath) ?? null
            ),
        }));
        activeAccountHostedArtifactSource.create.mockReset();
        activeAccountHostedArtifactSource.create.mockReturnValue(Object.freeze({
            kind: 'accountHosted' as const,
            readFile: async () => null,
        }));

        const oldAcquisition = producer.acquire({
            reader: createReader(current.snapshot),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime: oldLifetime.lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicy(current.graph),
        });
        await oldExistenceReadBegan;

        await composition.cache.retireAccount(scope);
        expect(removeAccount).not.toHaveBeenCalled();

        const freshAcquisition = await producer.acquire({
            reader: createReader(current.snapshot),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime: freshLifetime.lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicy(current.graph),
        });
        if (freshAcquisition.kind === 'available') freshAcquisition.handle.dispose();

        allowOldExistenceRead();
        const oldResult = await oldAcquisition;
        if (oldResult.kind === 'available') oldResult.handle.dispose();

        expect(freshAcquisition.kind).toBe('available');
        expect(oldResult).toEqual({ kind: 'unavailable', code: 'artifact_lease_revoked' });
        expect(read).toHaveBeenCalledTimes(2);
        expect(write).not.toHaveBeenCalled();
    });

    it('revokes a producer-selected hosted Artifact handle without deleting its retained bytes when the Account disables the plugin', async () => {
        const current = fixture();
        const record = persistentRecordFor(current);
        const persistent = createNativePersistentStore({ initialRecord: record });
        const unregister = vi.fn(() => true);
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar: Object.freeze({
                register: async () => nativeRegistrationAccepted,
                unregister,
            }),
            createOpaqueId: () => 'opaque-withdrawn-persistent-artifact',
        });
        const composition = createPluginReactNativeBundleCacheWithNativeArtifactResources({
            persistentStore: persistent.rawStore,
            registry,
        });
        const producer = createPluginHostedWebArtifactAvailabilityProducer({
            getHostRuntimeIdentity: () => null,
            getNativeResources: () => Object.freeze({
                nativePersistentStore: composition.nativePersistentStore,
                registry,
            }),
            getCache: () => composition.cache,
        });
        const readerStore = createPluginAccountAvailabilityReaderStore();
        readerStore.replace({ scope, snapshot: current.snapshot });
        const { lifetime } = createLifetime();
        activeAccountHostedArtifactSource.create.mockReset();
        activeAccountHostedArtifactSource.create.mockReturnValue(Object.freeze({
            kind: 'accountHosted' as const,
            readFile: async () => null,
        }));

        const acquired = await producer.acquire({
            reader: readerStore.bind(scope),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicy(current.graph),
        });
        if (acquired.kind !== 'available') throw new Error('Expected the seeded persistent Artifact to materialize.');

        readerStore.replace({
            scope,
            snapshot: snapshotWithAvailability({
                current,
                availabilityCursor: 2,
                enabled: false,
            }),
        });

        await vi.waitFor(() => {
            expect(unregister).toHaveBeenCalledWith('opaque-withdrawn-persistent-artifact');
        });
        expect(acquired.handle.isCurrent()).toBe(false);
        // Disable revokes the native token and retires reachability. The bytes
        // stay retained (PEP-ARTIFACTS 10.1) so re-enabling costs no download.
        expect(persistent.remove).not.toHaveBeenCalled();
        expect(persistent.removeAccount).not.toHaveBeenCalled();
        expect(persistent.readRecord()).not.toBeNull();

        acquired.handle.dispose();
    });

    it('retires the stale native token, retains bytes, and reuses A after A → B → A', async () => {
        const current = fixture();
        const record = persistentRecordFor(current);
        const persistent = createNativePersistentStore({ initialRecord: record });
        const unregister = vi.fn(() => true);
        let opaqueId = 0;
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar: Object.freeze({
                register: async () => nativeRegistrationAccepted,
                unregister,
            }),
            createOpaqueId: () => `opaque-revoked-re-admitted-${++opaqueId}`,
        });
        const composition = createPluginReactNativeBundleCacheWithNativeArtifactResources({
            persistentStore: persistent.rawStore,
            registry,
        });
        const producer = createPluginHostedWebArtifactAvailabilityProducer({
            getHostRuntimeIdentity: () => null,
            getNativeResources: () => Object.freeze({
                nativePersistentStore: composition.nativePersistentStore,
                registry,
            }),
            getCache: () => composition.cache,
        });
        const readerStore = createPluginAccountAvailabilityReaderStore();
        readerStore.replace({ scope, snapshot: current.snapshot });
        const { lifetime } = createLifetime();
        availabilityProjectionFixture.cache = composition.cache;
        availabilityProjectionFixture.lifetime = lifetime;
        activeAccountHostedArtifactSource.create.mockReset();
        const accountHostedRead = vi.fn(async () => null);
        activeAccountHostedArtifactSource.create.mockReturnValue(Object.freeze({
            kind: 'accountHosted' as const,
            readFile: accountHostedRead,
        }));

        replacePluginAccountAvailabilityProjection({ scope, snapshot: current.snapshot });
        const initiallyAcquired = await producer.acquire({
            reader: readerStore.bind(scope),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicy(current.graph),
        });
        if (initiallyAcquired.kind !== 'available') {
            throw new Error('Expected the seeded persistent Artifact to materialize.');
        }

        let reacquiredHandle: Readonly<{ dispose: () => void }> | null = null;
        try {
            const supersededSnapshot = snapshotWithAvailability({
                current,
                availabilityCursor: 2,
                version: '1.2.4',
            });
            readerStore.replace({ scope, snapshot: supersededSnapshot });
            // The projection writer is the one owner that supersedes the old
            // current release, because only it holds both verified snapshots.
            replacePluginAccountAvailabilityProjection({ scope, snapshot: supersededSnapshot });
            await vi.waitFor(() => {
                expect(unregister).toHaveBeenCalledWith('opaque-revoked-re-admitted-1');
            });
            expect(initiallyAcquired.handle.isCurrent()).toBe(false);
            expect(persistent.remove).not.toHaveBeenCalled();
            expect(persistent.removeAccount).not.toHaveBeenCalled();
            expect(persistent.readRecord()).toEqual(record);

            // A receives a fresh opaque token only after currentness revoked
            // the old token. Its retained bytes remain the source.
            const readmittedSnapshot = snapshotWithAvailability({
                current,
                availabilityCursor: 3,
            });
            readerStore.replace({ scope, snapshot: readmittedSnapshot });
            replacePluginAccountAvailabilityProjection({ scope, snapshot: readmittedSnapshot });
            const reacquisition = await producer.acquire({
                reader: readerStore.bind(scope),
                artifactGraph: current.graph,
                cacheIdentity: current.cacheIdentity,
                accountLifetime: lifetime,
                isCurrent: () => true,
                hostedWebPolicy: hostedWebPolicy(current.graph),
            });

            if (reacquisition.kind !== 'available') {
                throw new Error('Expected retained A Artifact bytes to be re-adopted.');
            }
            reacquiredHandle = reacquisition.handle;
            expect(reacquisition.handle.isCurrent()).toBe(true);
            expect(accountHostedRead).not.toHaveBeenCalled();
            expect(persistent.remove).not.toHaveBeenCalled();
            expect(persistent.readRecord()).toEqual(record);
        } finally {
            reacquiredHandle?.dispose();
            initiallyAcquired.handle.dispose();
        }
    });

    it('retains a disposed hosted Artifact while cleared Availability is replaced', async () => {
        const current = fixture();
        const record = persistentRecordFor(current);
        const persistent = createNativePersistentStore({ initialRecord: record });
        const unregister = vi.fn(() => true);
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar: Object.freeze({
                register: async () => nativeRegistrationAccepted,
                unregister,
            }),
            createOpaqueId: () => 'opaque-disposed-projection-replacement',
        });
        const composition = createPluginReactNativeBundleCacheWithNativeArtifactResources({
            persistentStore: persistent.rawStore,
            registry,
        });
        const producer = createPluginHostedWebArtifactAvailabilityProducer({
            getHostRuntimeIdentity: () => null,
            getNativeResources: () => Object.freeze({
                nativePersistentStore: composition.nativePersistentStore,
                registry,
            }),
            getCache: () => composition.cache,
        });
        const readerStore = createPluginAccountAvailabilityReaderStore();
        readerStore.replace({ scope, snapshot: current.snapshot });
        const { lifetime } = createLifetime();
        availabilityProjectionFixture.cache = composition.cache;
        availabilityProjectionFixture.lifetime = lifetime;
        activeAccountHostedArtifactSource.create.mockReset();
        activeAccountHostedArtifactSource.create.mockReturnValue(Object.freeze({
            kind: 'accountHosted' as const,
            readFile: async () => null,
        }));

        replacePluginAccountAvailabilityProjection({ scope, snapshot: current.snapshot });
        const acquired = await producer.acquire({
            reader: readerStore.bind(scope),
            artifactGraph: current.graph,
            cacheIdentity: current.cacheIdentity,
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicy(current.graph),
        });
        if (acquired.kind !== 'available') throw new Error('Expected the seeded persistent Artifact to materialize.');
        acquired.handle.dispose();

        clearPluginAccountAvailabilityProjection();
        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: snapshotWithAvailability({
                current,
                availabilityCursor: 2,
                version: '1.2.4',
            }),
        });

        await vi.waitFor(() => {
            expect(unregister).toHaveBeenCalledWith('opaque-disposed-projection-replacement');
        });
        expect(persistent.remove).not.toHaveBeenCalled();
        expect(persistent.removeAccount).not.toHaveBeenCalled();
        expect(persistent.readRecord()).toEqual(record);
    });

    it('binds initial Availability to Account retirement without deleting retained Artifact bytes', async () => {
        const current = fixture();
        const record = persistentRecordFor(current);
        const persistent = createNativePersistentStore({ initialRecord: record });
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar: Object.freeze({
                register: async () => nativeRegistrationAccepted,
                unregister: () => true,
            }),
            createOpaqueId: () => 'opaque-initial-projection-retirement',
        });
        const composition = createPluginReactNativeBundleCacheWithNativeArtifactResources({
            persistentStore: persistent.rawStore,
            registry,
        });
        const { lifetime, retire } = createLifetime();
        availabilityProjectionFixture.cache = composition.cache;
        availabilityProjectionFixture.lifetime = lifetime;

        replacePluginAccountAvailabilityProjection({ scope, snapshot: current.snapshot });
        retire();

        await vi.waitFor(() => {
            expect(composition.cache.isAccountCurrent(scope)).toBe(false);
        });
        expect(persistent.read).not.toHaveBeenCalled();
        expect(persistent.removeAccount).not.toHaveBeenCalled();
        expect(persistent.readRecord()).toEqual(record);
    });

    it('drops a cleared projection predecessor when its Account lifetime retires', () => {
        const current = fixture();
        const removePersistentArtifact = vi.fn(async () => undefined);
        const cache = Object.freeze({
            bindAccountLifetime: vi.fn(),
            removePersistentArtifact,
        });
        const retired = createLifetime();
        availabilityProjectionFixture.cache = cache;
        availabilityProjectionFixture.lifetime = retired.lifetime;

        replacePluginAccountAvailabilityProjection({ scope, snapshot: current.snapshot });
        clearPluginAccountAvailabilityProjection();
        retired.retire();

        const fresh = createLifetime();
        availabilityProjectionFixture.lifetime = fresh.lifetime;
        replacePluginAccountAvailabilityProjection({
            scope,
            snapshot: snapshotWithAvailability({
                current,
                availabilityCursor: 2,
                version: '1.2.4',
            }),
        });

        expect(removePersistentArtifact).not.toHaveBeenCalled();
    });

});
