import { describe, expect, it, vi } from 'vitest';

import {
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION} from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import {
    encodePlainArtifactStoredContent} from '@happier-dev/protocol/storage/artifactStoredContent';
import {
    encodeBase64,
} from '@happier-dev/protocol/crypto/base64';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import {
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityUiArtifactReadActionOutputV1Schema,
} from '@happier-dev/protocol/plugins/availability';
import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    createPluginUiArtifactArchiveV1,
} from '@happier-dev/protocol/plugins/ui';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { createAccountArtifactStoredEnvelope } from '@/sync/domains/artifacts/accountArtifactEnvelope';
import { Encryption } from '@/sync/encryption/encryption';
import * as platformDigest from '@/platform/digest';
import {
    materializeVerifiedPluginArtifactSource,
    type PluginArtifactSourceCandidate,
} from '@/sync/domains/plugins/availability/artifactLease';
import type { AccountStoredContentCompatibilityHeaderResolution } from '@/sync/http/accountStoredContentCompatibility';

import {
    createActivePluginAccountHostedArtifactReader,
    createActivePluginAccountHostedArtifactSourceCandidate,
    createActivePluginAccountHostedArtifactTargetSourceCandidate,
    type ActivePluginAccountHostedArtifactReaderDependencies,
} from './activePluginAccountHostedArtifactRead';

const scope: ServerAccountScope = Object.freeze({
    serverId: 'server-a',
    accountId: 'account-a',
});

const release = Object.freeze({
    pluginId: 'com.acme.hosted',
    version: '1.2.3',
});

const slot = Object.freeze({
    contributionId: 'hosted',
    artifactId: 'hosted',
    tier: 'hostedWeb' as const,
    platform: 'web' as const,
});

const accountArtifactId = '00000000-0000-4000-8000-000000000001';
const entryBytes = new TextEncoder().encode('hosted entry');
const entryDigest = computePluginUiArtifactSha256DigestV1(entryBytes);
const entryPath = `hosted-web/${slot.artifactId}/index.html`;
const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
    { relativePath: entryPath, bytes: entryBytes },
]);
const artifactGraph = Object.freeze({
    artifactId: slot.artifactId,
    tier: slot.tier,
    entry: entryPath,
    files: [{
        relativePath: entryPath,
        digest: entryDigest,
        byteSize: entryBytes.byteLength,
    }],
    digest: artifactDigest,
    builtWith: Object.freeze({ staging: 'staticDirectory' as const }),
    hostUiApiRange: '^1.0.0',
});

async function createResponse(encryption?: Encryption, corruptBytes = false) {
    const archive = createPluginUiArtifactArchiveV1({
        pluginId: release.pluginId,
        artifactGraph,
        files: [{ relativePath: artifactGraph.entry, bytes: entryBytes }],
    });
    if (!archive) throw new Error('Expected test archive');
    const envelope = await createAccountArtifactStoredEnvelope({
        mode: encryption ? 'e2ee' : 'plain',
        header: archive.header,
        body: { body: JSON.stringify(corruptBytes ? { ...archive.body, files: archive.body.files.map(file => ({
            ...file, bytesBase64: encodeBase64(new Uint8Array(entryBytes.map((byte, index) => index === 0 ? byte ^ 1 : byte)), 'base64'),
        })) } : archive.body) },
        ...(encryption ? { encryptDataEncryptionKey: (key: Uint8Array) => encryption.encryptEncryptionKey(key) } : {}),
    });
    if (!envelope) throw new Error('Expected test envelope');
    return PluginAvailabilityUiArtifactReadActionOutputV1Schema.parse({
        link: {
            release,
            ...slot,
            accountArtifactId,
            artifactDigest,
            hostUiApiRange: artifactGraph.hostUiApiRange,
        },
        artifact: {
            header: envelope.header,
            headerVersion: 1,
            body: envelope.body,
            bodyVersion: 1,
            dataEncryptionKey: envelope.dataEncryptionKey,
            seq: 0,
        },
    });
}

function createLifetime() {
    let current = true;
    const retireListeners = new Set<() => void>();
    const lifetime: ActiveServerAccountScopeLifetime = Object.freeze({
        scope,
        isCurrent: () => current,
        onRetire: (listener) => {
            retireListeners.add(listener);
            return Object.freeze({ dispose: () => retireListeners.delete(listener) });
        },
    });
    return Object.freeze({
        lifetime,
        retire: () => {
            current = false;
            for (const listener of [...retireListeners]) listener();
        },
    });
}

