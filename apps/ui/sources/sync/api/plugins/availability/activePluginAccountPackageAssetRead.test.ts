import { describe, expect, it, vi } from 'vitest';

import {
    createPackageAssetArchiveV1,
    encodePackageAssetArchiveBodyV1,
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityPackageAssetReadActionOutputV1Schema,
} from '@happier-dev/protocol/plugins/availability';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION } from '@happier-dev/protocol';

import { createAccountArtifactStoredEnvelope } from '@/sync/domains/artifacts/accountArtifactEnvelope';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { AccountStoredContentCompatibilityHeaderResolution } from '@/sync/http/accountStoredContentCompatibility';

import { createActivePluginAccountPackageAssetSource } from './activePluginAccountPackageAssetRead';

const scope: ServerAccountScope = Object.freeze({ serverId: 'server-a', accountId: 'account-a' });
const identity = Object.freeze({ pluginId: 'com.acme.package-assets', releaseVersion: '1.2.3' });

function createLifetime(): ActiveServerAccountScopeLifetime {
    return Object.freeze({
        scope,
        isCurrent: () => true,
        onRetire: () => Object.freeze({ dispose: () => undefined }),
    });
}

async function response() {
    const archive = createPackageAssetArchiveV1({
        manifest: {
            schemaVersion: 2,
            id: identity.pluginId,
            version: identity.releaseVersion,
            displayName: 'Package Assets',
            engines: { happier: '^1.0.0' },
            runtime: { apiVersion: 1 },
            contributes: { resources: [{ id: 'brand-icon', kind: 'asset', path: 'assets/brand.png', contentType: 'image/png' }] },
        },
        files: [{ path: 'assets/brand.png', bytes: new Uint8Array([1, 2, 3]) }],
    });
    if (!archive) throw new Error('Expected Package Asset fixture archive.');
    const envelope = await createAccountArtifactStoredEnvelope({
        mode: 'plain',
        header: archive.header,
        body: { body: encodePackageAssetArchiveBodyV1(archive.body) },
    });
    if (!envelope) throw new Error('Expected plain Artifact envelope.');
    return Object.freeze({
        archive,
        response: PluginAvailabilityPackageAssetReadActionOutputV1Schema.parse({
            link: {
                release: { pluginId: identity.pluginId, version: identity.releaseVersion },
                artifactId: '00000000-0000-4000-8000-000000000001',
                descriptor: archive.descriptor,
            },
            artifact: {
                header: envelope.header,
                headerVersion: 1,
                body: envelope.body,
                bodyVersion: 1,
                dataEncryptionKey: envelope.dataEncryptionKey,
                seq: 0,
            },
        }),
    });
}

describe('active Account Package Asset source', () => {
    it('opens only the exact release-descriptor archive through the scoped protected Account route', async () => {
        const fixture = await response();
        const request = vi.fn(async () => new Response(JSON.stringify(fixture.response), { status: 200 }));
        const source = createActivePluginAccountPackageAssetSource({
            captureLifetime: createLifetime,
            getServerSnapshot: () => ({ serverId: scope.serverId, serverUrl: 'https://server.example', generation: 7 }),
            captureRequestAuthority: async () => Object.freeze({ request }),
            readAccountCurrentness: async () => Object.freeze({
                mode: 'plain' as const,
                version: 1,
                signingKeyFingerprint: null,
                updatedAt: 0,
                contentKeyFingerprint: null,
            }),
            resolveStoredContentCompatibility: (): AccountStoredContentCompatibilityHeaderResolution => Object.freeze({
                status: 'available' as const,
                declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
                headers: new Headers({ 'Content-Type': 'application/json' }),
            }),
        });

        await expect(source.readArchive({ ...identity, descriptor: fixture.archive.descriptor }))
            .resolves.toEqual({ resources: new Map([['brand-icon', new Uint8Array([1, 2, 3])]]) });
        expect(request).toHaveBeenCalledWith(
            PluginAvailabilityActionHttpPathsV1['account.plugins.availability.packageAsset.read'],
            expect.objectContaining({ body: JSON.stringify({ release: { pluginId: identity.pluginId, version: identity.releaseVersion } }) }),
        );
    });

    it('fails closed when the qualified link substitutes a release descriptor', async () => {
        const fixture = await response();
        const source = createActivePluginAccountPackageAssetSource({
            captureLifetime: createLifetime,
            getServerSnapshot: () => ({ serverId: scope.serverId, serverUrl: 'https://server.example', generation: 7 }),
            captureRequestAuthority: async () => Object.freeze({
                request: async () => new Response(JSON.stringify({
                    ...fixture.response,
                    link: {
                        ...fixture.response.link,
                        descriptor: { ...fixture.response.link.descriptor, archiveDigestSha256: `sha256:${'f'.repeat(64)}` },
                    },
                }), { status: 200 }),
            }),
            readAccountCurrentness: async () => Object.freeze({
                mode: 'plain' as const,
                version: 1,
                signingKeyFingerprint: null,
                updatedAt: 0,
                contentKeyFingerprint: null,
            }),
            resolveStoredContentCompatibility: (): AccountStoredContentCompatibilityHeaderResolution => Object.freeze({
                status: 'available' as const,
                declaration: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
                headers: new Headers(),
            }),
        });

        await expect(source.readArchive({ ...identity, descriptor: fixture.archive.descriptor })).resolves.toBeNull();
    });
});
