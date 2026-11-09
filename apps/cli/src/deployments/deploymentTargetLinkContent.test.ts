import { randomBytes } from 'node:crypto';
import { x25519 } from '@noble/curves/ed25519';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent,
    sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';
import { DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, readDeploymentTargetLinkArtifactV1 } from '@happier-dev/deployment-protocol';
import { createDeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
// Only the authenticated Home transport is replaced; resource keys and both content readers are real.
vi.mock('axios', async importOriginal => {
    const original = await importOriginal<typeof import('axios')>();
    return { ...original, default: { ...original.default, get, post } };
});
afterEach(() => vi.resetAllMocks());

describe('private target link content through the canonical Account Artifact reader', () => {
    const reference = createDeploymentTargetLinkHeaderV1({ source: { kind: 'plugin',
        contribution: { pluginId: 'example.deploy', localId: 'platform' } }, targetKind: 'platform', machines: [], members: [] });
    const content = { providerIdentity: { providerAccountId: 'private-account',
        providerResourceId: 'private-resource', providerEnvironment: 'private-branch' } };
    const header = { kind: DEPLOYMENT_TARGET_LINK_ARTIFACT_KIND_V1, title: 'Private platform link' };
    const readOptions = { prepareRecipients: false, includeSharedAudience: false } as const;

    it.each(['plain', 'e2ee'] as const)('opens the same %s Team-granted content for different recipient keys without a key repair or write', async mode => {
        const dataKey = randomBytes(32);
        const encode = (value: unknown) => mode === 'plain' ? encodePlainArtifactStoredContent(value)
            : encodeBase64(encryptWithDataKey(value, dataKey));
        const stored = { id: reference.contentArtifactId, ownerAccountId: 'other-owner', access: 'view',
            encryptionMode: mode, publicAudience: 'none', header: encode(header), body: encode({ body: JSON.stringify(content) }),
            headerVersion: reference.contentHeaderVersion, bodyVersion: reference.contentBodyVersion,
            seq: 1, createdAt: 1, updatedAt: 1 };
        const secrets = [randomBytes(32), randomBytes(32)];
        const envelopes = secrets.map(secret => mode === 'plain' ? ARTIFACT_PLAIN_DATA_KEY_MARKER
            : encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey, recipientPublicKey: x25519.getPublicKey(secret), randomBytes })));
        if (mode === 'e2ee') expect(envelopes[0]).not.toEqual(envelopes[1]);
        const opened = [];
        for (const [index, secret] of secrets.entries()) {
            get.mockResolvedValueOnce({ status: 200, data: { ...stored, dataEncryptionKey: envelopes[index] } });
            // A shared resource follows its owner's stored mode, not the recipient's unrelated Account mode.
            // Plain recipients are keyless; E2EE recipients have independently sealed envelopes.
            const store = createAccountArtifactStore({ credentials: { token: `recipient-${index}`, encryption: mode === 'plain' ? null
                : { type: 'dataKey', machineKey: secret, publicKey: x25519.getPublicKey(secret) } },
                getAccountEncryptionMode: async () => mode === 'plain' ? 'e2ee' : 'plain' });
            const artifact = await runWithServerHttpBaseUrl('http://home.test', () => store.read(reference.contentArtifactId, readOptions));
            opened.push(readDeploymentTargetLinkArtifactV1(reference, artifact));
        }
        expect(opened).toEqual([{ ok: true, content, title: header.title }, { ok: true, content, title: header.title }]);
        expect(get.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
            `/v1/artifacts/${reference.contentArtifactId}`, `/v1/artifacts/${reference.contentArtifactId}`,
        ]);
        expect(post).not.toHaveBeenCalled();
    });

    it('never discloses protected identity after wrong key, inconsistent mode, denied read or substituted Artifact', async () => {
        const recipient = randomBytes(32);
        const dataKey = randomBytes(32);
        const row = { id: reference.contentArtifactId, ownerAccountId: 'other-owner', access: 'view', publicAudience: 'none',
            encryptionMode: 'e2ee', dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({
                dataKey, recipientPublicKey: x25519.getPublicKey(recipient), randomBytes })),
            header: encodeBase64(encryptWithDataKey(header, dataKey)),
            body: encodeBase64(encryptWithDataKey({ body: JSON.stringify(content) }, dataKey)),
            headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
        const wrongSecret = randomBytes(32);
        const store = createAccountArtifactStore({ credentials: { token: 'recipient', encryption: {
            type: 'dataKey', machineKey: wrongSecret, publicKey: x25519.getPublicKey(wrongSecret) } },
            getAccountEncryptionMode: async () => 'e2ee' });
        const read = () => runWithServerHttpBaseUrl('http://home.test', () => store.read(reference.contentArtifactId, readOptions));
        get.mockResolvedValueOnce({ status: 200, data: row });
        await expect(read()).rejects.toMatchObject({ code: 'artifact_encryption_material_unavailable' });
        get.mockResolvedValueOnce({ status: 200, data: { ...row, encryptionMode: 'plain' } });
        await expect(read()).rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
        get.mockResolvedValueOnce({ status: 403, data: { error: 'artifact_access_denied' } });
        await expect(read()).rejects.toMatchObject({ code: 'artifact_read_unavailable', status: 403 });
        get.mockResolvedValueOnce({ status: 200, data: { ...row, id: 'other-scope-artifact', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, header: encodePlainArtifactStoredContent(header),
            body: encodePlainArtifactStoredContent({ body: JSON.stringify(content) }) } });
        await expect(read()).rejects.toMatchObject({ code: 'artifact_read_invalid' });
        expect(post).not.toHaveBeenCalled();
    });
});
