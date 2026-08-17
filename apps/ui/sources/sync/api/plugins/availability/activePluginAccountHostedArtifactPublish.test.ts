import { describe, expect, it, vi } from 'vitest';

import {
    CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
    createAccountScopedCryptoMaterialSnapshotV1,
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
} from '@happier-dev/protocol';
import {
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityUiArtifactPublishActionOutputV1Schema,
} from '@happier-dev/protocol/plugins/availability';
import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    decodePluginUiArtifactArchiveBodyV1,
    openPluginUiArtifactArchiveV1,
} from '@happier-dev/protocol/plugins/ui';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { openAccountArtifactStoredEnvelope } from '@/sync/domains/artifacts/accountArtifactEnvelope';

import {
    createActivePluginAccountHostedArtifactPublisher,
} from './activePluginAccountHostedArtifactRead';

const scope: ServerAccountScope = Object.freeze({
    serverId: 'server-a',
    accountId: 'account-a',
});

const release = Object.freeze({
    pluginId: 'com.acme.hosted',
    version: '1.2.3',
});

const entryBytes = new TextEncoder().encode('hosted entry');
const entryDigest = computePluginUiArtifactSha256DigestV1(entryBytes);
const artifactDigest = computePluginUiArtifactFileSetSha256DigestV1([
    { relativePath: 'entry.js', bytes: entryBytes },
]);
const slot = Object.freeze({
    contributionId: 'hosted',
    tier: 'hostedWeb' as const,
    platform: 'web' as const,
    artifactDigest,
    compatibility: Object.freeze({
        hostUiApiVersion: '1.0.0',
    }),
});
const hostCompatibility = Object.freeze({
    hostAppVersion: '1.0.0',
    hostUiApiVersion: '1.0.0',
    reactVersion: '19.2.0',
    platform: 'web' as const,
    channel: 'store' as const,
    nativeCapabilities: [],
});
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
const e2eeSecret = new Uint8Array(32).fill(7);
const e2eeCredentials = Object.freeze({
    token: 'account-token',
    secret: Buffer.from(e2eeSecret).toString('base64url'),
});
const e2eeContentKeyFingerprint =
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
        createAccountScopedCryptoMaterialSnapshotV1({
            accountEncryptionMode: 'e2ee',
            material: { type: 'legacy', secret: e2eeSecret },
        }).contentPublicKeyFingerprint,
    );

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

function createPublisher(params: Readonly<{
    lifetime: ActiveServerAccountScopeLifetime;
    request: (path: string, init?: RequestInit) => Promise<Response>;
    currentness?: Readonly<{
        mode: 'plain' | 'e2ee';
        contentKeyFingerprint: string | null;
    }>;
    credentials?: AuthCredentials;
}>) {
    const captureRequestAuthority = vi.fn(async () => Object.freeze({
        scope,
        request: params.request,
        ...(params.credentials ? { credentials: params.credentials } : {}),
    }));
    return Object.freeze({
        publisher: createActivePluginAccountHostedArtifactPublisher({
            captureLifetime: () => params.lifetime,
            getServerSnapshot: () => Object.freeze({
                serverId: scope.serverId,
                serverUrl: 'https://server.example',
                generation: 7,
            }),
            captureRequestAuthority,
            readAccountCurrentness: async () => Object.freeze({
                mode: params.currentness?.mode ?? 'plain',
                version: 1,
                signingKeyFingerprint: null,
                updatedAt: 0,
                contentKeyFingerprint: params.currentness?.contentKeyFingerprint ?? null,
            }),
            resolveStoredContentCompatibility: () => Object.freeze({
                status: 'available' as const,
                declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
                headers: new Headers({
                    'Content-Type': 'application/json',
                    'x-happier-account-stored-content-protocol': '3',
                }),
            }),
        }),
        captureRequestAuthority,
    });
}

function input(accountLifetime: ActiveServerAccountScopeLifetime) {
    return Object.freeze({
        accountLifetime,
        release,
        slot,
        hostCompatibility,
        artifactGraph,
        files: [{ relativePath: 'entry.js', bytes: entryBytes }],
    });
}

