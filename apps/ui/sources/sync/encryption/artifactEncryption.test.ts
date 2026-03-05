import { describe, expect, it } from 'vitest';

import { ArtifactEncryption } from './artifactEncryption';

describe('ArtifactEncryption', () => {
  it('preserves passthrough fields in decrypted headers', async () => {
    const key = new Uint8Array(32).fill(7);
    const encryption = new ArtifactEncryption(key);

    const header = {
      v: 1,
      kind: 'prompt_doc.v2',
      title: 'My Prompt',
      sessions: ['s1'],
      draft: true,
      tags: ['a', 'b'],
      approvalStatus: 'open',
      customField: { nested: true },
    };

    const encrypted = await encryption.encryptHeader(header as any);
    const decrypted = await encryption.decryptHeader(encrypted);

    expect(decrypted).toMatchObject(header);
  });

  it('sanitizes known header fields when decrypting', async () => {
    const key = new Uint8Array(32).fill(7);
    const encryption = new ArtifactEncryption(key);

    const header: any = {
      v: 2.9,
      kind: '   ',
      title: 'My Prompt',
      sessions: 'not-an-array',
      draft: 'not-a-boolean',
      customField: { nested: true },
    };

    const encrypted = await encryption.encryptHeader(header);
    const decrypted = await encryption.decryptHeader(encrypted);

    expect(decrypted).toMatchObject({
      v: 2,
      kind: 'artifact.legacy',
      title: 'My Prompt',
      customField: { nested: true },
    });
    expect((decrypted as any)?.sessions).toBeUndefined();
    expect((decrypted as any)?.draft).toBeUndefined();
  });
});
