import { describe, expect, it } from 'vitest';
import { createCliArtifactSignedInLinkJoinAction } from './artifactSignedInLinkJoin';
import { encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { encodeBase64, encryptWithDataKey } from '@/api/encryption';
import { sealPublicShareDataKeyV1 } from '@happier-dev/protocol/crypto/publicShareEncryptedDataKeyEnvelopeV0';

describe('CLI signed-in Artifact opening', () => {
  it.each(['plain', 'e2ee'] as const)('opens actual %s stored envelopes and withholds plaintext from Action results', async encryptionMode => {
    const secret = 'a'.repeat(43), dataKey = new Uint8Array(32).fill(7);
    const encode = (value: unknown) => encryptionMode === 'plain' ? encodePlainArtifactStoredContent(value)
      : encodeBase64(encryptWithDataKey(value, dataKey));
    const opened: unknown[] = [], requests: unknown[] = [];
    const execute = createCliArtifactSignedInLinkJoinAction({ consumeSecret: async () => secret, onOpened: value => { opened.push(value); },
      resolveRecipient: async () => ({ accountId: 'recipient', mode: 'plain', contentPublicKey: null }),
      request: async request => {
        requests.push(request);
        if (request.method === 'POST') return { artifactId: 'artifact', ownerAccountId: 'author', access: 'view' };
        return { artifactId: 'artifact', authorAccountId: 'author', recipientAccountId: 'recipient',
          recipientContentKey: { status: 'unavailable', reason: 'plain_account' }, subject: { kind: 'artifact', id: 'artifact' }, encryptionMode,
          encryptedDataKey: encryptionMode === 'plain' ? null : sealPublicShareDataKeyV1({ dataKey, secret, randomBytes: length => new Uint8Array(length).fill(2) }),
          keyDerivation: 'fragment_v1', isConsentRequired: false, networkOff: false,
          content: { kind: 'artifact', header: encode({ title: 'Private bytes' }), body: encode({ body: 'Private body' }), headerVersion: 1, bodyVersion: 2 } };
      },
    });
    const result = await execute({ input: { lookupId: 'lookup' } });
    expect(result).toMatchObject({ artifactId: 'artifact', authorAccountId: 'author', follow: encryptionMode === 'plain' });
    expect(opened).toEqual([expect.objectContaining({ artifact: { artifactId: 'artifact', ownerAccountId: 'author',
      header: { title: 'Private bytes' }, body: 'Private body', revision: { headerVersion: 1, bodyVersion: 2 } } })]);
    expect(JSON.stringify(result)).not.toContain('Private');
    expect(JSON.stringify(requests)).not.toContain(secret);
  });
});