function createReader(params: Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    compatibility?: 'available' | 'unavailable';
    readAccountIdentity?: ActivePluginAccountHostedArtifactReaderDependencies['readAccountIdentity'];
    decryptDataEncryptionKey?: Awaited<ReturnType<ActivePluginAccountHostedArtifactReaderDependencies['captureRequestAuthority']>>['decryptDataEncryptionKey'];
}>) {
    const captureRequestAuthority = vi.fn(async () => Object.freeze({
        scope,
        request: params.request,
        ...(params.decryptDataEncryptionKey ? { decryptDataEncryptionKey: params.decryptDataEncryptionKey } : {}),
    }));
    const reader = createActivePluginAccountHostedArtifactReader({
        captureLifetime: () => params.lifetime,
        getServerSnapshot: () => Object.freeze({
            serverId: scope.serverId,
            serverUrl: 'https://server.example',
            generation: 7,
        }),
        captureRequestAuthority,
        readAccountIdentity: params.readAccountIdentity ?? (async (
            _input: Parameters<ActivePluginAccountHostedArtifactReaderDependencies['readAccountIdentity']>[0],
        ) => Object.freeze({
            mode: 'plain' as const,
            version: 1,
            signingKeyFingerprint: null,
            updatedAt: 0,
            contentKeyFingerprint: null,
        })),
        resolveStoredContentCompatibility: (
            _input: HeadersInit,
            _params: Readonly<{ serverUrl: string }>,
        ): AccountStoredContentCompatibilityHeaderResolution => params.compatibility === 'unavailable'
            ? Object.freeze({
                status: 'unavailable' as const,
                reason: 'server-requirements-unavailable' as const,
            })
            : Object.freeze({
                status: 'available' as const,
                declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
                headers: new Headers({
                    'Content-Type': 'application/json',
                    'x-happier-account-stored-content-protocol': '3',
                }),
            }),
    });
    return Object.freeze({ reader, captureRequestAuthority });
}

function input(lifetime: ActiveServerAccountScopeLifetime) {
    return Object.freeze({
        accountLifetime: lifetime,
        release,
        slot,
        expectedAccountArtifactId: accountArtifactId,
        expectedArtifactDigest: artifactDigest,
    });
}

function openedFile(
    source: Awaited<ReturnType<PluginArtifactSourceCandidate['fetch']>>,
    relativePath: string,
): Uint8Array | undefined {
    return source && 'artifactGraph' in source ? source.files.get(relativePath) : undefined;
}

