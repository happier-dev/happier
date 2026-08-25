import { beforeEach, describe, expect, it, vi } from 'vitest';

const activeAccountHostedArtifact = vi.hoisted(() => ({
    createSource: vi.fn(),
    publish: vi.fn(),
}));

vi.mock('@/sync/api/plugins/availability/activePluginAccountHostedArtifactRead', () => ({
    createActivePluginAccountHostedArtifactSourceCandidate: (input: unknown) => (
        activeAccountHostedArtifact.createSource(input)
    ),
    publishActivePluginAccountHostedArtifact: (input: unknown) => (
        activeAccountHostedArtifact.publish(input)
    ),
}));
vi.mock('./reactNativeArtifactDaemonTransport', () => ({
    fetchReactNativeExactArtifactBytesViaMachineRpc: vi.fn(() => {
        throw new Error('The daemon transport is supplied explicitly by this test.');
    }),
}));

import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    derivePluginUiNativeCapabilitiesDigestV1,
    PluginUiArtifactDigestV1Schema,
} from '@happier-dev/protocol/plugins/ui';
import {
    PluginAccountAvailabilityIntentReadResponseV1Schema,
    PluginReleaseFactsV1Schema,
    type PluginMachineMaterializationV1,
} from '@happier-dev/protocol/plugins/availability';

import { encodeBase64 } from '@/encryption/base64';
import type {
    DaemonPluginReactNativeCrashBindingTokenV1,
    DaemonPluginUiArtifactBytesReadResponse,
} from '@happier-dev/protocol';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { PluginReactNativeBundleCacheIdentity } from '@/sync/domains/plugins/ui/reactNativeRuntime';

import {
    createPluginAccountAvailabilityReader,
    type PluginAccountAvailabilitySnapshot,
} from './reader';
import { acquirePluginReactNativeArtifactLease } from './reactNativeArtifactLease';

const scope = { serverId: 'server-a', accountId: 'account-a' } as const;

const accountLifetime: ActiveServerAccountScopeLifetime = Object.freeze({
    scope,
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose: () => {} }),
});

const inactiveAppExactSource = Object.freeze({
    kind: 'appExact' as const,
    readFile: async () => null,
});
const inactiveAccountHostedSource = Object.freeze({
    kind: 'accountHosted' as const,
    readFile: async () => null,
});

beforeEach(() => {
    activeAccountHostedArtifact.createSource.mockReset();
    activeAccountHostedArtifact.createSource.mockReturnValue(inactiveAccountHostedSource);
    activeAccountHostedArtifact.publish.mockReset();
    activeAccountHostedArtifact.publish.mockResolvedValue(Object.freeze({
        kind: 'published',
        value: { outcome: 'created' },
    }));
});

