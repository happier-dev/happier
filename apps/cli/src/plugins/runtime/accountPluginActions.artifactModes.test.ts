import fastify from 'fastify';
import nacl from 'tweetnacl';
import { expect, it } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 } from '@happier-dev/protocol/server/http/requestBodyBoundsV1';
import { encodePluginUiArtifactArchiveBodyV1 } from '@happier-dev/protocol/plugins/ui';
import type { StoredCredentials } from '@/persistence';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { registerAuthoredAccountActionRelease } from './accountPluginActions.testkit';

it.each(['plain', 'e2ee'] as const)('publishes a readable authored release through the %s Account writer', async encryptionMode => {
    const accountId = 'authored-artifact-owner';
    const token = `e30.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    const keys = encryptionMode === 'e2ee' ? nacl.box.keyPair() : null;
    const credentials: StoredCredentials = { token, encryption: keys ? {
        type: 'dataKey', machineKey: keys.secretKey, publicKey: keys.publicKey,
    } : null };
    const app = fastify({ bodyLimit: SERVER_HTTP_REQUEST_MAX_BODY_UTF8_BYTES_V1 });
    const origin = 'http://authored-artifact-home.test';
    app.get('/v1/account/encryption', async () => ({ mode: encryptionMode, updatedAt: 1 }));
    const release = await registerAuthoredAccountActionRelease(app, accountId, { encryptionMode });
    await app.ready();
    const restore = installAxiosFastifyAdapter({ app, origin });
    try {
        await runWithServerHttpBaseUrl(origin, async () => {
            await release.publishArtifacts(credentials);
            const stored = release.artifacts.read(release.artifactId)!;
            expect(stored).toMatchObject({ ownerAccountId: accountId, encryptionMode, headerVersion: 1, bodyVersion: 1 });
            if (encryptionMode === 'e2ee') {
                expect(stored.dataEncryptionKey).not.toBe(ARTIFACT_PLAIN_DATA_KEY_MARKER);
                expect(stored.header).not.toContain(release.pluginId);
            } else expect(stored.dataEncryptionKey).toBe(ARTIFACT_PLAIN_DATA_KEY_MARKER);
            const opened = await createCredentialedAccountArtifactStore(credentials).read(release.artifactId, { includeSharedAudience: false });
            expect(opened?.header).toMatchObject(release.archive.header);
            expect(opened?.body).toEqual(encodePluginUiArtifactArchiveBodyV1(release.archive.body));
        });
    } finally { restore(); await app.close(); }
});
