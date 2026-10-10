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

import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    PluginUiArtifactDigestV1Schema,
} from '@happier-dev/protocol/plugins/ui';
import {
    PluginAccountAvailabilityIntentReadResponseV1Schema,
    PluginReleaseFactsV1Schema,
    type PluginMachineMaterializationV1,
} from '@happier-dev/protocol/plugins/availability';

import { encodeBase64 } from '@/encryption/base64';
import type {
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
    fetch: async () => null,
});
const inactiveAccountHostedSource = Object.freeze({
    kind: 'accountHosted' as const,
    fetch: async () => null,
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
}> = {}) {
    const offlineUiHosting = input.offlineUiHosting ?? 'enabled';
    const hostingCapabilityEnabled = input.hostingCapabilityEnabled ?? true;
    const alreadyHosted = input.alreadyHosted ?? false;
    const contributionId = 'native-preview';
    const artifactId = 'native-preview-artifact';
    const entryPath = `react-native/${artifactId}/entry.cjs.bundle`;
    const entryBytes = new TextEncoder().encode('globalThis.__acmeEntry = true;');
    const files = [
        {
            relativePath: entryPath,
            digest: computePluginUiArtifactSha256DigestV1(entryBytes),
            byteSize: entryBytes.byteLength,
        },
    ] as const;
    const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
        { relativePath: entryPath, bytes: entryBytes },
    ]);
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
            artifactId,
            tier: 'reactNative',
            platform: 'ios',
            artifactDigest,
            hostUiApiRange: '^1.0.0',
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
        uiArtifacts: [{
            contributionId,
            artifactId,
            tier: 'reactNative',
            platform: 'ios',
            artifactDigest,
            hostUiApiRange: '^1.0.0',
        }],
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
                packageAssets: [],
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
                        artifactId,
                        tier: 'reactNative' as const,
                        platform: 'ios' as const,
                        accountArtifactId: '00000000-0000-4000-8000-000000000001',
                        artifactDigest,
                        hostUiApiRange: '^1.0.0',
                    }]
                    : [],
            }),
        }],
        materializations: [materialization],
        snapshots: [{
            serverIdentityId: materialization.serverIdentityId,
            machineId: materialization.machineId,
            materializations: [materialization],
        }],
    } satisfies PluginAccountAvailabilitySnapshot;
    const reader = createPluginAccountAvailabilityReader({ scope, snapshot });
    const cacheIdentity = {
        pluginId: materialization.pluginId,
        contributionId,
        artifactId,
        artifactDigest,
        platform: 'ios' as const,
    } satisfies PluginReactNativeBundleCacheIdentity;
    const graph = {
        artifactId,
        tier: 'reactNative' as const,
        entry: entryPath,
        files,
        digest: artifactDigest,
        builtWith: { bundler: 'esbuild' as const, version: '0.25.0' },
        executable: { exports: ['renderSurface'] as const },
        hostUiApiRange: '^1.0.0',
    };
    const origin = {
        serverIdentityId: materialization.serverIdentityId,
        materializationRef: {
            machineId: materialization.machineId,
            materializationId: materialization.materializationId,
            pluginId: materialization.pluginId,
        },
    } as const;
    const daemonResponse: DaemonPluginUiArtifactBytesReadResponse = {
        ok: true as const,
        artifactFamily: 'reactNative' as const,
        cacheIdentity: { artifactDigest },
        artifact: {
            artifactKind: 'reactNativeBundle' as const,
            digest: artifactDigest,
            format: 'plainJs' as const,
            byteSize: entryBytes.byteLength,
        },
        files: [
            { ...files[0], bytesBase64: encodeBase64(entryBytes) },
        ],
    };
    return {
        reader,
        cacheIdentity,
        graph,
        origin,
        daemonResponse,
        contributionId,
        artifactDigest,
        entryPath,
        entryBytes,
    };
}

async function acquireFromDaemon(current: ReturnType<typeof fixture>) {
    return await acquirePluginReactNativeArtifactLease({
        reader: current.reader,
        artifactGraph: current.graph,
        cacheIdentity: current.cacheIdentity,
        accountLifetime,
        appExact: inactiveAppExactSource,
        daemon: { machineId: current.origin.materializationRef.machineId, serverId: scope.serverId },
        fetchDaemonArtifactBytes: async () => current.daemonResponse,
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
                artifactId: 'native-preview-artifact',
                tier: 'reactNative',
                platform: 'ios',
                artifactDigest: current.artifactDigest,
                hostUiApiRange: '^1.0.0',
            },
            artifactGraph: current.graph,
        });
        expect(published.files).toEqual([
            { relativePath: current.entryPath, bytes: current.entryBytes },
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
});
