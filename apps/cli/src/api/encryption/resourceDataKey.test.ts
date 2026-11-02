import { describe, expect, it } from 'vitest';

import { createResourceDataKey, openResourceDataKey } from './resourceDataKey';
import { computeContentPublicKeyFingerprint } from '@happier-dev/protocol/machines/identity/contentPublicKeyFingerprint';
import { libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import { deriveKey } from '@/utils/deriveKey';

describe('resource data key envelopes', () => {
  const credentials = {
    token: 'owner', encryption: { type: 'legacy' as const, secret: new Uint8Array(32).fill(7) },
  };

  it('opens each independent resource key only for its actual recipient', async () => {
    const first = await createResourceDataKey({ credentials, mode: 'e2ee',
      expectedContentPublicKeyFingerprint: computeContentPublicKeyFingerprint(libsodiumPublicKeyFromSecretKey(
        await deriveKey(credentials.encryption.secret, 'Happy EnCoder', ['content']),
      )),
    });
    const second = await createResourceDataKey({ credentials, mode: 'e2ee' });
    expect(first.dataKey).not.toEqual(second.dataKey);
    await expect(openResourceDataKey({ credentials, mode: 'e2ee', dataEncryptionKey: first.dataEncryptionKey }))
      .resolves.toEqual(first);
    await expect(openResourceDataKey({
      credentials: { encryption: { type: 'legacy', secret: new Uint8Array(32).fill(8) } },
      mode: 'e2ee', dataEncryptionKey: first.dataEncryptionKey,
    })).rejects.toMatchObject({ code: 'resource_encryption_material_unavailable' });
    await expect(openResourceDataKey({
      credentials: { encryption: null }, mode: 'e2ee', dataEncryptionKey: first.dataEncryptionKey,
    })).rejects.toMatchObject({ code: 'resource_encryption_material_unavailable' });
  });

  it('keeps explicit plain resources keyless and rejects mode/envelope disagreement', async () => {
    const keyless = { token: 'plain', encryption: null };
    const plain = { mode: 'plain', dataKey: null, dataEncryptionKey: null };
    await expect(createResourceDataKey({ credentials: keyless, mode: 'plain' })).resolves.toEqual(plain);
    await expect(openResourceDataKey({ credentials: keyless, mode: 'plain', dataEncryptionKey: null }))
      .resolves.toEqual(plain);
    await expect(openResourceDataKey({ credentials, mode: 'plain', dataEncryptionKey: 'not-plain' }))
      .rejects.toMatchObject({ code: 'resource_encryption_material_unavailable' });
    await expect(openResourceDataKey({ credentials, mode: 'e2ee', dataEncryptionKey: null }))
      .rejects.toMatchObject({ code: 'resource_encryption_material_unavailable' });
  });

  it('rejects a stale owner binding before creating a resource envelope', async () => {
    await expect(createResourceDataKey({ credentials, mode: 'e2ee',
      ...{ expectedContentPublicKeyFingerprint: 'a'.repeat(64) },
    })).rejects.toMatchObject({ code: 'resource_encryption_material_unavailable' });
  });
});
