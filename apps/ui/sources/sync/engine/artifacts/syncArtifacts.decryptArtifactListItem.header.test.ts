import { describe, expect, it } from 'vitest';

import { encodeBase64 } from '@/encryption/base64';
import { Encryption } from '@/sync/encryption/encryption';
import { ArtifactEncryption } from '@/sync/encryption/artifactEncryption';
import type { Artifact } from '@/sync/domains/artifacts/artifactTypes';

import { decryptArtifactListItem } from './syncArtifacts';

describe('decryptArtifactListItem (artifact headers)', () => {
  it('preserves decrypted header metadata on the returned artifact', async () => {
    const masterSecret = new Uint8Array(32).fill(1);
    const encryption = await Encryption.create(masterSecret);

    const artifactKey = new Uint8Array(32).fill(2);
    const encryptedKeyEnvelope = await encryption.encryptEncryptionKey(artifactKey);

    const artifactEncryption = new ArtifactEncryption(artifactKey);
    const headerPayload = {
      v: 1,
      kind: 'approval_request.v1',
      title: 'Approval: do thing',
      approvalStatus: 'open',
      draft: false,
    };
    const encryptedHeader = await artifactEncryption.encryptHeader(headerPayload as any);

    const artifact: Artifact = {
      id: 'a1',
      header: encryptedHeader,
      headerVersion: 1,
      body: undefined,
      bodyVersion: undefined,
      dataEncryptionKey: encodeBase64(encryptedKeyEnvelope, 'base64'),
      seq: 1,
      createdAt: 10,
      updatedAt: 20,
    };

    const decrypted = await decryptArtifactListItem({
      artifact,
      encryption,
      artifactDataKeys: new Map(),
    });

    expect(decrypted?.title).toBe('Approval: do thing');
    expect(decrypted?.header).toMatchObject({
      kind: 'approval_request.v1',
      approvalStatus: 'open',
    });
  });
});

