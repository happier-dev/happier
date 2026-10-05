import { describe, expect, it, vi } from 'vitest';

// The publisher's HTTP transport is injected below; do not initialize a live socket client.
vi.mock('@/sync/api/session/apiSocket', () => ({ apiSocket: { request: vi.fn() } }));

import {
    createAccountScopedCryptoMaterialSnapshotV1,
    convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
} from '@happier-dev/protocol';
import {
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityUiArtifactPublishActionOutputV1Schema,
    createPackageAssetArchiveV1,
    decodePackageAssetArchiveBodyV1,
    openPackageAssetArchiveV1,
} from '@happier-dev/protocol/plugins/availability';
import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    decodePluginUiArtifactArchiveBodyV1,
    openPluginUiArtifactArchiveV1,
} from '@happier-dev/protocol/plugins/ui';

import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { createEncryptionFromAuthCredentials } from '@/auth/encryption/createEncryptionFromAuthCredentials';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { openAccountArtifactStoredEnvelope } from '@/sync/domains/artifacts/accountArtifactEnvelope';

import {
    createLifetime as createScopedLifetime,
    createPublisher,
} from './activePluginAccountHostedArtifactPublish.testkit';

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
    { relativePath: 'hosted-web/hosted/index.html', bytes: entryBytes },
]);
const slot = Object.freeze({
    contributionId: 'hosted',
    artifactId: 'hosted',
    tier: 'hostedWeb' as const,
    platform: 'web' as const,
    artifactDigest,
    hostUiApiRange: '^1.0.0',
});
const artifactGraph = Object.freeze({
    artifactId: slot.artifactId,
    tier: slot.tier,
    entry: `hosted-web/${slot.artifactId}/index.html`,
    files: Object.freeze([{
        relativePath: `hosted-web/${slot.artifactId}/index.html`,
        digest: entryDigest,
        byteSize: entryBytes.byteLength,
    }]),
    digest: artifactDigest,
    builtWith: Object.freeze({ staging: 'staticDirectory' as const }),
    hostUiApiRange: slot.hostUiApiRange,
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
    return createScopedLifetime(scope);
}

function input(accountLifetime: ActiveServerAccountScopeLifetime) {
    return Object.freeze({
        accountLifetime,
        release,
        slot,
        artifactGraph,
        files: [{ relativePath: artifactGraph.entry, bytes: entryBytes }],
    });
}

function packageArchive() {
    const archive = createPackageAssetArchiveV1({
        manifest: {
            schemaVersion: 2, id: release.pluginId, version: release.version,
            displayName: 'Package', engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
            contributes: { resources: [{ id: 'mark', kind: 'asset', path: 'mark.png', contentType: 'image/png' }] },
        },
        files: [{ path: 'mark.png', bytes: entryBytes }],
    });
    if (!archive) throw new Error('Invalid package fixture');
    return archive;
}

describe('active Account package Asset publisher', () => {
    it.each(['plain', 'e2ee'] as const)('publishes exact package bytes through the protected %s Artifact envelope', async (mode) => {
        const { lifetime } = createLifetime();
        const archive = packageArchive();
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            return new Response(JSON.stringify({ outcome: 'created', link: {
                release, artifactId: body.artifactId, descriptor: archive.descriptor,
            } }), { status: 200 });
        });
        const { publisher } = createPublisher({ lifetime, request, ...(mode === 'e2ee' ? {
            credentials: e2eeCredentials, currentness: { mode, contentKeyFingerprint: e2eeContentKeyFingerprint },
        } : {}) });
        await expect(publisher.publishPackageAssets({ accountLifetime: lifetime, release, archive })).resolves.toMatchObject({ kind: 'published' });
        const [path, init] = request.mock.calls[0]!;
        expect(path).toBe(PluginAvailabilityActionHttpPathsV1['account.plugins.availability.packageAsset.publish']);
        const body = JSON.parse(String(init?.body));
        const encryption = mode === 'e2ee' ? await createEncryptionFromAuthCredentials(e2eeCredentials) : null;
        const envelope = await openAccountArtifactStoredEnvelope({ mode, envelope: body.artifact,
            ...(encryption ? { decryptDataEncryptionKey: (key: string) => encryption.decryptEncryptionKey(key) } : {}),
        });
        expect(envelope).not.toBeNull();
        expect(await openAccountArtifactStoredEnvelope({ mode: mode === 'plain' ? 'e2ee' : 'plain', envelope: body.artifact })).toBeNull();
        if (typeof envelope?.body.body !== 'string') throw new Error('Expected text Package Asset archive');
        const opened = openPackageAssetArchiveV1({ expectedDescriptor: archive.descriptor,
            header: envelope.header, body: decodePackageAssetArchiveBodyV1(envelope.body.body),
        });
        expect(opened?.resources.get('mark')).toEqual(entryBytes);
    });

    it.each([undefined, e2eeCredentials])('rejects missing or mismatched current E2EE material before transport', async (credentials) => {
        const { lifetime } = createLifetime();
        const request = vi.fn();
        const { publisher } = createPublisher({ lifetime, request, credentials,
            currentness: { mode: 'e2ee', contentKeyFingerprint: 'different-key' },
        });
        await expect(publisher.publishPackageAssets({ accountLifetime: lifetime, release, archive: packageArchive() })).resolves.toEqual({
            kind: 'unavailable', code: 'account_encryption_material_unavailable',
        });
        expect(request).not.toHaveBeenCalled();
    });

    it('rejects changed archive bytes before acquiring transport authority', async () => {
        const { lifetime } = createLifetime();
        const current = createPublisher({ lifetime, request: vi.fn() });
        const archive = packageArchive();
        await expect(current.publisher.publishPackageAssets({ accountLifetime: lifetime, release, archive: {
            ...archive, body: { ...archive.body, resources: [{ ...archive.body.resources[0]!, bytesBase64: 'AAAA' }] },
        } })).resolves.toEqual({ kind: 'unavailable', code: 'source_archive_invalid' });
        expect(current.captureRequestAuthority).not.toHaveBeenCalled();
    });

    it('rejoins the exact canonical package descriptor with an existing Artifact identity', async () => {
        const { lifetime } = createLifetime();
        const archive = packageArchive();
        const artifactId = '00000000-0000-4000-8000-000000000099';
        const { publisher } = createPublisher({
            lifetime,
            request: async () => new Response(JSON.stringify({
                outcome: 'rejoined', link: { release, artifactId, descriptor: archive.descriptor },
            }), { status: 200 }),
        });
        await expect(publisher.publishPackageAssets({ accountLifetime: lifetime, release, archive })).resolves.toMatchObject({
            kind: 'published', value: { outcome: 'rejoined', link: { artifactId } },
        });
    });

    it('does not acquire transport authority for a cancelled package publication', async () => {
        const { lifetime } = createLifetime();
        const current = createPublisher({ lifetime, request: vi.fn() });
        const controller = new AbortController();
        controller.abort();
        await expect(current.publisher.publishPackageAssets({
            accountLifetime: lifetime, release, archive: packageArchive(), signal: controller.signal,
        })).resolves.toEqual({ kind: 'unavailable', code: 'operation_cancelled' });
        expect(current.captureRequestAuthority).not.toHaveBeenCalled();
    });

    it.each(['retired', 'wrong_digest', 'wrong_release', 'wrong_resource'] as const)('rejects a %s response', async (failure) => {
        const active = createLifetime();
        const archive = packageArchive();
        const { publisher } = createPublisher({ lifetime: active.lifetime, request: async (_path, init) => {
            const body = JSON.parse(String(init?.body));
            if (failure === 'retired') active.retire();
            return new Response(JSON.stringify({ outcome: 'created', link: {
                release: failure === 'wrong_release' ? { ...release, version: '2.0.0' } : release,
                artifactId: body.artifactId,
                descriptor: failure === 'wrong_digest'
                    ? { ...archive.descriptor, archiveDigestSha256: `sha256:${'0'.repeat(64)}` }
                    : failure === 'wrong_resource'
                        ? { ...archive.descriptor, resources: [{ ...archive.descriptor.resources[0]!, path: 'different.png' }] }
                        : archive.descriptor,
            } }), { status: 200 });
        } });
        await expect(publisher.publishPackageAssets({ accountLifetime: active.lifetime, release, archive })).resolves.toEqual({
            kind: 'unavailable', code: failure === 'retired' ? 'account_scope_changed' : 'response_identity_mismatch',
        });
    });
});

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
                        artifactId: slot.artifactId,
                        tier: slot.tier,
                        platform: slot.platform,
                        accountArtifactId: body.accountArtifactId,
                        artifactDigest,
                        hostUiApiRange: slot.hostUiApiRange,
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
        const openedEnvelope = await openAccountArtifactStoredEnvelope({
            mode: 'plain',
            envelope: requestBody.artifact,
        });
        expect(openedEnvelope?.header).toMatchObject({
            kind: 'plugin.ui.archive',
            artifactGraph,
        });
        const archiveBody = typeof openedEnvelope?.body.body === 'string'
            ? decodePluginUiArtifactArchiveBodyV1(openedEnvelope.body.body)
            : null;
        const openedArchive = archiveBody && openedEnvelope
            ? openPluginUiArtifactArchiveV1({
                pluginId: release.pluginId,
                expectedArtifactDigest: artifactDigest,
                header: openedEnvelope.header,
                body: archiveBody,
            })
            : null;
        expect(openedArchive?.files.get(artifactGraph.entry)).toEqual(entryBytes);
    });

    it.each(['plain', 'e2ee'] as const)('rejoins the canonical Artifact after %s response loss with a fresh publication identity', async (mode) => {
        const { lifetime } = createLifetime();
        const existingArtifactId = '00000000-0000-4000-8000-000000000099';
        let proposedArtifactId: string | null = null;
        let lostResponseId: string | null = null;
        const request = vi.fn(async (_path: string, init?: RequestInit) => {
            const body = JSON.parse(String(init?.body));
            proposedArtifactId = body.accountArtifactId;
            if (lostResponseId === null) {
                lostResponseId = body.accountArtifactId;
                throw new Error('Response lost after commit');
            }
            return new Response(JSON.stringify(
                PluginAvailabilityUiArtifactPublishActionOutputV1Schema.parse({
                    outcome: 'rejoined',
                    link: {
                        release,
                        contributionId: slot.contributionId,
                        artifactId: slot.artifactId,
                        tier: slot.tier,
                        platform: slot.platform,
                        accountArtifactId: existingArtifactId,
                        artifactDigest,
                        hostUiApiRange: slot.hostUiApiRange,
                    },
                }),
            ), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            });
        });
        const current = createPublisher({
            lifetime,
            request,
            ...(mode === 'e2ee' ? {
                credentials: e2eeCredentials,
                currentness: { mode, contentKeyFingerprint: e2eeContentKeyFingerprint },
            } : {}),
        });

        await expect(current.publisher.publish(input(lifetime))).resolves.toEqual({
            kind: 'unavailable',
            code: 'transport_unavailable',
        });
        await expect(current.publisher.publish(input(lifetime))).resolves.toMatchObject({
            kind: 'published',
            value: { outcome: 'rejoined', link: { accountArtifactId: existingArtifactId } },
        });
        expect(proposedArtifactId).not.toBe(existingArtifactId);
        expect(proposedArtifactId).not.toBe(lostResponseId);
    });

    it.each([
        { name: 'release', patch: { release: { ...release, version: '9.0.0' } } },
        { name: 'slot', patch: { contributionId: 'other' } },
        { name: 'digest', patch: { artifactDigest: `sha256:${'0'.repeat(64)}` } },
        { name: 'host API range', patch: { hostUiApiRange: '^2.0.0' } },
    ])('rejects a canonical rejoin with different $name facts', async ({ patch }) => {
        const { lifetime } = createLifetime();
        const current = createPublisher({
            lifetime,
            request: async () => new Response(JSON.stringify({
                outcome: 'rejoined',
                link: {
                    release,
                    contributionId: slot.contributionId,
                    artifactId: slot.artifactId,
                    tier: slot.tier,
                    platform: slot.platform,
                    accountArtifactId: '00000000-0000-4000-8000-000000000099',
                    artifactDigest,
                    hostUiApiRange: slot.hostUiApiRange,
                    ...patch,
                },
            }), { status: 200 }),
        });
        await expect(current.publisher.publish(input(lifetime))).resolves.toEqual({
            kind: 'unavailable',
            code: 'response_identity_mismatch',
        });
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
                    artifactId: slot.artifactId,
                    tier: slot.tier,
                    platform: slot.platform,
                    accountArtifactId: body.accountArtifactId,
                    artifactDigest,
                    hostUiApiRange: slot.hostUiApiRange,
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
        const archiveBody = typeof openedEnvelope?.body.body === 'string'
            ? decodePluginUiArtifactArchiveBodyV1(openedEnvelope.body.body)
            : null;
        const openedArchive = archiveBody && openedEnvelope
            ? openPluginUiArtifactArchiveV1({
                pluginId: release.pluginId,
                expectedArtifactDigest: artifactDigest,
                header: openedEnvelope.header,
                body: archiveBody,
            })
            : null;
        expect(openedArchive?.files.get(artifactGraph.entry)).toEqual(entryBytes);
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
                    artifactId: slot.artifactId,
                    tier: slot.tier,
                    platform: slot.platform,
                    accountArtifactId: body.accountArtifactId,
                    artifactDigest,
                    hostUiApiRange: slot.hostUiApiRange,
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
