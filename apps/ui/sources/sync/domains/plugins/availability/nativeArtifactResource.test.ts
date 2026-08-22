import { describe, expect, it, vi } from 'vitest';

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

import {
    createPluginReactNativeBundleCacheWithNativeArtifactResources,
} from '@/components/plugins/reactNative/bundleCache';
import {
    acquirePluginSelectedArtifactLease,
} from './artifactLease';
import {
    createPluginAccountAvailabilityReaderStore,
    type PluginAccountAvailabilitySnapshot,
} from './reader';
import {
    createPluginNativeArtifactResourcePersistentStore,
    createPluginNativeArtifactResourceRegistry,
    type PluginNativeArtifactPersistentStore,
    type PluginNativeArtifactResourceRegistrar,
} from './nativeArtifactResource';
import { projectSelectedHostedWebArtifactAvailability } from './hostedWebArtifactLease';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { PluginUiPersistentArtifactRecord } from '@/sync/domains/plugins/ui/artifactByteCache';

const nativeModuleMock = vi.hoisted(() => ({
    requireNativeModule: vi.fn(),
}));

vi.mock('expo-modules-core', async (importOriginal) => ({
    ...await importOriginal(),
    requireNativeModule: nativeModuleMock.requireNativeModule,
}));

const scope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });
const slot = Object.freeze({
    pluginId: 'com.acme.hosted',
    contributionId: 'hosted',
    tier: 'hostedWeb' as const,
    platform: 'web' as const,
});
const nativeRegistrationAccepted = Object.freeze({ kind: 'registered' as const });

function fixture(current: boolean) {
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
    const compatibility = {
        hostUiApiVersion: '1.0.0',
    };
    const response: PluginAccountAvailabilityIntentReadResponseV1 = {
        availabilityCursor: 1,
        hostingCapability: { enabled: false },
        intent: {
            pluginId: slot.pluginId,
            desiredVersion: '1.2.3',
            enabled: true,
            offlineUiHosting: 'disabled',
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
                compatibility,
            }],
            packageAssetArchive: {
                archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
                resources: [],
            },
        }),
        uiArtifacts: [],
    };
    return Object.freeze({
        snapshot: {
            availabilityCursor: 1,
            intentReads: current ? [{ pluginId: slot.pluginId, response }] : [],
            materializations: [],
        } satisfies PluginAccountAvailabilitySnapshot,
        graph: {
            contributionId: slot.contributionId,
            tier: slot.tier,
            platform: slot.platform,
            entry: entryPath,
            files,
            digest,
            builtWith: { bundler: 'vite' as const, version: '7.0.0' },
            hostUiApiVersion: '1.0.0',
            compat: {},
        },
        bytesByPath: new Map<string, Uint8Array>([
            [entryPath, entryBytes],
            [scriptPath, scriptBytes],
        ]),
    });
}

async function acquireFixtureLease(input: Readonly<{
    sourceKind?: 'appExact' | 'persistentCache';
}> = {}) {
    const current = fixture(true);
    const readerStore = createPluginAccountAvailabilityReaderStore();
    readerStore.replace({ scope, snapshot: current.snapshot });
    const sourceKind = input.sourceKind ?? 'appExact';
    const acquired = await acquirePluginSelectedArtifactLease({
        reader: readerStore.bind(scope),
        slot,
        artifactGraph: current.graph,
        sources: [{
            kind: sourceKind,
            readFile: async ({ relativePath }) => current.bytesByPath.get(relativePath) ?? null,
        }],
    });
    if (acquired.kind !== 'available') throw new Error('expected current Artifact lease');
    return Object.freeze({ current, readerStore, lease: acquired.lease });
}

function hostedWebPolicyInput(
    overrides: Partial<HostedWebAssetPolicyInput> = {},
): HostedWebAssetPolicyInput {
    const current = fixture(true);
    return Object.freeze({
        assetRootId: 'hosted-web/acme',
        entryPath: current.graph.entry,
        files: current.graph.files.map((file) => file.relativePath),
        digest: current.graph.digest,
        routeMode: 'pathFallback' as const,
        requestPath: '/',
        security: PluginHostedWebSecurityPolicyV1Schema.parse({}),
        sourceMaps: Object.freeze({ enabled: false }),
        ...overrides,
    });
}