function fixture(input: Readonly<{
    offlineUiHosting?: 'enabled' | 'disabled';
    hostingCapabilityEnabled?: boolean;
    alreadyHosted?: boolean;
    nativeCapabilitiesDigest?: `sha256:${string}`;
}> = {}) {
    const offlineUiHosting = input.offlineUiHosting ?? 'enabled';
    const hostingCapabilityEnabled = input.hostingCapabilityEnabled ?? true;
    const alreadyHosted = input.alreadyHosted ?? false;
    const contributionId = 'native-preview';
    const entryPath = 'react-native/acme/ios.bundle';
    const chunkPath = 'react-native/acme/chunk.js';
    const entryBytes = new TextEncoder().encode('globalThis.__acmeEntry = true;');
    const chunkBytes = new TextEncoder().encode('globalThis.__acmeChunk = true;');
    const files = [
        {
            relativePath: entryPath,
            digest: computePluginUiArtifactSha256DigestV1(entryBytes),
            byteSize: entryBytes.byteLength,
        },
        {
            relativePath: chunkPath,
            digest: computePluginUiArtifactSha256DigestV1(chunkBytes),
            byteSize: chunkBytes.byteLength,
        },
    ] as const;
    const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
        { relativePath: entryPath, bytes: entryBytes },
        { relativePath: chunkPath, bytes: chunkBytes },
    ]);
    const compatibility = {
        hostUiApiVersion: '1.0.0',
        reactVersion: '19.0.0',
        reactNativeVersion: '0.83.4',
        expoRuntimeVersion: '0.2.0-native',
        hermesVersion: '0.15.0',
    };
    const adoptionCompatibility = {
        ...compatibility,
        hostAppVersion: '2.0.0',
        platform: 'ios' as const,
        channel: 'internal',
        nativeCapabilities: [],
    };
    const release = PluginReleaseFactsV1Schema.parse({
        ref: { pluginId: 'com.acme.preview', version: '1.2.3' },
        archiveDigestSha256: PluginUiArtifactDigestV1Schema.parse(`sha256:${'a'.repeat(64)}`),
        normalizedManifest: {
            schemaVersion: 2,
            id: 'com.acme.preview',
            version: '1.2.3',
            displayName: 'Acme preview',
            engines: { happier: '^1.0.0' },
            runtime: { apiVersion: 1 },
            contributes: {},
        },
        collectionContracts: [],
        uiSlots: [{
            contributionId,
            tier: 'reactNative',
            platform: 'ios',
            artifactDigest,
            compatibility,
        }],
        packageAssetArchive: {
            archiveDigestSha256: `sha256:${'d'.repeat(64)}`,
            resources: [],
        },
    });
    const materialization: PluginMachineMaterializationV1 = {
        serverIdentityId: 'srv_account_one',
        machineId: 'machine-a',
        materializationId: 'install-epoch-a',
        pluginId: 'com.acme.preview',
        version: '1.2.3',
        sourceClass: 'versionedArchive',
        portableRelease: true,
        archiveDigestSha256: PluginUiArtifactDigestV1Schema.parse(`sha256:${'a'.repeat(64)}`),
        uiArtifacts: [{ contributionId, tier: 'reactNative', platform: 'ios', artifactDigest }],
        enabled: true,
        trustState: 'trusted',
        observedAt: 1,
    };
    const snapshot = {
        availabilityCursor: 7,
        intentReads: [{
            pluginId: materialization.pluginId,
            response: PluginAccountAvailabilityIntentReadResponseV1Schema.parse({
                availabilityCursor: 7,
                hostingCapability: hostingCapabilityEnabled
                    ? { enabled: true, maxArtifactBytes: 1024, maxAccountBytes: 2048 }
                    : { enabled: false },
                intent: {
                    pluginId: materialization.pluginId,
                    desiredVersion: materialization.version,
                    enabled: true,
                    offlineUiHosting,
                    writableCollections: [],
                    revision: 'intent-1',
                },
                release,
                uiArtifacts: alreadyHosted
                    ? [{
                        release: { pluginId: materialization.pluginId, version: materialization.version },
                        contributionId,
                        tier: 'reactNative' as const,
                        platform: 'ios' as const,
                        artifactId: '00000000-0000-4000-8000-000000000001',
                        artifactDigest,
                        compatibility: adoptionCompatibility,
                    }]
                    : [],
            }),
        }],
        materializations: [materialization],
        snapshots: [{
            serverIdentityId: materialization.serverIdentityId,
            machineId: materialization.machineId,
            revision: 1,
            materializations: [materialization],
        }],
    } satisfies PluginAccountAvailabilitySnapshot;
    const reader = createPluginAccountAvailabilityReader({ scope, snapshot });
    const cacheIdentity = {
        pluginId: materialization.pluginId,
        contributionId,
        artifactDigest,
        hostAppVersion: adoptionCompatibility.hostAppVersion,
        hostUiApiVersion: compatibility.hostUiApiVersion,
        reactVersion: compatibility.reactVersion,
        reactNativeVersion: compatibility.reactNativeVersion,
        expoRuntimeVersion: compatibility.expoRuntimeVersion,
        hermesVersion: compatibility.hermesVersion,
        platform: adoptionCompatibility.platform,
        channel: adoptionCompatibility.channel,
        nativeCapabilitiesDigest: input.nativeCapabilitiesDigest
            ?? derivePluginUiNativeCapabilitiesDigestV1([]),
        projectionGeneration: 12,
    } satisfies PluginReactNativeBundleCacheIdentity;
    const graph = {
        contributionId,
        tier: 'reactNative' as const,
        platform: 'ios' as const,
        entry: entryPath,
        files,
        digest: artifactDigest,
        builtWith: { bundler: 'repack' as const, version: '5.0.0' },
        repack: { containerName: 'acme_preview', modulePath: './renderSurface', exportName: 'renderSurface' },
        hostUiApiVersion: compatibility.hostUiApiVersion,
        compat: {
            react: compatibility.reactVersion,
            reactNative: compatibility.reactNativeVersion,
            expoRuntime: compatibility.expoRuntimeVersion,
            hermes: compatibility.hermesVersion,
        },
    };
    const origin = {
        serverIdentityId: materialization.serverIdentityId,
        materializationRef: {
            machineId: materialization.machineId,
            materializationId: materialization.materializationId,
            pluginId: materialization.pluginId,
        },
    } as const;
    const crashStateToken: DaemonPluginReactNativeCrashBindingTokenV1 = {
        mount: {
            kind: 'destination' as const,
            destination: { pluginId: cacheIdentity.pluginId, localId: 'native-destination' },
        },
        renderer: { pluginId: cacheIdentity.pluginId, localId: contributionId },
        artifactDigest,
        crashStateEpoch: 4,
    };
    const daemonResponse: DaemonPluginUiArtifactBytesReadResponse = {
        ok: true as const,
        artifactFamily: 'reactNative' as const,
        artifactOwnerKind: 'renderer' as const,
        cacheIdentity,
        crashStateToken,
        artifact: {
            pluginId: cacheIdentity.pluginId,
            contributionId,
            artifactKind: 'reactNativeBundle' as const,
            digest: artifactDigest,
            format: 'plainJs' as const,
            byteSize: entryBytes.byteLength,
        },
        bytesBase64: encodeBase64(entryBytes),
        files: [
            { ...files[0], bytesBase64: encodeBase64(entryBytes) },
            { ...files[1], bytesBase64: encodeBase64(chunkBytes) },
        ],
    };
    return {
        reader,
        cacheIdentity,
        graph,
        origin,
        crashStateToken,
        daemonResponse,
        contributionId,
        artifactDigest,
        compatibility,
        adoptionCompatibility,
        entryPath,
        chunkPath,
        entryBytes,
        chunkBytes,
    };
}

