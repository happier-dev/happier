import { describe, expect, it } from 'vitest';

import { resolveMachineEncryptionContext, resolveSessionEncryptionContext } from './encryptionKey';

describe('token-only encryption context', () => {
  it('refuses encrypted operations without account key material', () => {
    expect(() => resolveSessionEncryptionContext({ token: 'plain', encryption: null }))
      .toThrowError(expect.objectContaining({ code: 'ACCOUNT_ENCRYPTION_KEY_REQUIRED' }));
    expect(() => resolveMachineEncryptionContext({ token: 'plain', encryption: null }))
      .toThrowError(expect.objectContaining({ code: 'ACCOUNT_ENCRYPTION_KEY_REQUIRED' }));
  });
});

describe('resolveSessionEncryptionContext', () => {
  it('generates a per-session AES key and publishes an encrypted dataEncryptionKey bundle when credentials are dataKey', () => {
    const machineKey = new Uint8Array(32).fill(7);
    const publicKey = new Uint8Array(32).fill(3);

    const res = resolveSessionEncryptionContext({
      token: 't',
      encryption: {
        type: 'dataKey',
        publicKey,
        machineKey,
      },
    });

    expect(res.encryptionVariant).toBe('dataKey');
    expect(res.encryptionKey).toBeInstanceOf(Uint8Array);
    expect(res.encryptionKey.length).toBe(32);
    expect(res.dataEncryptionKey).not.toBeNull();
    expect(res.dataEncryptionKey![0]).toBe(0);
    expect(res.dataEncryptionKey!.length).toBeGreaterThan(1);
  });
});
