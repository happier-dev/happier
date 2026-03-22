import { describe, expect, it } from 'vitest';

import type { ArtifactHeader } from '../domains/artifacts/artifactTypes';
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
    } satisfies ArtifactHeader;

    const encrypted = await encryption.encryptHeader(header);
    const decrypted = await encryption.decryptHeader(encrypted);

    expect(decrypted).toMatchObject(header);
  });

  it('sanitizes known header fields when decrypting', async () => {
    const key = new Uint8Array(32).fill(7);
    const encryption = new ArtifactEncryption(key);

    // Intentional invalid fixture shape to verify runtime sanitization.
    const header = {
      v: 2.9,
      kind: '   ',
      title: 'My Prompt',
      sessions: 'not-an-array',
      draft: 'not-a-boolean',
      customField: { nested: true },
    } as unknown as ArtifactHeader;

    const encrypted = await encryption.encryptHeader(header);
    const decrypted = await encryption.decryptHeader(encrypted);

    expect(decrypted).toMatchObject({
      v: 1,
      kind: 'artifact.legacy',
      title: 'My Prompt',
      customField: { nested: true },
    });
    expect(decrypted?.sessions).toBeUndefined();
    expect(decrypted?.draft).toBeUndefined();
    expect(decrypted ? 'sessions' in decrypted : false).toBe(false);
    expect(decrypted ? 'draft' in decrypted : false).toBe(false);
  });

  it('defaults unsupported versions and strips unsafe passthrough keys', async () => {
    const key = new Uint8Array(32).fill(7);
    const encryption = new ArtifactEncryption(key);

    // Intentional invalid fixture shape to verify runtime sanitization.
    const header = {
      v: -4,
      kind: 'prompt_doc.v2',
      title: 'My Prompt',
      constructor: 'drop-me',
      __proto__: { polluted: true },
    } as unknown as ArtifactHeader;

    const encrypted = await encryption.encryptHeader(header);
    const decrypted = await encryption.decryptHeader(encrypted);

    expect(decrypted).toMatchObject({
      v: 1,
      kind: 'prompt_doc.v2',
      title: 'My Prompt',
    });
    expect(Object.prototype.hasOwnProperty.call(decrypted ?? {}, 'constructor')).toBe(false);
  });
});