describe('active Account-hosted plugin Artifact publisher', () => {
    it('wraps one verified archive in the existing plain Artifact envelope before exact qualified publication', async () => {
        const { lifetime } = createLifetime();
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            return new Response(JSON.stringify(
                PluginAvailabilityUiArtifactPublishActionOutputV1Schema.parse({
                    outcome: 'created',
                    link: {
                        release,
                        contributionId: slot.contributionId,
                        tier: slot.tier,
                        platform: slot.platform,
                        artifactId: body.artifactId,
                        artifactDigest,
                        compatibility: hostCompatibility,
                    },
                }),
            ), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        const current = createPublisher({ lifetime, request });

        const result = await current.publisher.publish(input(lifetime));
        expect(result.kind).toBe('published');
        if (result.kind !== 'published') throw new Error('Expected publication');
        expect(result.value.link.release).toEqual(release);
        expect(result.value.link.artifactDigest).toBe(artifactDigest);

        expect(current.captureRequestAuthority).toHaveBeenCalledWith({
            scope,
            activeRequest: expect.any(Function),
        });
        expect(request).toHaveBeenCalledTimes(1);
        const [path, init] = request.mock.calls[0]!;
        expect(path).toBe(PluginAvailabilityActionHttpPathsV1[
            'account.plugins.availability.uiArtifact.publish'
        ]);
        expect(new Headers(init?.headers).get(
            'x-happier-account-stored-content-protocol',
        )).toBe('3');

        const requestBody = JSON.parse(String(init?.body));
        expect(requestBody.release).toEqual(release);
        expect(requestBody.slot).toEqual(slot);
        expect(requestBody.hostCompatibility).toEqual(hostCompatibility);
        const openedEnvelope = await openAccountArtifactStoredEnvelope({
            mode: 'plain',
            envelope: requestBody.artifact,
        });
        expect(openedEnvelope?.header).toMatchObject({
            kind: 'plugin.ui.archive',
            artifactGraph,
        });
        const archiveBody = openedEnvelope?.body.body === null
            ? null
            : decodePluginUiArtifactArchiveBodyV1(openedEnvelope?.body.body ?? '');
        const openedArchive = archiveBody && openedEnvelope
            ? openPluginUiArtifactArchiveV1({
                pluginId: release.pluginId,
                expectedArtifactDigest: artifactDigest,
                header: openedEnvelope.header,
                body: archiveBody,
            })
            : null;
        expect(openedArchive?.files.get('entry.js')).toEqual(entryBytes);
    });

    it('accepts the existing qualified Artifact identity when publication rejoins after response loss', async () => {
        const { lifetime } = createLifetime();
        const existingArtifactId = '00000000-0000-4000-8000-000000000099';
        let proposedArtifactId: string | null = null;
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            proposedArtifactId = body.artifactId;
            return new Response(JSON.stringify(
                PluginAvailabilityUiArtifactPublishActionOutputV1Schema.parse({
                    outcome: 'rejoined',
                    link: {
                        release,
                        contributionId: slot.contributionId,
                        tier: slot.tier,
                        platform: slot.platform,
                        artifactId: existingArtifactId,
                        artifactDigest,
                        compatibility: hostCompatibility,
                    },
                }),
            ), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        const current = createPublisher({ lifetime, request });

        await expect(current.publisher.publish(input(lifetime))).resolves.toMatchObject({
            kind: 'published',
            value: {
                outcome: 'rejoined',
                link: { artifactId: existingArtifactId },
            },
        });
        expect(proposedArtifactId).not.toBe(existingArtifactId);
    });

    it('fails closed before publishing E2EE archive bytes without current Account encryption material', async () => {
        const { lifetime } = createLifetime();
        const request = vi.fn();
        const current = createPublisher({
            lifetime,
            request,
            currentness: {
                mode: 'e2ee',
                contentKeyFingerprint: 'current-account-content-key',
            },
        });

        await expect(current.publisher.publish(input(lifetime))).resolves.toEqual({
            kind: 'unavailable',
            code: 'account_encryption_material_unavailable',
        });
        expect(request).not.toHaveBeenCalled();
    });

    it('seals one verified archive with the current Account E2EE material before publication', async () => {
        const { lifetime } = createLifetime();
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({
                outcome: 'created',
                link: {
                    release,
                    contributionId: slot.contributionId,
                    tier: slot.tier,
                    platform: slot.platform,
                    artifactId: body.artifactId,
                    artifactDigest,
                    compatibility: hostCompatibility,
                },
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        const current = createPublisher({
            lifetime,
            request,
            credentials: e2eeCredentials,
            currentness: {
                mode: 'e2ee',
                contentKeyFingerprint: e2eeContentKeyFingerprint,
            },
        });

        await expect(current.publisher.publish(input(lifetime))).resolves.toMatchObject({
            kind: 'published',
            value: { link: { artifactDigest } },
        });
        const [, init] = request.mock.calls[0]!;
        const requestBody = JSON.parse(String(init?.body));
        const encryption = await createEncryptionFromAuthCredentials(e2eeCredentials);
        const openedEnvelope = await openAccountArtifactStoredEnvelope({
            mode: 'e2ee',
            envelope: requestBody.artifact,
            decryptDataEncryptionKey: async (encryptedDataKey) => (
                await encryption.decryptEncryptionKey(encryptedDataKey)
            ),
        });
        const archiveBody = openedEnvelope?.body.body === null
            ? null
            : decodePluginUiArtifactArchiveBodyV1(openedEnvelope?.body.body ?? '');
        const openedArchive = archiveBody && openedEnvelope
            ? openPluginUiArtifactArchiveV1({
                pluginId: release.pluginId,
                expectedArtifactDigest: artifactDigest,
                header: openedEnvelope.header,
                body: archiveBody,
            })
            : null;
        expect(openedArchive?.files.get('entry.js')).toEqual(entryBytes);
    });

    it('drops a qualified publish response after its captured Account lifetime retires', async () => {
        const active = createLifetime();
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            active.retire();
            return new Response(JSON.stringify({
                outcome: 'created',
                link: {
                    release,
                    contributionId: slot.contributionId,
                    tier: slot.tier,
                    platform: slot.platform,
                    artifactId: body.artifactId,
                    artifactDigest,
                    compatibility: hostCompatibility,
                },
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        const current = createPublisher({ lifetime: active.lifetime, request });

        await expect(current.publisher.publish(input(active.lifetime))).resolves.toEqual({
            kind: 'unavailable',
            code: 'account_scope_changed',
        });
    });
});
