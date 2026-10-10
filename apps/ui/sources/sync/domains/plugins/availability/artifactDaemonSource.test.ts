import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

const guardedMachineRpc = vi.hoisted(() => vi.fn());

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/guardedMachineRpc', () => ({
    callGuardedMachineRpcWithPolicy: (...args: unknown[]) => guardedMachineRpc(...args),
}));

import { encodeBase64 } from '@/encryption/base64';

import type { PluginSelectedArtifactIdentity } from './artifactLease';
import { createPluginArtifactDaemonSource } from './artifactDaemonSource';

const digest = `sha256:${'a'.repeat(64)}` as const;
const transport = { machineId: 'machine-a', serverId: 'server-a' } as const;
const artifact: PluginSelectedArtifactIdentity = Object.freeze({
    pluginId: 'acme.preview',
    contributionId: 'preview',
    artifactId: 'preview-artifact',
    tier: 'hostedWeb',
    platform: 'web',
    digest,
    hostUiApiRange: '^1.0.0',
    releaseVersion: '1.0.0',
});
const entryBytes = new Uint8Array([104, 105]);

function okResponse(family: 'hostedWeb' | 'reactNative', responseDigest: string = digest) {
    return {
        ok: true as const,
        artifactFamily: family,
        cacheIdentity: { artifactDigest: responseDigest },
        artifact: family === 'hostedWeb'
            ? { artifactKind: 'hostedWebAsset' as const, digest: responseDigest, byteSize: entryBytes.byteLength }
            : {
                artifactKind: 'reactNativeBundle' as const,
                digest: responseDigest,
                format: 'plainJs' as const,
                byteSize: entryBytes.byteLength,
            },
        files: [{
            relativePath: 'index.html',
            digest: `sha256:${'b'.repeat(64)}`,
            byteSize: entryBytes.byteLength,
            bytesBase64: encodeBase64(entryBytes),
        }],
    };
}

describe('daemon Artifact byte source', () => {
    beforeEach(() => guardedMachineRpc.mockReset());

    it('cancels a held daemon byte read when its acquisition retires', async () => {
        const lifetime = new AbortController();
        // The fetcher is the machine byte transport boundary; source decoding
        // and the supplied acquisition cancellation remain real.
        const source = createPluginArtifactDaemonSource({
            transport,
            family: 'hostedWeb',
            fetchArtifactBytes: ({ signal }) => new Promise((resolve) => {
                signal?.addEventListener('abort', () => resolve({
                    ok: false, code: 'artifact_unavailable', diagnostics: [],
                }), { once: true });
            }),
        });
        let result: Awaited<ReturnType<typeof source.fetch>> | undefined;
        void source.fetch({ artifact, signal: lifetime.signal }).then((value) => { result = value; });
        lifetime.abort();
        await vi.waitFor(() => expect(result).toBeNull());
    });

    it.each(['hostedWeb', 'reactNative'] as const)(
        'asks the selected machine for the %s file set by digest only',
        async (family) => {
            guardedMachineRpc.mockResolvedValueOnce(okResponse(family));
            const source = createPluginArtifactDaemonSource({ transport, family });

            await expect(source.fetch({ artifact })).resolves.toEqual(new Map([['index.html', entryBytes]]));
            expect(source.kind).toBe('daemon');
            expect(guardedMachineRpc).toHaveBeenCalledWith({
                machineId: 'machine-a',
                serverId: 'server-a',
                method: RPC_METHODS.DAEMON_PLUGIN_UI_ARTIFACT_BYTES_READ,
                operationTimeoutMs: null,
                payload: {
                    artifactFamily: family,
                    machineId: 'machine-a',
                    cacheIdentity: { artifactDigest: digest },
                },
            });
        },
    );

    it('misses on another digest, another family, an unavailable daemon, or a daemon without the route', async () => {
        const source = createPluginArtifactDaemonSource({ transport, family: 'hostedWeb' });
        guardedMachineRpc.mockResolvedValueOnce(okResponse('hostedWeb', `sha256:${'c'.repeat(64)}`));
        await expect(source.fetch({ artifact })).resolves.toBeNull();
        guardedMachineRpc.mockResolvedValueOnce(okResponse('reactNative'));
        await expect(source.fetch({ artifact })).resolves.toBeNull();
        guardedMachineRpc.mockResolvedValueOnce({ ok: false, code: 'artifact_unavailable', diagnostics: [] });
        await expect(source.fetch({ artifact })).resolves.toBeNull();
        guardedMachineRpc.mockResolvedValueOnce({ errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND, error: 'unsupported' });
        await expect(source.fetch({ artifact })).resolves.toBeNull();
        guardedMachineRpc.mockRejectedValueOnce(new Error('offline'));
        await expect(source.fetch({ artifact })).resolves.toBeNull();
    });
});
