import { beforeEach, describe, expect, it, vi } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';

import type { PluginSelectedArtifactIdentity } from './artifactLease';
import { createPluginArtifactDaemonSource, type PluginArtifactDaemonByteFetcher } from './artifactDaemonSource';
import { createPluginAccountAvailabilityReaderStore } from './reader';
import { PluginMachineMaterializationV1Schema } from '@happier-dev/protocol/plugins/availability';
import { DaemonPluginUiArtifactBytesReadResponseSchema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';

const digest = `sha256:${'a'.repeat(64)}` as const;
const transport = { machineId: 'machine-a', serverId: 'server-a' } as const;
const alternateTransport = { machineId: 'machine-b', serverId: 'server-a' } as const;
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
const artifactBytesBoundary = vi.fn<PluginArtifactDaemonByteFetcher>();

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
    beforeEach(() => artifactBytesBoundary.mockReset());

    it('uses all exact byte advertisements only within the captured Account Home', async () => {
        const scope = { serverId: 'captured-home', accountId: 'owner' };
        const selectedArtifact = { ...artifact, tier: 'reactNative' as const };
        const materialization = PluginMachineMaterializationV1Schema.parse({ serverIdentityId: 'srv_advertised_identity',
            machineId: 'first-supplier', materializationId: 'installation', pluginId: artifact.pluginId,
            version: '0.9.0', sourceClass: 'versionedArchive', portableRelease: true,
            archiveDigestSha256: `sha256:${'f'.repeat(64)}`, enabled: false, trustState: 'untrusted', observedAt: 1,
            uiArtifacts: [{ contributionId: artifact.contributionId, artifactId: artifact.artifactId, tier: selectedArtifact.tier,
                platform: artifact.platform, artifactDigest: artifact.digest, hostUiApiRange: artifact.hostUiApiRange }] });
        const advertisement = materialization.uiArtifacts[0]!;
        const materializations = [materialization,
            { ...materialization, machineId: 'wrong-plugin', pluginId: 'other.plugin' },
            { ...materialization, machineId: 'wrong-platform', uiArtifacts: [{ ...advertisement, platform: 'ios' as const }] },
            { ...materialization, machineId: 'wrong-digest', uiArtifacts: [{ ...advertisement, artifactDigest: `sha256:${'e'.repeat(64)}` as const }] },
            { ...materialization, machineId: 'second-supplier', serverIdentityId: 'srv_foreign_claim' },
        ];
        const store = createPluginAccountAvailabilityReaderStore();
        store.replace({ scope, snapshot: { availabilityCursor: 1, intentReads: [], materializations, snapshots: [] } });
        const fetchArtifactBytes = vi.fn<PluginArtifactDaemonByteFetcher>(async () => ({ ok: false, code: 'artifact_unavailable', diagnostics: [] }));
        const source = createPluginArtifactDaemonSource({ transports: [], family: 'reactNative', fetchArtifactBytes,
            availability: { reader: store.bind(scope), serverId: scope.serverId } });
        expect(await source.fetch({ artifact: selectedArtifact })).toBeNull();
        expect(fetchArtifactBytes.mock.calls.map(([request]) => request.transport)).toEqual([
            { machineId: 'first-supplier', serverId: scope.serverId },
            { machineId: 'second-supplier', serverId: scope.serverId },
        ]);
    });

    it('keeps an explicit byte route when the Account inventory is unavailable', async () => {
        const store = createPluginAccountAvailabilityReaderStore();
        const fetchArtifactBytes = vi.fn<PluginArtifactDaemonByteFetcher>(async () => DaemonPluginUiArtifactBytesReadResponseSchema.parse(okResponse('hostedWeb')));
        const source = createPluginArtifactDaemonSource({ transport, family: 'hostedWeb', fetchArtifactBytes,
            availability: { reader: store.bind({ serverId: 'missing-home', accountId: 'owner' }), serverId: transport.serverId } });
        expect(await source.fetch({ artifact })).toEqual(new Map([['index.html', entryBytes]]));
        expect(fetchArtifactBytes).toHaveBeenCalledWith(expect.objectContaining({ transport }));
    });

    it('loads exact bundled supplier slots only after the known byte routes miss', async () => {
        const scope = { serverId: 'captured-home', accountId: 'owner' };
        const replica = PluginMachineMaterializationV1Schema.parse({
            serverIdentityId: 'srv_advertised_identity', machineId: 'replica', materializationId: 'installation',
            pluginId: artifact.pluginId, version: artifact.releaseVersion, sourceClass: 'bundledFirstParty',
            portableRelease: false, enabled: true, trustState: 'trusted', observedAt: 1,
            uiArtifacts: [{ contributionId: artifact.contributionId, artifactId: artifact.artifactId, tier: artifact.tier,
                platform: artifact.platform, artifactDigest: artifact.digest, hostUiApiRange: artifact.hostUiApiRange }],
        });
        const loadExactMaterializations = vi.fn(async () => ({ rows: [replica], inventoryComplete: true }));
        const store = createPluginAccountAvailabilityReaderStore({ loadExactMaterializations });
        store.replace({ scope, snapshot: { availabilityCursor: 1, intentReads: [], snapshots: [],
            materializations: [{ ...replica, uiArtifacts: [], uiArtifactSetDigest: digest }] } });
        const fetchArtifactBytes = vi.fn<PluginArtifactDaemonByteFetcher>()
            .mockResolvedValueOnce(DaemonPluginUiArtifactBytesReadResponseSchema.parse(okResponse('hostedWeb')))
            .mockResolvedValueOnce({ ok: false, code: 'artifact_unavailable', diagnostics: [] })
            .mockResolvedValueOnce(DaemonPluginUiArtifactBytesReadResponseSchema.parse(okResponse('hostedWeb')))
            .mockResolvedValueOnce({ ok: false, code: 'artifact_unavailable', diagnostics: [] })
            .mockResolvedValueOnce(DaemonPluginUiArtifactBytesReadResponseSchema.parse(okResponse('hostedWeb')));
        const source = createPluginArtifactDaemonSource({ transport, family: 'hostedWeb', fetchArtifactBytes,
            availability: { reader: store.bind(scope), serverId: scope.serverId } });
        await expect(source.fetch({ artifact })).resolves.toEqual(new Map([['index.html', entryBytes]]));
        expect(loadExactMaterializations).not.toHaveBeenCalled();
        await expect(source.fetch({ artifact })).resolves.toEqual(new Map([['index.html', entryBytes]]));
        await expect(source.fetch({ artifact })).resolves.toEqual(new Map([['index.html', entryBytes]]));
        expect(loadExactMaterializations).toHaveBeenCalledTimes(1);
        expect(loadExactMaterializations).toHaveBeenCalledWith(scope, artifact.pluginId, expect.any(AbortSignal));
        expect(fetchArtifactBytes.mock.calls[2]?.[0].transport).toEqual({ machineId: 'replica', serverId: scope.serverId });
    });

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
            artifactBytesBoundary.mockResolvedValueOnce(DaemonPluginUiArtifactBytesReadResponseSchema.parse(okResponse(family)));
            const source = createPluginArtifactDaemonSource({ transport, family, fetchArtifactBytes: artifactBytesBoundary });

            await expect(source.fetch({ artifact })).resolves.toEqual(new Map([['index.html', entryBytes]]));
            expect(source.kind).toBe('daemon');
            expect(artifactBytesBoundary).toHaveBeenCalledWith({
                transport, family, digest,
            });
        },
    );

    it('distinguishes byte misses from a missing daemon route or a failed transport', async () => {
        const source = createPluginArtifactDaemonSource({ transport, family: 'hostedWeb', fetchArtifactBytes: artifactBytesBoundary });
        artifactBytesBoundary.mockResolvedValueOnce(DaemonPluginUiArtifactBytesReadResponseSchema.parse(okResponse('hostedWeb', `sha256:${'c'.repeat(64)}`)));
        await expect(source.fetch({ artifact })).resolves.toBeNull();
        artifactBytesBoundary.mockResolvedValueOnce(DaemonPluginUiArtifactBytesReadResponseSchema.parse(okResponse('reactNative')));
        await expect(source.fetch({ artifact })).resolves.toBeNull();
        artifactBytesBoundary.mockResolvedValueOnce({ ok: false, code: 'artifact_unavailable', diagnostics: [] });
        await expect(source.fetch({ artifact })).resolves.toBeNull();
        artifactBytesBoundary.mockResolvedValueOnce({ ok: false, code: 'artifact_unavailable', diagnostics: ['artifact_bytes_rpc_unavailable'] });
        await expect(source.fetch({ artifact })).rejects.toMatchObject({ code: 'artifact_bytes_rpc_unavailable' });
        artifactBytesBoundary.mockResolvedValueOnce({ ok: false, code: 'artifact_unavailable', diagnostics: ['artifact_bytes_fetch_failed'] });
        await expect(source.fetch({ artifact })).rejects.toMatchObject({ code: 'artifact_bytes_fetch_failed' });
    });

    it.each([
        { ok: false, code: 'artifact_unavailable', diagnostics: [] },
        { ok: false, code: 'artifact_unavailable', diagnostics: ['artifact_bytes_rpc_unavailable'] },
        DaemonPluginUiArtifactBytesReadResponseSchema.parse(okResponse('hostedWeb', `sha256:${'c'.repeat(64)}`)),
    ])('reads the selected digest from another admitted source after a miss or refusal (%j)', async (firstResponse) => {
        artifactBytesBoundary.mockResolvedValueOnce(DaemonPluginUiArtifactBytesReadResponseSchema.parse(firstResponse))
            .mockResolvedValueOnce(DaemonPluginUiArtifactBytesReadResponseSchema.parse(okResponse('hostedWeb')));
        const source = createPluginArtifactDaemonSource({
            transports: [transport, alternateTransport],
            family: 'hostedWeb',
            fetchArtifactBytes: artifactBytesBoundary,
        });

        await expect(source.fetch({ artifact })).resolves.toEqual(new Map([['index.html', entryBytes]]));
        expect(artifactBytesBoundary.mock.calls.map(([request]) => ({
            machineId: request.transport.machineId,
            cacheIdentity: { artifactDigest: request.digest },
        }))).toEqual([
            { machineId: transport.machineId, cacheIdentity: { artifactDigest: digest } },
            { machineId: alternateTransport.machineId, cacheIdentity: { artifactDigest: digest } },
        ]);
    });

    it('stops the admitted source walk when the acquisition is cancelled', async () => {
        const lifetime = new AbortController();
        const fetchArtifactBytes = vi.fn(async () => {
            lifetime.abort();
            return { ok: false as const, code: 'artifact_unavailable' as const, diagnostics: [] };
        });
        const source = createPluginArtifactDaemonSource({
            transports: [transport, alternateTransport],
            family: 'hostedWeb',
            fetchArtifactBytes,
        });

        await expect(source.fetch({ artifact, signal: lifetime.signal })).resolves.toBeNull();
        expect(fetchArtifactBytes).toHaveBeenCalledTimes(1);
    });

    it('asks each exact Home and Machine route once when suppliers repeat', async () => {
        artifactBytesBoundary.mockResolvedValue({ ok: false, code: 'artifact_unavailable', diagnostics: [] });
        const otherHomeTransport = { ...transport, serverId: 'server-b' };
        const source = createPluginArtifactDaemonSource({
            transports: [transport, { ...transport }, alternateTransport, otherHomeTransport],
            family: 'hostedWeb',
            fetchArtifactBytes: artifactBytesBoundary,
        });

        await expect(source.fetch({ artifact })).resolves.toBeNull();
        expect(artifactBytesBoundary.mock.calls.map(([request]) => ({
            serverId: request.transport.serverId, machineId: request.transport.machineId,
        }))).toEqual([transport, alternateTransport, otherHomeTransport]);
    });

    it('retains a safe transport failure when every admitted source misses', async () => {
        artifactBytesBoundary.mockResolvedValueOnce({ ok: false, code: 'artifact_unavailable', diagnostics: ['artifact_bytes_fetch_failed'] })
            .mockResolvedValueOnce({ ok: false, code: 'artifact_unavailable', diagnostics: [] });
        const source = createPluginArtifactDaemonSource({
            transports: [transport, alternateTransport],
            family: 'hostedWeb',
            fetchArtifactBytes: artifactBytesBoundary,
        });

        await expect(source.fetch({ artifact })).rejects.toMatchObject({ code: 'artifact_bytes_fetch_failed' });
        expect(artifactBytesBoundary).toHaveBeenCalledTimes(2);
    });
});
