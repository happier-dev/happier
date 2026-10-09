import { describe, expect, it, vi } from 'vitest';
import { ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES } from '@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeFormatV1';

import { createArtifactStoreBoundary } from './artifactStoreBoundary';

describe('Artifact store HTTP boundary', () => {
    it('returns only the stored owner census and fences it to that Account', async () => {
        let accountId: string | null = 'account-a';
        const boundary = createArtifactStoreBoundary({ ownerAccountId: () => accountId, encryptionMode: 'e2ee' });
        // The HTTP boundary stores opaque envelope bytes; opening them belongs to the real codec.
        const dataEncryptionKey = Buffer.alloc(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES, 1).toString('base64');
        const provenanceDataEncryptionKey = Buffer.alloc(ENCRYPTED_DATA_KEY_ENVELOPE_V1_BYTES, 2).toString('base64');
        await boundary.handle('/v1/artifacts', { method: 'POST', body: JSON.stringify({
            id: 'artifact-a', header: 'header', body: 'body', dataEncryptionKey,
            provenance: 'private-metadata', provenanceDataEncryptionKey,
        }) });
        const response = await boundary.handle('/v1/artifacts/artifact-a/access/recipients');
        expect(response?.status).toBe(200);
        expect(await response!.json()).toMatchObject({
            artifactId: 'artifact-a', ownerAccountId: 'account-a', access: 'owner', encryptionMode: 'e2ee',
            dataEncryptionKey, callerDataEncryptionKey: dataEncryptionKey,
            provenanceDataEncryptionKey, callerProvenanceDataEncryptionKey: provenanceDataEncryptionKey,
            recipients: [{ recipientAccountId: 'account-a', contentKey: { status: 'unavailable', reason: 'encryption_setup_required' } }],
        });
        expect((await boundary.handle('/v1/artifacts/missing/access/recipients'))?.status).toBe(404);
        accountId = 'account-b';
        expect((await boundary.handle('/v1/artifacts/artifact-a/access/recipients'))?.status).toBe(404);
        accountId = null;
        expect((await boundary.handle('/v1/artifacts/artifact-a/access/recipients'))?.status).toBe(401);
    });

    it('pages headers in the server cursor order without repeating tied timestamps or returning bodies', async () => {
        const clock = vi.spyOn(Date, 'now').mockReturnValue(1234);
        try {
            const boundary = createArtifactStoreBoundary({ ownerAccountId: () => 'account-a', encryptionMode: 'plain' });
            for (const id of ['a', 'b', 'c']) await boundary.handle('/v1/artifacts', { method: 'POST',
                body: JSON.stringify({ id, header: 'header', body: 'body', dataEncryptionKey: '' }) });
            const first = await (await boundary.handle('/v1/artifacts?limit=2'))!.json();
            expect(first.map((row: { id: string }) => row.id)).toEqual(['c', 'b']);
            expect(first[0]).not.toHaveProperty('body');
            const cursor = Buffer.from(JSON.stringify({ updatedAt: 1234, id: 'b' })).toString('base64url');
            const last = await (await boundary.handle(`/v1/artifacts?limit=2&cursor=${cursor}&includeBody=true`))!.json();
            expect(last).toMatchObject([{ id: 'a', body: 'body', bodyVersion: 1 }]);
            expect(last).toHaveLength(1);
        } finally { clock.mockRestore(); }
    });
});
