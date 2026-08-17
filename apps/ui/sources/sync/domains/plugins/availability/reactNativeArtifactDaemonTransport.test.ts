import { afterEach, describe, expect, it, vi } from 'vitest';

import { RPC_METHODS } from '@happier-dev/protocol/rpc';

const guardedMachineRpc = vi.hoisted(() => vi.fn());

vi.mock('@/components/plugins/reactNative/hostRuntimeIdentity', () => ({
    resolveNativeReactNativeHostRuntimeIdentity: () => null,
    resolveReactNativeWebLoaderCapability: () => null,
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: (...args: unknown[]) => guardedMachineRpc(...args),
}));

import {
    fetchReactNativeExactArtifactBytesViaMachineRpc,
} from './reactNativeArtifactDaemonTransport';

const identity = {
    pluginId: 'acme.preview',
    contributionId: 'native-preview',
    artifactDigest: `sha256:${'a'.repeat(64)}`,
    hostAppVersion: '2.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.2.0',
    reactNativeVersion: '0.83.4',
    platform: 'web',
    channel: 'internal',
    nativeCapabilitiesDigest: `sha256:${'b'.repeat(64)}`,
    projectionGeneration: 44,
} as const;

const crashStateToken = {
    mount: {
        kind: 'destination',
        destination: { pluginId: 'acme.preview', localId: 'preview-destination' },
    },
    renderer: { pluginId: 'acme.preview', localId: 'native-preview' },
    artifactDigest: identity.artifactDigest,
    crashStateEpoch: 7,
} as const;

const composerCrashStateToken = {
    mount: {
        kind: 'composer',
        contribution: { pluginId: 'acme.preview', localId: 'composer-region' },
        immutableGenerationId: 'composer-generation-7',
        role: 'region',
    },
    renderer: { pluginId: 'acme.preview', localId: 'native-preview' },
    artifactDigest: identity.artifactDigest,
    crashStateEpoch: 7,
} as const;

const origin = {
    serverIdentityId: 'srv_server_a',
    materializationRef: {
        machineId: 'machine-a',
        materializationId: 'materialization-a',
        pluginId: identity.pluginId,
    },
} as const;