describe('active Account-hosted plugin Artifact reader', () => {
    it('opens real E2EE Account-hosted bytes without a Machine and rejects corrupted decrypted bytes', async () => {
        const secret = new Uint8Array(32).fill(31);
        const encryption = await Encryption.create(secret);
        const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
            material: { type: 'legacy', secret } });
        const readAccountIdentity: ActivePluginAccountHostedArtifactReaderDependencies['readAccountIdentity'] = async () => ({
            mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing', updatedAt: 1,
            contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint),
            recipientEnvelopeReadiness: { status: 'available' },
        });
        const { lifetime } = createLifetime();
        let response = await createResponse(encryption);
        const request = vi.fn(async () => Response.json(response));
        const current = createReader({ lifetime, request, readAccountIdentity,
            decryptDataEncryptionKey: value => encryption.decryptEncryptionKey(value) });
        const candidate = createActivePluginAccountHostedArtifactSourceCandidate({ accountLifetime: lifetime, reader: current.reader });
        const sourceInput = { artifact: { pluginId: release.pluginId, contributionId: slot.contributionId,
            artifactId: slot.artifactId, tier: slot.tier, platform: slot.platform, digest: artifactDigest,
            hostUiApiRange: artifactGraph.hostUiApiRange, releaseVersion: release.version }, accountHostedArtifactId: accountArtifactId };
        await expect(candidate.fetch(sourceInput).then(source => openedFile(source, entryPath))).resolves.toEqual(entryBytes);

        response = await createResponse(encryption, true);
        await expect(current.reader.read(input(lifetime))).resolves.toEqual({ kind: 'unavailable', code: 'artifact_archive_invalid' });

        const missingKey = createReader({ lifetime, request, readAccountIdentity });
        request.mockClear();
        await expect(missingKey.reader.read(input(lifetime))).resolves.toEqual({ kind: 'unavailable', code: 'account_encryption_material_unavailable' });
        expect(request).not.toHaveBeenCalled();
    });

    it('reads a prospective exact release slot and learns its canonical Artifact id only after digest validation', async () => {
        const { lifetime } = createLifetime();
        const response = await createResponse();
        const request = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        const current = createReader({
            lifetime,
            request,
        });

        const result = await current.reader.readTarget({
            accountLifetime: lifetime,
            release,
            slot,
            expectedArtifactDigest: artifactDigest,
        });

        expect(result).toMatchObject({
            kind: 'available',
            value: { link: { accountArtifactId, artifactDigest } },
        });
        expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
            release,
            ...slot,
            purpose: 'candidatePreparation',
            expectedArtifactDigest: artifactDigest,
        });
    });

    it('uses the exact scoped Availability route and exposes only a strict matching archive', async () => {
        const { lifetime } = createLifetime();
        const response = await createResponse();
        const request = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify(response), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        const current = createReader({ lifetime, request });

        const result = await current.reader.read(input(lifetime));
        expect(result.kind).toBe('available');
        if (result.kind !== 'available') throw new Error('Expected archive');
        expect(result.value.link).toEqual(response.link);
        expect(result.value.archive.artifactGraph).toEqual(artifactGraph);
        expect(result.value.archive.files.get(artifactGraph.entry)).toEqual(entryBytes);

        expect(current.captureRequestAuthority).toHaveBeenCalledWith({
            scope,
            activeRequest: expect.any(Function),
        });
        expect(request).toHaveBeenCalledTimes(1);
        const [path, init] = request.mock.calls[0]!;
        expect(path).toBe(PluginAvailabilityActionHttpPathsV1[
            'account.plugins.availability.uiArtifact.read'
        ]);
        expect(JSON.parse(String(init?.body))).toEqual({
            release,
            ...slot,
        });
        expect(new Headers(init?.headers).get(
            'x-happier-account-stored-content-protocol',
        )).toBe('3');
    });

    describe('verified Account source through the lease materializer', () => {
        const selectedArtifact = Object.freeze({
            pluginId: release.pluginId,
            contributionId: slot.contributionId,
            artifactId: slot.artifactId,
            tier: slot.tier,
            platform: slot.platform,
            digest: artifactDigest,
            hostUiApiRange: artifactGraph.hostUiApiRange,
            releaseVersion: release.version,
        });

        async function createE2eeHarness() {
            const secret = new Uint8Array(32).fill(31);
            const encryption = await Encryption.create(secret);
            const material = createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee',
                material: { type: 'legacy', secret } });
            const readAccountIdentity: ActivePluginAccountHostedArtifactReaderDependencies['readAccountIdentity'] = async () => ({
                mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing', updatedAt: 1,
                contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(material.contentPublicKeyFingerprint),
                recipientEnvelopeReadiness: { status: 'available' },
            });
            return { encryption, readAccountIdentity };
        }

        async function readThroughLease(params: Readonly<{
            mode: 'plain' | 'e2ee';
            corrupt?: boolean;
            graph?: typeof artifactGraph;
        }>) {
            const { lifetime } = createLifetime();
            const e2ee = params.mode === 'e2ee' ? await createE2eeHarness() : null;
            const response = await createResponse(e2ee?.encryption, params.corrupt ?? false);
            const current = createReader({
                lifetime,
                request: async () => Response.json(response),
                ...(e2ee ? {
                    readAccountIdentity: e2ee.readAccountIdentity,
                    decryptDataEncryptionKey: (value: Parameters<Encryption['decryptEncryptionKey']>[0]) =>
                        e2ee.encryption.decryptEncryptionKey(value),
                } : {}),
            });
            const hashing = vi.spyOn(platformDigest, 'digest');
            try {
                const result = await materializeVerifiedPluginArtifactSource({
                    artifact: selectedArtifact,
                    graph: params.graph ?? artifactGraph,
                    sources: [createActivePluginAccountHostedArtifactSourceCandidate({
                        accountLifetime: lifetime,
                        reader: current.reader,
                    })],
                    isCurrent: () => true,
                    accountHostedArtifactId: accountArtifactId,
                });
                return { result, leaseHashes: hashing.mock.calls.length };
            } finally {
                hashing.mockRestore();
            }
        }

        it.each(['plain', 'e2ee'] as const)('admits the opener-verified %s archive without hashing its bytes again', async (mode) => {
            const { result, leaseHashes } = await readThroughLease({ mode });

            expect(result).toMatchObject({ kind: 'available', files: [{
                file: { relativePath: entryPath, digest: entryDigest, byteSize: entryBytes.byteLength },
                bytes: entryBytes,
            }] });
            expect(leaseHashes).toBe(0);
        });

        it.each(['plain', 'e2ee'] as const)('refuses tampered %s archive bytes', async (mode) => {
            const { result } = await readThroughLease({ mode, corrupt: true });

            expect(result.kind).toBe('unavailable');
        });

        it('refuses a verified archive whose graph contradicts the selected graph', async () => {
            const otherBytes = new TextEncoder().encode('other entry!');
            const { result } = await readThroughLease({
                mode: 'plain',
                graph: Object.freeze({
                    ...artifactGraph,
                    files: [{
                        relativePath: entryPath,
                        digest: computePluginUiArtifactSha256DigestV1(otherBytes),
                        byteSize: otherBytes.byteLength,
                    }],
                }),
            });

            expect(result).toEqual({ kind: 'unavailable', integrityFailed: true });
        });

        it('still hashes every raw source file set and refuses tampered raw bytes', async () => {
            const hashing = vi.spyOn(platformDigest, 'digest');
            try {
                const materialize = (bytes: Uint8Array) => materializeVerifiedPluginArtifactSource({
                    artifact: selectedArtifact,
                    graph: artifactGraph,
                    sources: [{ kind: 'daemon', fetch: async () => new Map([[entryPath, bytes]]) }],
                    isCurrent: () => true,
                });

                await expect(materialize(entryBytes)).resolves.toMatchObject({ kind: 'available' });
                expect(hashing.mock.calls.length).toBeGreaterThan(0);
                await expect(materialize(new Uint8Array(entryBytes.map((byte, index) => index === 0 ? byte ^ 1 : byte))))
                    .resolves.toEqual({ kind: 'unavailable', integrityFailed: true });
            } finally {
                hashing.mockRestore();
            }
        });
    });

    it('exports one Account-hosted byte source that returns the selected digest file set', async () => {
        const { lifetime } = createLifetime();
        const response = await createResponse();
        const current = createReader({
            lifetime,
            request: async () => new Response(JSON.stringify(response), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        });
        const candidate = createActivePluginAccountHostedArtifactSourceCandidate({
            accountLifetime: lifetime,
            reader: current.reader,
        });

        await expect(candidate.fetch({
            artifact: {
                pluginId: release.pluginId,
                contributionId: slot.contributionId,
                artifactId: slot.artifactId,
                tier: slot.tier,
                platform: slot.platform,
                digest: artifactDigest,
                hostUiApiRange: artifactGraph.hostUiApiRange,
                releaseVersion: release.version,
            },
            accountHostedArtifactId: accountArtifactId,
        }).then((source) => openedFile(source, artifactGraph.entry))).resolves.toEqual(entryBytes);
    });

    it('exports a prospective-slot source that reads exact target coordinates without an incumbent Artifact id', async () => {
        const { lifetime } = createLifetime();
        const response = await createResponse();
        const current = createReader({
            lifetime,
            request: async () => new Response(JSON.stringify(response), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        });
        const candidate = createActivePluginAccountHostedArtifactTargetSourceCandidate({
            accountLifetime: lifetime,
            reader: current.reader,
        });

        await expect(candidate.fetch({
            artifact: {
                pluginId: release.pluginId,
                contributionId: slot.contributionId,
                artifactId: slot.artifactId,
                tier: slot.tier,
                platform: slot.platform,
                digest: artifactDigest,
                hostUiApiRange: artifactGraph.hostUiApiRange,
                releaseVersion: release.version,
            },
        }).then((source) => openedFile(source, artifactGraph.entry))).resolves.toEqual(entryBytes);
    });

    it.each([
        createActivePluginAccountHostedArtifactSourceCandidate,
        createActivePluginAccountHostedArtifactTargetSourceCandidate,
    ])('preserves an Account-hosted transport failure without exposing the HTTP error body', async (createSource) => {
        const { lifetime } = createLifetime();
        const current = createReader({
            lifetime,
            request: async () => new Response('private failure detail', { status: 503 }),
        });
        const source = createSource({ accountLifetime: lifetime, reader: current.reader });
        await expect(source.fetch({
            artifact: {
                pluginId: release.pluginId, contributionId: slot.contributionId,
                artifactId: slot.artifactId, tier: slot.tier, platform: slot.platform,
                digest: artifactDigest, hostUiApiRange: artifactGraph.hostUiApiRange,
                releaseVersion: release.version,
            },
            accountHostedArtifactId: accountArtifactId,
        })).rejects.toMatchObject({ code: 'transport_unavailable', message: 'transport_unavailable' });
    });

    it.each([
        createActivePluginAccountHostedArtifactSourceCandidate,
        createActivePluginAccountHostedArtifactTargetSourceCandidate,
    ])('cancels a held Account-hosted source read when its acquisition retires', async (createSource) => {
        const { lifetime } = createLifetime();
        const controller = new AbortController();
        let started!: () => void;
        const requestStarted = new Promise<void>((resolve) => { started = resolve; });
        const current = createReader({
            lifetime,
            request: async (_path, init) => {
                started();
                return new Promise<Response>((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
                });
            },
        });
        const source = createSource({ accountLifetime: lifetime, reader: current.reader });
        let result: Awaited<ReturnType<typeof source.fetch>> | undefined;
        void source.fetch({
            artifact: {
                pluginId: release.pluginId, contributionId: slot.contributionId,
                artifactId: slot.artifactId, tier: slot.tier, platform: slot.platform,
                digest: artifactDigest, hostUiApiRange: artifactGraph.hostUiApiRange,
                releaseVersion: release.version,
            },
            accountHostedArtifactId: accountArtifactId,
            signal: controller.signal,
        }).then((value) => { result = value; });
        await requestStarted;
        controller.abort();
        await vi.waitFor(() => expect(result).toBeNull());
    });

    it('drops a response that arrives after the captured Account lifetime retires', async () => {
        const active = createLifetime();
        const response = await createResponse();
        const request = vi.fn(async (_path: string, _init?: RequestInit) => {
            active.retire();
            return new Response(JSON.stringify(response), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        const current = createReader({ lifetime: active.lifetime, request });

        await expect(current.reader.read(input(active.lifetime))).resolves.toEqual({
            kind: 'unavailable',
            code: 'account_scope_changed',
        });
    });

    it('fails closed when the qualified response identifies a different Artifact', async () => {
        const { lifetime } = createLifetime();
        const response = await createResponse();
        const request = vi.fn(async (_path: string, _init?: RequestInit) => new Response(JSON.stringify({
            ...response,
            link: { ...response.link, accountArtifactId: '00000000-0000-4000-8000-000000000099' },
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        }));
        const current = createReader({ lifetime, request });

        await expect(current.reader.read(input(lifetime))).resolves.toEqual({
            kind: 'unavailable',
            code: 'response_identity_mismatch',
        });
    });

    it('does not send a stored-envelope request when server compatibility is unavailable', async () => {
        const { lifetime } = createLifetime();
        const request = vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 500 }));
        const current = createReader({
            lifetime,
            request,
            compatibility: 'unavailable',
        });

        await expect(current.reader.read(input(lifetime))).resolves.toEqual({
            kind: 'unavailable',
            code: 'stored_content_compatibility_unavailable',
        });
        expect(current.captureRequestAuthority).not.toHaveBeenCalled();
        expect(request).not.toHaveBeenCalled();
    });

    it('aborts the Account-currentness request when its Account lifetime retires', async () => {
        const active = createLifetime();
        let currentnessStarted = false;
        let observedSignal: AbortSignal | undefined;
        let releaseCurrentness!: () => void;
        let rejectCurrentness!: (error: Error) => void;
        const currentnessPending = new Promise<void>((resolve, reject) => {
            releaseCurrentness = resolve;
            rejectCurrentness = reject;
        });
        const current = createReader({
            lifetime: active.lifetime,
            request: vi.fn(async (_path: string, _init?: RequestInit) => new Response(null, { status: 500 })),
            readAccountIdentity: async ({ signal }) => {
                currentnessStarted = true;
                observedSignal = signal;
                signal?.addEventListener('abort', () => {
                    rejectCurrentness(new Error('currentness request aborted'));
                }, { once: true });
                await currentnessPending;
                return Object.freeze({
                    mode: 'plain' as const,
                    version: 1,
                    signingKeyFingerprint: null,
                    updatedAt: 0,
                    contentKeyFingerprint: null,
                });
            },
        });

        const result = current.reader.read(input(active.lifetime));
        await vi.waitFor(() => expect(currentnessStarted).toBe(true));
        active.retire();
        const wasAborted = observedSignal?.aborted ?? false;
        if (!wasAborted) releaseCurrentness();

        await expect(result).resolves.toEqual({
            kind: 'unavailable',
            code: 'account_scope_changed',
        });
        expect(wasAborted).toBe(true);
    });

    it('fails closed when the stored Artifact does not contain the declared strict archive', async () => {
        const { lifetime } = createLifetime();
        const response = await createResponse();
        const current = createReader({
            lifetime,
            request: async () => new Response(JSON.stringify({
                ...response,
                artifact: {
                    ...response.artifact,
                    body: encodePlainArtifactStoredContent({ body: 'not an archive' }),
                },
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        });

        await expect(current.reader.read(input(lifetime))).resolves.toEqual({
            kind: 'unavailable',
            code: 'artifact_archive_invalid',
        });
    });
});
