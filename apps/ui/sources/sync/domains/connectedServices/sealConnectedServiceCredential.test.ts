import { describe, expect, it } from 'vitest';

import { openAccountScopedBlobCiphertext, ConnectedServiceCredentialRecordV1Schema } from '@happier-dev/protocol';
import { encodeBase64 } from '@/encryption/base64';

import { sealConnectedServiceCredential } from './sealConnectedServiceCredential';

function fixedRandomBytes(byte: number) {
  return (length: number) => new Uint8Array(length).fill(byte);
}

describe('sealConnectedServiceCredential', () => {
  it('seals and opens ciphertext in legacy auth mode', () => {
    const secretBytes = new Uint8Array(32).fill(3);
    const credentials = { token: 't', secret: encodeBase64(secretBytes, 'base64url') } as const;

    const record = ConnectedServiceCredentialRecordV1Schema.parse({
      v: 1,
      serviceId: 'openai-codex',
      profileId: 'work',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      expiresAt: 2,
      kind: 'oauth',
      oauth: {
        accessToken: 'a',
        refreshToken: 'r',
        idToken: 'i',
        scope: null,
        tokenType: null,
        providerAccountId: 'acct',
        providerEmail: null,
      },
      token: null,
    });

    const ciphertext = sealConnectedServiceCredential({
      credentials,
      record,
      randomBytes: fixedRandomBytes(9),
    });

    const opened = openAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'legacy', secret: secretBytes },
      ciphertext,
    });
    expect(opened?.value).toEqual(record);
  });

  it('seals and opens ciphertext in dataKey auth mode', () => {
    const machineKey = new Uint8Array(32).fill(7);
    const credentials = {
      token: 't',
      encryption: { publicKey: encodeBase64(new Uint8Array(32).fill(1)), machineKey: encodeBase64(machineKey) },
    } as const;

    const record = ConnectedServiceCredentialRecordV1Schema.parse({
      v: 1,
      serviceId: 'anthropic',
      profileId: 'personal',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      expiresAt: null,
      kind: 'token',
      oauth: null,
      token: {
        token: 'setup-token',
        providerAccountId: null,
        providerEmail: 'user@example.com',
      },
    });

    const ciphertext = sealConnectedServiceCredential({
      credentials,
      record,
      randomBytes: fixedRandomBytes(4),
    });

    const opened = openAccountScopedBlobCiphertext({
      kind: 'connected_service_credential',
      material: { type: 'dataKey', machineKey },
      ciphertext,
    });
    expect(opened?.value).toEqual(record);
  });
});

