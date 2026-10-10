import { describe, expect, it } from 'vitest';

import type { ArtifactHeader, ArtifactBody } from '../domains/artifacts/artifactTypes';
import { ArtifactEncryption, projectArtifactHeaderForDisplay } from './artifactEncryption';
import { buildRoleArtifactHeaderV1, frameSessionDataKeyBundleV0, sealAesGcmPayloadWebCrypto } from '@happier-dev/protocol';
import { encodeBase64 } from '@/encryption/base64';

describe('ArtifactEncryption', () => {
  it('projects the authored Role name for every display consumer without changing its stored header', async () => {
    const header = buildRoleArtifactHeaderV1({ name: 'Code reviewer', instructions: 'Review changes',
      runsAs: { kind: 'session' }, workspaceWrites: 'deny', secondOpinion: 'off', enabled: true });
    expect(projectArtifactHeaderForDisplay(header).title).toBe('Code reviewer');
    const encryption = new ArtifactEncryption(new Uint8Array(32).fill(7));
    const stored = await encryption.encryptHeader(header);
    expect((await encryption.decryptHeader(stored))?.title).toBe('Code reviewer');
    await expect(encryption.decryptHeaderRaw(stored)).resolves.toEqual(header);
    expect(projectArtifactHeaderForDisplay({ kind: 'markdown', name: 'Not a Role' }).title).toBeNull();
  });
  it('refuses an excess actor field before encrypting public-share body content', async () => {
    const encryption = new ArtifactEncryption(new Uint8Array(32).fill(7));
    // Runtime input deliberately exceeds the TypeScript contract at a storage writer boundary.
    const body = { body: 'Shared', provenance: { savedBy: { kind: 'person', accountId: 'private-actor' } } } as unknown as ArtifactBody;
    await expect(encryption.encryptBody(body)).rejects.toThrow();
  });
  it('drops unknown stored body metadata without disclosing private attribution', async () => {
    const encryption = new ArtifactEncryption(new Uint8Array(32).fill(7));
    const envelope = { body: 'Earlier content', provenance: {
      savedBy: { kind: 'agent' as const, accountId: 'account', sessionId: 'session' }, restoredFromBodyVersion: 1,
    } };
    await expect(encryption.decryptBody(await encryption.encryptHeader(envelope))).resolves.toEqual({ body: 'Earlier content' });
    await expect(encryption.decryptBody(await encryption.encryptHeader({ provenance: envelope.provenance }))).resolves.toBeNull();
  });
  it('opens arbitrary binary bytes in the canonical V0 AES frame and refuses tampering', async () => {
    const key = new Uint8Array(32).fill(7);
    const encryption = new ArtifactEncryption(key);
    const bytes = new Uint8Array([0, 255, 128, 32, 10, 0]);
    const ciphertext = frameSessionDataKeyBundleV0(await sealAesGcmPayloadWebCrypto(bytes, key));
    await expect(encryption.decryptBytes(encodeBase64(ciphertext, 'base64'))).resolves.toEqual(bytes);
    await expect(encryption.decryptBytes(await encryption.encryptBytes(bytes))).resolves.toEqual(bytes);
    ciphertext[ciphertext.length - 1] ^= 1;
    await expect(encryption.decryptBytes(encodeBase64(ciphertext, 'base64'))).rejects.toThrow();
  });
  it('retains binary references and rejects malformed bodies instead of erasing them', async () => {
    const encryption = new ArtifactEncryption(new Uint8Array(32).fill(7));
    const reference = { blobId: '00000000-0000-4000-8000-000000000001', mime: 'image/png', sizeBytes: 4, sha256: 'a'.repeat(64) };
    const stored = await encryption.encryptBody({ body: reference });
    await expect(encryption.decryptBody(stored)).resolves.toEqual({ body: reference });
    // Encode malformed external storage without admitting it through the body type.
    const invalid = await encryption.encryptHeader({ body: { ...reference, sizeBytes: -1 } });
    await expect(encryption.decryptBody(invalid)).resolves.toBeNull();
  });
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

    await expect(encryption.decryptHeaderRaw(encrypted)).resolves.toEqual(header);
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