describe('React Native exact Artifact daemon transport', () => {
    afterEach(() => {
        guardedMachineRpc.mockReset();
    });

    it('carries the exact generated crash-state token on an Artifact byte read', async () => {
        guardedMachineRpc.mockResolvedValue({
            ok: false,
            code: 'artifact_unavailable',
            diagnostics: [],
        });

        await expect(fetchReactNativeExactArtifactBytesViaMachineRpc({
            origin,
            serverId: 'server-a',
            identity,
            artifactOwnerKind: 'renderer',
            crashStateToken,
        })).resolves.toEqual({
            ok: false,
            code: 'artifact_unavailable',
            diagnostics: [],
        });

        expect(guardedMachineRpc).toHaveBeenCalledWith({
            machineId: 'machine-a',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ,
            payload: {
                artifactFamily: 'reactNative',
                artifactOwnerKind: 'renderer',
                machineId: 'machine-a',
                cacheIdentity: identity,
                crashStateToken,
            },
        });
    });

    it('reads an exact candidate artifact through the private collection-migrations arm without renderer crash authority', async () => {
        guardedMachineRpc.mockResolvedValue({
            ok: false,
            code: 'artifact_unavailable',
            diagnostics: [],
        });

        await expect(fetchReactNativeExactArtifactBytesViaMachineRpc({
            origin,
            serverId: 'server-a',
            identity,
            artifactOwnerKind: 'collectionMigrations',
        })).resolves.toEqual({
            ok: false,
            code: 'artifact_unavailable',
            diagnostics: [],
        });

        expect(guardedMachineRpc).toHaveBeenCalledWith({
            machineId: 'machine-a',
            serverId: 'server-a',
            method: RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ,
            payload: {
                artifactFamily: 'reactNative',
                artifactOwnerKind: 'collectionMigrations',
                machineId: 'machine-a',
                cacheIdentity: identity,
            },
        });
    });

    it('accepts an echoed targeted-surface crash token without collapsing it into a destination', async () => {
        const targetedCrashStateToken = {
            mount: {
                kind: 'targetedSurface',
                target: { pluginId: 'acme.target', immutableGenerationId: 'target-generation' },
                point: { pointId: 'providers', protocol: { id: 'provider', version: 1 } },
                contributor: {
                    pluginId: 'acme.preview',
                    contributionId: 'provider-detail',
                    immutableGenerationId: 'contributor-generation',
                },
                role: 'detail',
                presentation: 'content',
            },
            renderer: { pluginId: 'acme.preview', localId: 'native-preview' },
            artifactDigest: identity.artifactDigest,
            crashStateEpoch: 7,
        } as const;
        const response = {
            ok: true,
            artifactFamily: 'reactNative',
            artifactOwnerKind: 'renderer',
            cacheIdentity: identity,
            crashStateToken: targetedCrashStateToken,
            artifact: {
                pluginId: identity.pluginId,
                contributionId: identity.contributionId,
                artifactKind: 'reactNativeBundle',
                digest: identity.artifactDigest,
                format: 'plainJs',
                byteSize: 1,
            },
            bytesBase64: 'YQ==',
            files: [{
                relativePath: 'react-native/acme/index.js',
                digest: `sha256:${'c'.repeat(64)}`,
                byteSize: 1,
                bytesBase64: 'YQ==',
            }],
        } as const;
        guardedMachineRpc.mockResolvedValue(response);

        await expect(fetchReactNativeExactArtifactBytesViaMachineRpc({
            origin,
            serverId: 'server-a',
            identity,
            artifactOwnerKind: 'renderer',
            crashStateToken: targetedCrashStateToken,
        })).resolves.toEqual(response);

        guardedMachineRpc.mockResolvedValue({
            ...response,
            crashStateToken: {
                ...targetedCrashStateToken,
                mount: {
                    ...targetedCrashStateToken.mount,
                    contributor: {
                        ...targetedCrashStateToken.mount.contributor,
                        immutableGenerationId: 'replaced-contributor-generation',
                    },
                },
            },
        });

        await expect(fetchReactNativeExactArtifactBytesViaMachineRpc({
            origin,
            serverId: 'server-a',
            identity,
            artifactOwnerKind: 'renderer',
            crashStateToken: targetedCrashStateToken,
        })).resolves.toEqual({
            ok: false,
            code: 'artifact_unavailable',
            diagnostics: ['react_native_artifact_bytes_response_crash_state_mismatch'],
        });
    });

    it('accepts an echoed current Composer crash token and rejects every changed Composer binding fact', async () => {
        const response = {
            ok: true,
            artifactFamily: 'reactNative',
            artifactOwnerKind: 'renderer',
            cacheIdentity: identity,
            crashStateToken: composerCrashStateToken,
            artifact: {
                pluginId: identity.pluginId,
                contributionId: identity.contributionId,
                artifactKind: 'reactNativeBundle',
                digest: identity.artifactDigest,
                format: 'plainJs',
                byteSize: 1,
            },
            bytesBase64: 'YQ==',
            files: [{
                relativePath: 'react-native/acme/composer.js',
                digest: `sha256:${'c'.repeat(64)}`,
                byteSize: 1,
                bytesBase64: 'YQ==',
            }],
        } as const;
        guardedMachineRpc.mockResolvedValue(response);

        await expect(fetchReactNativeExactArtifactBytesViaMachineRpc({
            origin,
            serverId: 'server-a',
            identity,
            artifactOwnerKind: 'renderer',
            crashStateToken: composerCrashStateToken,
        })).resolves.toEqual(response);

        const staleTokens = [
            {
                ...composerCrashStateToken,
                mount: {
                    ...composerCrashStateToken.mount,
                    contribution: {
                        ...composerCrashStateToken.mount.contribution,
                        pluginId: 'acme.replaced',
                    },
                },
            },
            {
                ...composerCrashStateToken,
                mount: {
                    ...composerCrashStateToken.mount,
                    contribution: {
                        ...composerCrashStateToken.mount.contribution,
                        localId: 'replaced-composer-region',
                    },
                },
            },
            {
                ...composerCrashStateToken,
                mount: {
                    ...composerCrashStateToken.mount,
                    immutableGenerationId: 'replaced-composer-generation',
                },
            },
            {
                ...composerCrashStateToken,
                mount: {
                    ...composerCrashStateToken.mount,
                    role: 'attachmentPreview',
                },
            },
            {
                ...composerCrashStateToken,
                renderer: {
                    ...composerCrashStateToken.renderer,
                    localId: 'replaced-native-preview',
                },
            },
        ] as const;

        for (const staleToken of staleTokens) {
            guardedMachineRpc.mockResolvedValue({
                ...response,
                crashStateToken: staleToken,
            });

            await expect(fetchReactNativeExactArtifactBytesViaMachineRpc({
                origin,
                serverId: 'server-a',
                identity,
                artifactOwnerKind: 'renderer',
                crashStateToken: composerCrashStateToken,
            })).resolves.toEqual({
                ok: false,
                code: 'artifact_unavailable',
                diagnostics: ['react_native_artifact_bytes_response_crash_state_mismatch'],
            });
        }
    });
});
