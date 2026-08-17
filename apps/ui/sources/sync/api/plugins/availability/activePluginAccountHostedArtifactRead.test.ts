import { describe, expect, it, vi } from 'vitest';

import {
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    encodePlainArtifactStoredContent,
} from '@happier-dev/protocol';
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
    tier: 'hostedWeb' as const,
    platform: 'web' as const,
});

const artifactId = '00000000-0000-4000-8000-000000000001';
const entryBytes = new TextEncoder().encode('hosted entry');
const entryDigest = computePluginUiArtifactSha256DigestV1(entryBytes);
const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
    { relativePath: 'entry.js', bytes: entryBytes },
]);
const artifactGraph = Object.freeze({
    contributionId: slot.contributionId,
    tier: slot.tier,
    platform: slot.platform,
    entry: 'entry.js',
    files: Object.freeze([{
        relativePath: 'entry.js',
        digest: entryDigest,
        byteSize: entryBytes.byteLength,
    }]),
    digest: artifactDigest,
    builtWith: Object.freeze({ bundler: 'vite' as const, version: '5.0.0' }),
    hostUiApiVersion: '1.0.0',
    compat: Object.freeze({}),
});

async function createResponse() {
    const archive = createPluginUiArtifactArchiveV1({
        pluginId: release.pluginId,
        artifactGraph,
        files: [{ relativePath: 'entry.js', bytes: entryBytes }],
    });
    if (!archive) throw new Error('Expected test archive');
    const envelope = await createAccountArtifactStoredEnvelope({
        mode: 'plain',
        header: archive.header,
        body: { body: JSON.stringify(archive.body) },
    });
    if (!envelope) throw new Error('Expected test envelope');
    return PluginAvailabilityUiArtifactReadActionOutputV1Schema.parse({
        link: {
            release,
            ...slot,
            artifactId,
            artifactDigest,
            compatibility: {
                hostAppVersion: '1.0.0',
                hostUiApiVersion: '1.0.0',
                reactVersion: '19.2.0',
                platform: 'web',
                channel: 'store',
                nativeCapabilities: [],
            },
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
    readAccountCurrentness?: ActivePluginAccountHostedArtifactReaderDependencies['readAccountCurrentness'];
}>) {
    const captureRequestAuthority = vi.fn(async () => Object.freeze({
        scope,
        request: params.request,
    }));
    const reader = createActivePluginAccountHostedArtifactReader({
        captureLifetime: () => params.lifetime,
        getServerSnapshot: () => Object.freeze({
            serverId: scope.serverId,
            serverUrl: 'https://server.example',
            generation: 7,
        }),
        captureRequestAuthority,
        readAccountCurrentness: params.readAccountCurrentness ?? (async (
            _input: Parameters<ActivePluginAccountHostedArtifactReaderDependencies['readAccountCurrentness']>[0],
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
        expectedArtifactId: artifactId,
        expectedArtifactDigest: artifactDigest,
    });
}

describe('active Account-hosted plugin Artifact reader', () => {
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
            value: { link: { artifactId, artifactDigest } },
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
        expect(result.value.archive.files.get('entry.js')).toEqual(entryBytes);

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

    it('exports one bounded Account-hosted file candidate rather than raw stored bytes', async () => {
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

        await expect(candidate.readFile({
            artifact: {
                pluginId: release.pluginId,
                contributionId: slot.contributionId,
                tier: slot.tier,
                platform: slot.platform,
                digest: artifactDigest,
                releaseVersion: release.version,
                availabilityCursor: 1,
            },
            relativePath: 'entry.js',
            accountHostedArtifactId: artifactId,
        })).resolves.toEqual(entryBytes);
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

        await expect(candidate.readFile({
            artifact: {
                pluginId: release.pluginId,
                contributionId: slot.contributionId,
                tier: slot.tier,
                platform: slot.platform,
                digest: artifactDigest,
                releaseVersion: release.version,
                availabilityCursor: 1,
            },
            relativePath: 'entry.js',
        })).resolves.toEqual(entryBytes);
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
            link: { ...response.link, artifactId: '00000000-0000-4000-8000-000000000099' },
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
            readAccountCurrentness: async ({ signal }) => {
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
