import { describe, expect, it, vi } from 'vitest';
import type { AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol/account/encryptionMode';
import { FeaturesResponseSchema } from '@happier-dev/protocol/features/payload/featuresResponseSchema';
import { CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION, CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION } from '@happier-dev/protocol/clientCompatibility/accountStoredContentCompatibilityV1';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import {
    createPackageAssetArchiveV1,
    encodePackageAssetArchiveBodyV1,
    PluginAvailabilityActionHttpPathsV1,
    PluginAvailabilityPackageAssetReadActionOutputV1Schema,
    PluginAvailabilityUiArtifactReadActionInputV1Schema,
    PluginAvailabilityUiArtifactReadActionOutputV1Schema,
} from '@happier-dev/protocol/plugins/availability';
import {
    computePluginUiArtifactFileSetSha256DigestV1,
    computePluginUiArtifactSha256DigestV1,
    createPluginUiArtifactArchiveV1,
} from '@happier-dev/protocol/plugins/ui';

import { TokenStorage } from '@/auth/storage/tokenStorage';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createServedHomeAccountToken, serveAccountHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createAccountArtifactStoredEnvelope } from '@/sync/domains/artifacts/accountArtifactEnvelope';
import type { ArtifactHeader } from '@/sync/domains/artifacts/artifactTypes';
import { captureActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { Encryption } from '@/sync/encryption/encryption';
import { recordAccountStoredContentServerRequirements, resolveAccountStoredContentCompatibilityHeaders } from '@/sync/http/accountStoredContentCompatibility';
import { sync } from '@/sync/sync';

import { createActivePluginAccountHostedArtifactReader } from './activePluginAccountHostedArtifactRead';
import { createActivePluginAccountPackageAssetSource } from './activePluginAccountPackageAssetRead';

vi.mock('socket.io-client', async importOriginal =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

const serverRequirements = { v: 1, minimumProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_PROTOCOL_VERSION,
    currentProtocolVersion: CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION.protocolVersion,
    declarationTransport: 'http-header-and-socket-auth-v1' } as const;

const release = { pluginId: 'example.resource-reads', version: '1.0.0' };
const accountArtifactId = '00000000-0000-4000-8000-000000000001';
const bytes = new Uint8Array([1, 2, 3]);
const artifactGraph = {
    artifactId: 'panel', tier: 'reactNative' as const, entry: 'react-native/panel/entry.cjs.bundle',
    files: [{ relativePath: 'react-native/panel/entry.cjs.bundle', digest: computePluginUiArtifactSha256DigestV1(bytes), byteSize: bytes.length }],
    digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: 'react-native/panel/entry.cjs.bundle', bytes }]),
    builtWith: { bundler: 'esbuild', version: '1.0.0' }, executable: { exports: ['activate'] }, hostUiApiRange: '^1.0.0',
};

async function fixtures(encryption?: Encryption) {
    const packageArchive = createPackageAssetArchiveV1({
        manifest: { schemaVersion: 2, id: release.pluginId, version: release.version, displayName: 'Resources',
            engines: { happier: '^1.0.0' }, runtime: { apiVersion: 1 },
            contributes: { resources: [{ id: 'icon', kind: 'asset', path: 'icon.png', contentType: 'image/png' }] } },
        files: [{ path: 'icon.png', bytes }],
    });
    const uiArchive = createPluginUiArtifactArchiveV1({ pluginId: release.pluginId, artifactGraph,
        files: [{ relativePath: artifactGraph.entry, bytes }] });
    if (!packageArchive || !uiArchive) throw new Error('Expected producer-built resource archives');
    const envelope = async (header: ArtifactHeader, body: string) => {
        const stored = await createAccountArtifactStoredEnvelope({ mode: encryption ? 'e2ee' : 'plain', header, body: { body },
            ...(encryption ? { encryptDataEncryptionKey: (key: Uint8Array) => encryption.encryptEncryptionKey(key) } : {}) });
        if (!stored) throw new Error('Expected resource envelope');
        return { ...stored, headerVersion: 1, bodyVersion: 1, seq: 0 };
    };
    return {
        packageArchive,
        packageResponse: PluginAvailabilityPackageAssetReadActionOutputV1Schema.parse({
            link: { release, artifactId: accountArtifactId, descriptor: packageArchive.descriptor },
            artifact: await envelope(packageArchive.header, encodePackageAssetArchiveBodyV1(packageArchive.body)),
        }),
        uiArtifact: await envelope(uiArchive.header, JSON.stringify(uiArchive.body)),
    };
}