function createPersistentStore(events: string[], present = false): PluginNativeArtifactPersistentStore {
    const records = new Map<string, PluginUiPersistentArtifactRecord>();
    return Object.freeze({
        read: async () => null,
        write: async (record) => {
            events.push('write');
            records.set(record.persistentIdentity.artifactDigest, record);
        },
        remove: async () => undefined,
        removeAccount: async () => undefined,
        describeNativeResource: async ({ identity, files }) => {
            events.push('describe');
            if (!present && !records.has(identity.artifactDigest)) return null;
            return Object.freeze({
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
            });
        },
    });
}

function createLifetime(lifetimeScope: ServerAccountScope = scope) {
    let retired = false;
    const listeners = new Set<() => void>();
    return Object.freeze({
        lifetime: Object.freeze({
            scope: lifetimeScope,
            isCurrent: () => !retired,
            onRetire: (listener: () => void) => {
                listeners.add(listener);
                return Object.freeze({ dispose: () => listeners.delete(listener) });
            },
        }),
        retire: () => {
            retired = true;
            for (const listener of [...listeners]) listener();
        },
    });
}

describe('native Artifact resource bridge', () => {
    it('refuses a non-hosted selected lease before it can reach the native Artifact registry', async () => {
        const { lease } = await acquireFixtureLease();
        const { lifetime } = createLifetime();
        const nonHostedLease = Object.freeze({
            ...lease,
            artifact: Object.freeze({ ...lease.artifact, tier: 'reactNative' as const }),
        });

        await expect(projectSelectedHostedWebArtifactAvailability({
            lease: nonHostedLease,
            persistent: Object.freeze({ scope, isCurrent: () => true }),
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicyInput(),
        })).resolves.toEqual({ kind: 'unavailable', code: 'hosted_web_artifact_tier_invalid' });
    });

    it('registers only a fully materialized verified file set and exposes no path or bytes to native', async () => {
        const { lease } = await acquireFixtureLease();
        const events: string[] = [];
        const register = vi.fn(async (input) => {
            events.push('register');
            return nativeRegistrationAccepted;
        });
        const unregister = vi.fn((_token: string) => true);
        const registrar: PluginNativeArtifactResourceRegistrar = Object.freeze({ register, unregister });
        let nextId = 0;
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar,
            createOpaqueId: () => `opaque-${++nextId}`,
        });
        const { lifetime } = createLifetime();

        const result = await registry.materialize({
            lease,
            persistent: Object.freeze({ scope, store: createPersistentStore(events), isCurrent: () => true }),
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicyInput(),
        });

        expect(result).toEqual(expect.objectContaining({ kind: 'available' }));
        if (result.kind !== 'available') throw new Error('expected native Artifact handle');
        expect(events).toEqual(['write', 'describe', 'register']);
        expect(result.handle.token).toBe('opaque-1');
        expect(result.handle.storagePartitionId).toMatch(/^hpa_[a-f0-9]{64}$/u);
        expect(result.handle.storagePartitionId).not.toContain(scope.accountId);
        expect(result.handle.policyTable).toEqual(expect.objectContaining({
            version: 1,
            routes: expect.arrayContaining([
                expect.objectContaining({ path: '' }),
                expect.objectContaining({ path: 'assets/app.js' }),
            ]),
        }));
        expect(register).toHaveBeenCalledWith(expect.objectContaining({
            token: 'opaque-1',
            storageLocator: {
                namespace: 'happier-plugin-ui-artifacts-v1',
                accountKeyHash: 'account-hash',
                artifactKeyHash: 'artifact-hash',
            },
            resources: [
                expect.objectContaining({ resourceId: 'r0', storedFileName: 'stored-1.bin' }),
                expect.objectContaining({ resourceId: 'r1', storedFileName: 'stored-0.bin' }),
            ],
        }));
        const nativeRegistration = register.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(nativeRegistration).not.toHaveProperty('relativePath');
        expect(nativeRegistration).not.toHaveProperty('bytes');
        expect(JSON.stringify(nativeRegistration)).not.toContain('hosted-web/acme');
        expect(unregister).not.toHaveBeenCalled();
    });

    it('preserves the exact native frame origin as an opaque adapter fact on the current handle', async () => {
        const { lease } = await acquireFixtureLease();
        const frameOrigin = `https://happier-hosted-artifact.hpa_${'a'.repeat(64)}`;
        const nativeRegistration = Object.freeze({ kind: 'registered' as const, frameOrigin });
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar: Object.freeze({
                register: async () => nativeRegistration,
                unregister: vi.fn(() => true),
            }),
            createOpaqueId: () => 'opaque-native-origin',
        });
        const { lifetime } = createLifetime();

        const result = await registry.materialize({
            lease,
            persistent: Object.freeze({ scope, store: createPersistentStore([]), isCurrent: () => true }),
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicyInput(),
        });

        expect(result).toEqual(expect.objectContaining({
            kind: 'available',
            handle: expect.objectContaining({ frameOrigin }),
        }));
    });

    it('preserves Android profile-isolation rejection from the real native registrar through Artifact acquisition', async () => {
        const { lease } = await acquireFixtureLease();
        const events: string[] = [];
        const profileIsolationUnavailable = Object.freeze({
            kind: 'unavailable' as const,
            code: 'hosted_web_profile_isolation_unavailable' as const,
            capability: 'DOCUMENT_START_SCRIPT' as const,
        });
        nativeModuleMock.requireNativeModule.mockReset();
        nativeModuleMock.requireNativeModule.mockReturnValue({
            registerArtifact: async () => profileIsolationUnavailable,
            unregisterArtifact: () => true,
        });
        vi.resetModules();
        const { createExpoPluginNativeArtifactResourceRegistrar } = await import('./nativeArtifactResourceRegistrar.native');
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar: createExpoPluginNativeArtifactResourceRegistrar(),
            createOpaqueId: () => 'opaque-profile-isolation',
        });
        const { lifetime } = createLifetime();

        await expect(registry.materialize({
            lease,
            persistent: Object.freeze({ scope, store: createPersistentStore(events), isCurrent: () => true }),
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicyInput(),
        })).resolves.toEqual(profileIsolationUnavailable);
    });

    it('fails closed when the canonical hosted-web policy would bind traversal outside its root', async () => {
        const { lease } = await acquireFixtureLease();
        const events: string[] = [];
        const register = vi.fn(async () => nativeRegistrationAccepted);
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar: Object.freeze({ register, unregister: vi.fn(() => true) }),
            createOpaqueId: (() => {
                let nextId = 0;
                return () => `opaque-${++nextId}`;
            })(),
        });
        const { lifetime } = createLifetime();

        await expect(registry.materialize({
            lease,
            persistent: Object.freeze({ scope, store: createPersistentStore(events), isCurrent: () => true }),
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicyInput({ entryPath: '../outside.js' }),
        })).resolves.toEqual({ kind: 'unavailable', code: 'native_artifact_response_table_invalid' });
        expect(register).not.toHaveBeenCalled();
    });

    it('rejects an Account lifetime that does not own the persistent Artifact scope', async () => {
        const { lease } = await acquireFixtureLease();
        const register = vi.fn(async () => nativeRegistrationAccepted);
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar: Object.freeze({ register, unregister: vi.fn(() => true) }),
            createOpaqueId: () => 'opaque-mismatched-account',
        });
        const { lifetime } = createLifetime(Object.freeze({
            serverId: 'server-other',
            accountId: 'account-other',
        }));

        await expect(registry.materialize({
            lease,
            persistent: Object.freeze({ scope, store: createPersistentStore([]), isCurrent: () => true }),
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicyInput(),
        })).resolves.toEqual({ kind: 'unavailable', code: 'artifact_lease_revoked' });
        expect(register).not.toHaveBeenCalled();
    });

    it('unregisters the opaque token synchronously when its selected Artifact lease revokes', async () => {
        const { lease, readerStore } = await acquireFixtureLease();
        const events: string[] = [];
        const unregister = vi.fn((_token: string) => true);
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar: Object.freeze({ register: async () => nativeRegistrationAccepted, unregister }),
            createOpaqueId: (() => {
                let nextId = 0;
                return () => `opaque-${++nextId}`;
            })(),
        });
        const { lifetime } = createLifetime();
        const result = await registry.materialize({
            lease,
            persistent: Object.freeze({ scope, store: createPersistentStore(events), isCurrent: () => true }),
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicyInput(),
        });
        if (result.kind !== 'available') throw new Error('expected native Artifact handle');

        readerStore.replace({ scope, snapshot: fixture(false).snapshot });

        expect(result.handle.isCurrent()).toBe(false);
        expect(unregister).toHaveBeenCalledTimes(1);
        expect(unregister).toHaveBeenCalledWith(result.handle.token);
    });

    it('unregisters a native token when the selected Artifact lease revokes during registration', async () => {
        const { lease, readerStore } = await acquireFixtureLease();
        const events: string[] = [];
        let enterNativeRegistration: (() => void) | undefined;
        const nativeRegistrationEntered = new Promise<void>((resolve) => {
            enterNativeRegistration = resolve;
        });
        let resolveNativeRegistration: ((result: typeof nativeRegistrationAccepted) => void) | undefined;
        const nativeRegistration = new Promise<typeof nativeRegistrationAccepted>((resolve) => {
            resolveNativeRegistration = resolve;
        });
        const unregister = vi.fn(() => true);
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar: Object.freeze({
                register: vi.fn(async () => {
                    enterNativeRegistration?.();
                    return await nativeRegistration;
                }),
                unregister,
            }),
            createOpaqueId: () => 'opaque-late-registration',
        });
        const { lifetime } = createLifetime();

        const pending = registry.materialize({
            lease,
            persistent: Object.freeze({ scope, store: createPersistentStore(events), isCurrent: () => true }),
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicyInput(),
        });

        await nativeRegistrationEntered;
        readerStore.replace({ scope, snapshot: fixture(false).snapshot });
        resolveNativeRegistration?.(nativeRegistrationAccepted);

        await expect(pending).resolves.toEqual({ kind: 'unavailable', code: 'artifact_lease_revoked' });
        expect(unregister).toHaveBeenCalledWith('opaque-late-registration');
    });

    it('keeps a failed native teardown indexed and refuses replacement until native denies the stale token', async () => {
        const first = await acquireFixtureLease();
        const events: string[] = [];
        const register = vi.fn(async () => nativeRegistrationAccepted);
        const unregister = vi.fn()
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(true);
        const diagnostic = vi.fn();
        let nextId = 0;
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar: Object.freeze({ register, unregister }),
            createOpaqueId: () => `opaque-${++nextId}`,
            onNativeTeardownDiagnostic: diagnostic,
        });
        const { lifetime } = createLifetime();
        const persistent = Object.freeze({
            scope,
            store: createPersistentStore(events),
            isCurrent: () => true,
        });
        const initial = await registry.materialize({
            lease: first.lease,
            persistent,
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicyInput(),
        });
        if (initial.kind !== 'available') throw new Error('expected initial native Artifact handle');
        let locallyRevoked = false;
        initial.handle.onRevoke(() => {
            locallyRevoked = true;
        });

        first.readerStore.replace({ scope, snapshot: fixture(false).snapshot });
        expect(locallyRevoked).toBe(true);
        expect(unregister).toHaveBeenCalledTimes(1);

        const replacement = await acquireFixtureLease();
        await expect(registry.materialize({
            lease: replacement.lease,
            persistent,
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicyInput(),
        })).resolves.toEqual({ kind: 'unavailable', code: 'native_artifact_revocation_pending' });
        expect(register).toHaveBeenCalledTimes(1);
        expect(unregister).toHaveBeenCalledTimes(2);
        expect(diagnostic).toHaveBeenCalledTimes(2);

        await expect(registry.materialize({
            lease: replacement.lease,
            persistent,
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicyInput(),
        })).resolves.toEqual(expect.objectContaining({ kind: 'available' }));
        expect(unregister).toHaveBeenCalledTimes(3);
        expect(register).toHaveBeenCalledTimes(2);
    });

    it('does not replace or remove persistent bytes until native acknowledges token denial', async () => {
        const first = await acquireFixtureLease();
        const events: string[] = [];
        const remove = vi.fn(async () => undefined);
        const unregister = vi.fn()
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(true);
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar: Object.freeze({ register: async () => nativeRegistrationAccepted, unregister }),
            createOpaqueId: () => 'opaque-cache-removal',
        });
        const backing: PluginNativeArtifactPersistentStore = Object.freeze({
            ...createPersistentStore(events),
            remove,
        });
        const store = createPluginNativeArtifactResourcePersistentStore({
            store: backing,
            registry,
        });
        const { lifetime } = createLifetime();
        const materialized = await registry.materialize({
            lease: first.lease,
            persistent: Object.freeze({ scope, store, isCurrent: () => true }),
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicyInput(),
        });
        if (materialized.kind !== 'available') throw new Error('expected native Artifact handle');
        const identity = {
            accountScope: scope,
            releaseVersion: first.lease.artifact.releaseVersion,
            pluginId: first.lease.artifact.pluginId,
            contributionId: first.lease.artifact.contributionId,
            tier: first.lease.artifact.tier,
            platform: first.lease.artifact.platform,
            artifactDigest: first.lease.artifact.digest,
        };

        first.readerStore.replace({ scope, snapshot: fixture(false).snapshot });

        await expect(store.remove(identity)).rejects.toThrow('native_artifact_revocation_pending');
        expect(remove).not.toHaveBeenCalled();
        expect(unregister).toHaveBeenCalledTimes(2);

        await expect(store.remove(identity)).resolves.toBeUndefined();
        expect(remove).toHaveBeenCalledWith(identity);
        expect(unregister).toHaveBeenCalledTimes(3);
    });

    it('revokes installed-cache native tokens on Account retirement without deleting retained bytes', async () => {
        const { lease } = await acquireFixtureLease();
        const events: string[] = [];
        const removeAccount = vi.fn(async () => undefined);
        const unregister = vi.fn()
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(true);
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar: Object.freeze({ register: async () => nativeRegistrationAccepted, unregister }),
            createOpaqueId: () => 'opaque-installed-cache-retirement',
        });
        const backing: PluginNativeArtifactPersistentStore = Object.freeze({
            ...createPersistentStore(events),
            removeAccount,
        });
        const composition = createPluginReactNativeBundleCacheWithNativeArtifactResources({
            persistentStore: backing,
            registry,
        });
        const { lifetime } = createLifetime();
        const materialized = await registry.materialize({
            lease,
            persistent: Object.freeze({
                scope,
                store: composition.nativePersistentStore,
                isCurrent: () => true,
            }),
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicyInput(),
        });
        if (materialized.kind !== 'available') throw new Error('expected native Artifact handle');

        await composition.cache.retireAccount(scope);

        expect(unregister).toHaveBeenCalledWith(materialized.handle.token);
        expect(removeAccount).not.toHaveBeenCalled();

        await composition.cache.retireAccount(scope);

        expect(unregister).toHaveBeenCalledTimes(2);
        expect(removeAccount).not.toHaveBeenCalled();
    });

    it('unregisters every concurrent token for an Account before the next Account may use the cache', async () => {
        const { lease } = await acquireFixtureLease({ sourceKind: 'persistentCache' });
        const events: string[] = [];
        const unregister = vi.fn((_token: string) => true);
        const registry = createPluginNativeArtifactResourceRegistry({
            registrar: Object.freeze({ register: async () => nativeRegistrationAccepted, unregister }),
            createOpaqueId: (() => {
                let nextId = 0;
                return () => `opaque-${++nextId}`;
            })(),
        });
        const { lifetime, retire } = createLifetime();
        const persistent = Object.freeze({ scope, store: createPersistentStore(events, true), isCurrent: () => true });
        // A persistent-source lease already proved this cache record before it
        // reached this native consumer; the bridge must not rewrite it while
        // two current frames register independent opaque tokens.
        const first = registry.materialize({
            lease,
            persistent,
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicyInput(),
        });
        const second = registry.materialize({
            lease,
            persistent,
            accountLifetime: lifetime,
            isCurrent: () => true,
            hostedWebPolicy: hostedWebPolicyInput(),
        });

        const [firstResult, secondResult] = await Promise.all([first, second]);
        expect(firstResult).toEqual(expect.objectContaining({ kind: 'available' }));
        expect(secondResult).toEqual(expect.objectContaining({ kind: 'available' }));
        expect(events).not.toContain('write');

        retire();

        expect(unregister).toHaveBeenCalledTimes(2);
        expect(new Set(unregister.mock.calls.map(([token]) => token))).toEqual(new Set(['opaque-1', 'opaque-2']));
    });
});