async function acquireFromDaemon(current: ReturnType<typeof fixture>) {
    return await acquirePluginReactNativeArtifactLease({
        reader: current.reader,
        artifactGraph: current.graph,
        cacheIdentity: current.cacheIdentity,
        accountLifetime,
        appExact: inactiveAppExactSource,
        artifactOwnerKind: 'renderer',
        crashStateToken: current.crashStateToken,
        daemon: {
            origin: current.origin,
            serverId: scope.serverId,
            fetchArtifactBytes: async () => current.daemonResponse,
        },
    });
}

describe('Account-hosted plugin UI Artifact publication', () => {
    it('publishes the verified daemon archive for an opted-in slot that has no committed link', async () => {
        const current = fixture();

        const acquired = await acquireFromDaemon(current);
        expect(acquired.kind).toBe('available');

        expect(activeAccountHostedArtifact.publish).toHaveBeenCalledTimes(1);
        const published = activeAccountHostedArtifact.publish.mock.calls[0]![0] as Record<string, unknown>;
        expect(published).toMatchObject({
            accountLifetime,
            release: { pluginId: 'com.acme.preview', version: '1.2.3' },
            slot: {
                contributionId: current.contributionId,
                tier: 'reactNative',
                platform: 'ios',
                artifactDigest: current.artifactDigest,
                compatibility: current.compatibility,
            },
            hostCompatibility: current.adoptionCompatibility,
            artifactGraph: current.graph,
        });
        expect(published.files).toEqual([
            { relativePath: current.entryPath, bytes: current.entryBytes },
            { relativePath: current.chunkPath, bytes: current.chunkBytes },
        ]);
    });

    it('never uploads archive bytes while the Account has not opted into offline UI hosting', async () => {
        const current = fixture({ offlineUiHosting: 'disabled' });

        const acquired = await acquireFromDaemon(current);
        expect(acquired.kind).toBe('available');
        expect(activeAccountHostedArtifact.publish).not.toHaveBeenCalled();
    });

    it('never uploads archive bytes while the server has not enabled Artifact hosting', async () => {
        const current = fixture({ hostingCapabilityEnabled: false });

        const acquired = await acquireFromDaemon(current);
        expect(acquired.kind).toBe('available');
        expect(activeAccountHostedArtifact.publish).not.toHaveBeenCalled();
    });

    it('does not republish a slot whose exact qualified Artifact link is already committed', async () => {
        const current = fixture({ alreadyHosted: true });

        const acquired = await acquireFromDaemon(current);
        expect(acquired.kind).toBe('available');
        expect(activeAccountHostedArtifact.publish).not.toHaveBeenCalled();
    });

    it('refuses publication when the host cannot describe its own native capability set', async () => {
        const current = fixture({ nativeCapabilitiesDigest: `sha256:${'b'.repeat(64)}` });

        const acquired = await acquireFromDaemon(current);
        expect(acquired.kind).toBe('available');
        expect(activeAccountHostedArtifact.publish).not.toHaveBeenCalled();
    });
});