describe('admitted plugin resource reads', () => {
    it.each(['plain', 'e2ee'] as const)('repeated %s archives and platform slots reuse the bound Account identity', async mode => {
        const secret = new Uint8Array(32).fill(43);
        const encryption = mode === 'e2ee' ? await Encryption.create(secret) : undefined;
        const currentness: AccountEncryptionCurrentnessResponse = mode === 'plain'
            ? createPlainAccountEncryptionCurrentnessFixture()
            : { mode, version: 1, updatedAt: 1, signingKeyFingerprint: 'signing-key-1',
                contentKeyFingerprint: convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
                    createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret } }).contentPublicKeyFingerprint),
                recipientEnvelopeReadiness: { status: 'available' } };
        const fixture = await fixtures(encryption);
        let refuse = false;
        const packagePath = PluginAvailabilityActionHttpPathsV1['account.plugins.availability.packageAsset.read'];
        const uiPath = PluginAvailabilityActionHttpPathsV1['account.plugins.availability.uiArtifact.read'];
        installDisconnectedServerSocketBoundary(configureConnectedServerSocketBoundary);
        const home = await serveAccountHomes({ homes: [{ key: 'home', serverUrl: 'https://plugin-resources.test', serverIdentityId: 'srv_plugin_resources', accountId: 'alice',
            accountMode: mode, encryptionCurrentness: () => currentness,
            ...(mode === 'e2ee' ? { credentials: { token: createServedHomeAccountToken('alice'), secret: Buffer.from(secret).toString('base64url') } } : {}) }],
            route: request => {
                if (request.path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({ features: {},
                    capabilities: { accountStoredContentCompatibility: serverRequirements } }));
                if (request.path !== packagePath && request.path !== uiPath) return undefined;
                expect(request.accountId).toBe('alice');
                if (refuse) return Response.json({ error: 'forbidden' }, { status: 403 });
                if (request.path === packagePath) return Response.json(fixture.packageResponse);
                const target = PluginAvailabilityUiArtifactReadActionInputV1Schema.parse(request.body);
                return Response.json(PluginAvailabilityUiArtifactReadActionOutputV1Schema.parse({
                    link: { release: target.release, contributionId: target.contributionId, artifactId: target.artifactId,
                        tier: target.tier, platform: target.platform, accountArtifactId, artifactDigest: artifactGraph.digest,
                        hostUiApiRange: artifactGraph.hostUiApiRange }, artifact: fixture.uiArtifact,
                }));
            },
        });
        try {
            await expect.poll(() => storage.getState().isDataReady).toBe(true);
            const serverUrl = home.homes.home!.serverUrl;
            recordAccountStoredContentServerRequirements({ serverUrl, requirements: serverRequirements });
            const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl);
            if (!credentials) throw new Error('Expected admitted Account credentials');
            await expect.poll(() => sync.getAccountEncryptionObservationBinding(credentials)?.peek()?.mode).toBe(mode);
            const accountLifetime = captureActiveServerAccountScopeLifetime();
            if (!accountLifetime) throw new Error('Expected admitted Account lifetime');
            expect(getActiveServerSnapshot().serverId).toBe(accountLifetime.scope.serverId);
            expect(resolveAccountStoredContentCompatibilityHeaders({}, { serverUrl }).status).toBe('available');
            const currentnessCount = () => home.httpRequests.filter(request => request.path === '/v1/account/encryption/currentness').length;
            const packageSource = createActivePluginAccountPackageAssetSource();
            const reader = createActivePluginAccountHostedArtifactReader();
            const packageIdentity = { pluginId: release.pluginId, releaseVersion: release.version, descriptor: fixture.packageArchive.descriptor };
            const beforeArchives = currentnessCount();
            for (let index = 0; index < 4; index++) {
                await expect.soft(packageSource.readArchive(packageIdentity)).resolves.toEqual({ resources: new Map([['icon', bytes]]) });
            }
            expect.soft(currentnessCount() - beforeArchives, 'S2a: archive currentness GETs').toBe(0);
            const beforeSlots = currentnessCount();
            for (const platform of ['web', 'ios', 'android'] as const) {
                const target = { accountLifetime, release, slot: { contributionId: 'panel', artifactId: artifactGraph.artifactId,
                    tier: artifactGraph.tier, platform }, expectedArtifactDigest: artifactGraph.digest };
                const targetResult = await reader.readTarget(target);
                expect.soft(targetResult, targetResult.kind === 'unavailable' ? targetResult.code : undefined).toMatchObject({ kind: 'available' });
                const exactResult = await reader.read({ ...target, expectedAccountArtifactId: accountArtifactId });
                expect.soft(exactResult, exactResult.kind === 'unavailable' ? exactResult.code : undefined).toMatchObject({ kind: 'available' });
            }
            expect.soft(currentnessCount() - beforeSlots, 'S2b: platform slot currentness GETs').toBe(0);
            refuse = true;
            await expect(packageSource.readArchive(packageIdentity)).resolves.toBeNull();
            await expect(reader.read({ accountLifetime, release, slot: { contributionId: 'panel', artifactId: artifactGraph.artifactId,
                tier: artifactGraph.tier, platform: 'web' }, expectedArtifactDigest: artifactGraph.digest, expectedAccountArtifactId: accountArtifactId }))
                .resolves.toMatchObject({ kind: 'unavailable' });
            expect(home.httpRequests.filter(request => request.path === packagePath)).toHaveLength(5);
            expect(home.httpRequests.filter(request => request.path === uiPath)).toHaveLength(7);
        } finally {
            await home.dispose();
            installDisconnectedServerSocketBoundary();
        }
    });
});
