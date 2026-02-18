import { createHash } from 'node:crypto';
import tweetnacl from 'tweetnacl';
import { describe, expect, it, vi } from 'vitest';

import { decodeBase64, encodeBase64 } from '@/api/encryption';
import { sealEncryptedDataKeyEnvelopeV1 } from '@happier-dev/protocol';

vi.mock('@/session/replay/fetchSessionDataEncryptionKey', () => ({
  fetchSessionDataEncryptionKey: vi.fn(async () => null),
}));

import { fetchSessionDataEncryptionKey } from '@/session/replay/fetchSessionDataEncryptionKey';

import type { Credentials } from '@/persistence';
import { resolveExistingSessionEncryptionKeyBase64 } from './resolveExistingSessionEncryptionKeyBase64';

function deterministicRandomBytesFactory(): (length: number) => Uint8Array {
  let counter = 1;
  return (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) {
      out[i] = counter & 0xff;
      counter++;
    }
    return out;
  };
}

describe('resolveExistingSessionEncryptionKeyBase64', () => {
  it('returns null (and does not fetch) when sessionId is blank', async () => {
    const credentials: Credentials = {
      token: 't',
      encryption: { type: 'dataKey', publicKey: new Uint8Array(32).fill(1), machineKey: new Uint8Array(32).fill(2) },
    };

    const out = await resolveExistingSessionEncryptionKeyBase64({ credentials, sessionId: '   ' });
    expect(out).toBeNull();
    expect(vi.mocked(fetchSessionDataEncryptionKey)).not.toHaveBeenCalled();
  });

  it('returns base64 encoded DEK for dataKey credentials when server provides an encrypted envelope', async () => {
    const seed = new Uint8Array(32).fill(11);
    const compatSecretKey = createHash('sha512').update(seed).digest().subarray(0, 32);
    const recipientPublicKey = tweetnacl.box.keyPair.fromSecretKey(compatSecretKey).publicKey;
    const dataKey = new Uint8Array(32).fill(4);

    const envelope = sealEncryptedDataKeyEnvelopeV1({
      dataKey,
      recipientPublicKey,
      randomBytes: deterministicRandomBytesFactory(),
    });
    const encryptedEnvelopeBase64 = encodeBase64(envelope, 'base64');

    vi.mocked(fetchSessionDataEncryptionKey).mockResolvedValueOnce(encryptedEnvelopeBase64);

    const credentials: Credentials = {
      token: 't',
      encryption: {
        type: 'dataKey',
        publicKey: new Uint8Array(32).fill(8),
        machineKey: seed,
      },
    };

    const out = await resolveExistingSessionEncryptionKeyBase64({ credentials, sessionId: 'sess_123' });
    expect(out).toBeTypeOf('string');

    const opened = decodeBase64(out!, 'base64');
    expect(Array.from(opened)).toEqual(Array.from(dataKey));
  });
});
