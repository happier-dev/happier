import axios from 'axios';
import { x25519 } from '@noble/curves/ed25519';
import { afterEach, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createAccountArtifactStore } from './accountArtifactStore';
import { createResourceDataKey } from '@/api/encryption/resourceDataKey';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';

afterEach(() => { vi.restoreAllMocks(); });

it.each(['plain', 'e2ee'] as const)('uses the exact shared Artifact resource codec, not recipient mode, for %s associated content', async mode => {
    const machineKey = new Uint8Array(32).fill(37);
    const credentials = { token: 'recipient', encryption: { type: 'dataKey' as const,
        machineKey, publicKey: x25519.getPublicKey(machineKey) } };
    const resource = await createResourceDataKey({ credentials, mode });
    const other = await createResourceDataKey({ credentials, mode });
    const encode = (value: unknown) => resource.mode === 'plain' ? encodePlainArtifactStoredContent(value)
        : encodeBase64(encryptWithDataKey(value, resource.dataKey));
    let stored = { id: 'environment-content', ownerAccountId: 'team-owner', access: 'view', publicAudience: 'none',
        encryptionMode: mode, dataEncryptionKey: resource.dataEncryptionKey ?? ARTIFACT_PLAIN_DATA_KEY_MARKER,
        header: encode({ title: 'Environment' }), body: encode({ body: '{}' }),
        headerVersion: 2, bodyVersion: 3, seq: 1, createdAt: 1, updatedAt: 1 };
    const requests = vi.spyOn(axios, 'get').mockImplementation(async () => ({ status: 200, data: stored }));
    const store = createAccountArtifactStore({ credentials, getAccountEncryptionMode: async () => 'e2ee' });
    const opened = await store.readForUpdate(stored.id, { prepareRecipients: false, includeSharedAudience: false });
    expect(opened).not.toBeNull();
    const binding = { artifactId: stored.id, expectedRevision: { headerVersion: 2, bodyVersion: 3 } };
    const privateIntent = { requestKey: 'request', actionOperationId: 'operation', source: 'retained-private-bytes' };
    const sealed = opened!.sealAssociatedContent({ ...binding, value: privateIntent });
    expect(sealed.t).toBe(mode === 'plain' ? 'plain' : 'encrypted');
    expect(opened!.openAssociatedContent({ ...binding, content: sealed })).toEqual(privateIntent);
    expect(opened).not.toHaveProperty('dataKey');
    expect(opened).not.toHaveProperty('dataEncryptionKey');
    expect(() => opened!.openAssociatedContent({ ...binding, artifactId: 'different-resource', content: sealed })).toThrow();
    expect(() => opened!.openAssociatedContent({ ...binding,
        expectedRevision: { headerVersion: 2, bodyVersion: 4 }, content: sealed })).toThrow();
    expect(() => opened!.openAssociatedContent({ ...binding,
        content: mode === 'e2ee' ? { t: 'plain', v: privateIntent } : { t: 'encrypted', c: 'not-plaintext' } })).toThrow();
    if (resource.mode === 'e2ee' && other.mode === 'e2ee') {
        expect(() => opened!.openAssociatedContent({ ...binding, content: {
            t: 'encrypted', c: encodeBase64(encryptWithDataKey(privateIntent, other.dataKey)) } })).toThrow();
    }
    stored = { ...stored, id: 'swapped-response' };
    await expect(store.readForUpdate(binding.artifactId, { prepareRecipients: false, includeSharedAudience: false })).rejects.toThrow();
    expect(requests).toHaveBeenCalledTimes(2);
});

it('fails inconsistent owner mode and missing recipient material before disclosing associated content', async () => {
    const machineKey = new Uint8Array(32).fill(39);
    const encrypted = { token: 'recipient', encryption: { type: 'dataKey' as const,
        machineKey, publicKey: x25519.getPublicKey(machineKey) } };
    const resource = await createResourceDataKey({ credentials: encrypted, mode: 'e2ee' });
    if (resource.mode !== 'e2ee') throw new Error('invalid fixture');
    const row = { id: 'environment-content', ownerAccountId: 'owner', access: 'owner', publicAudience: 'none',
        encryptionMode: 'e2ee', dataEncryptionKey: resource.dataEncryptionKey,
        header: encodeBase64(encryptWithDataKey({ title: 'Environment' }, resource.dataKey)),
        body: encodeBase64(encryptWithDataKey({ body: '{}' }, resource.dataKey)),
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 };
    const reads = vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: row });
    const inconsistent = createAccountArtifactStore({ credentials: encrypted, getAccountEncryptionMode: async () => 'plain' });
    await expect(inconsistent.readForUpdate(row.id, { prepareRecipients: false, includeSharedAudience: false })).rejects.toThrow();
    reads.mockResolvedValueOnce({ status: 200, data: { ...row, access: 'view' } });
    const missing = createAccountArtifactStore({ credentials: { token: 'plain-recipient', encryption: null },
        getAccountEncryptionMode: async () => 'plain' });
    await expect(missing.readForUpdate(row.id, { prepareRecipients: false, includeSharedAudience: false })).rejects.toThrow();
});
