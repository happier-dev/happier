import { describe, expect, it } from 'vitest';

import {
  decodeBase64,
  encodeBase64,
  encrypt,
  libsodiumEncryptForPublicKey,
  libsodiumPublicKeyFromSecretKey,
} from '@/api/encryption';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol';

import { decryptAccountSettingsCiphertext } from './accountSettingsClient';

describe('accountSettingsClient', () => {
  it('decrypts protocol account-scoped v1 ciphertext for legacy credentials', async () => {
    const secret = new Uint8Array(32).fill(7);
    const settings = { codexBackendMode: 'acp', claudeRemoteAgentSdkEnabled: true };
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'legacy', secret },
      payload: settings,
      randomBytes: () => new Uint8Array(24).fill(1),
    });

    const decrypted = await decryptAccountSettingsCiphertext({
      credentials: { token: 't', encryption: { type: 'legacy', secret } },
      ciphertext,
    });

    expect(decrypted).toEqual(settings);
  });

  it('decrypts protocol account-scoped v1 ciphertext for dataKey credentials', async () => {
    const machineKey = new Uint8Array(32).fill(9);
    const settings = { codexBackendMode: 'mcp_resume', claudeRemoteSettingSources: 'none' };
    const ciphertext = sealAccountScopedBlobCiphertext({
      kind: 'account_settings',
      material: { type: 'dataKey', machineKey },
      payload: settings,
      randomBytes: () => new Uint8Array(24).fill(2),
    });

    const decrypted = await decryptAccountSettingsCiphertext({
      credentials: { token: 't', encryption: { type: 'dataKey', publicKey: new Uint8Array(32).fill(1), machineKey } },
      ciphertext,
    });

    expect(decrypted).toEqual(settings);
  });

  it('decrypts account settings ciphertext for legacy credentials', async () => {
    const secret = new Uint8Array(32).fill(7);
    const settings = { codexBackendMode: 'acp', claudeRemoteAgentSdkEnabled: true };
    const ciphertext = encodeBase64(encrypt(secret, 'legacy', settings));

    const decrypted = await decryptAccountSettingsCiphertext({
      credentials: { token: 't', encryption: { type: 'legacy', secret } },
      ciphertext,
    });

    expect(decrypted).toEqual(settings);
  });

  it('decrypts account settings ciphertext for dataKey credentials', async () => {
    const machineKey = new Uint8Array(32).fill(9);
    const settings = { codexBackendMode: 'mcp_resume', claudeRemoteSettingSources: 'none' };
    const ciphertext = encodeBase64(encrypt(machineKey, 'dataKey', settings));

    const decrypted = await decryptAccountSettingsCiphertext({
      credentials: { token: 't', encryption: { type: 'dataKey', publicKey: new Uint8Array(32).fill(1), machineKey } },
      ciphertext,
    });

    expect(decrypted).toEqual(settings);
  });

  it('returns null for invalid ciphertext', async () => {
    const secret = new Uint8Array(32).fill(7);
    const decrypted = await decryptAccountSettingsCiphertext({
      credentials: { token: 't', encryption: { type: 'legacy', secret } },
      ciphertext: encodeBase64(decodeBase64('AA==')), // not valid secretbox bundle
    });
    expect(decrypted).toBeNull();
  });

  it('returns null for versioned box ciphertext (unsupported cipher)', async () => {
    const machineKey = new Uint8Array(32).fill(11);
    const publicKey = libsodiumPublicKeyFromSecretKey(machineKey);
    const settings = { claudeLocalPermissionBridgeEnabled: true, claudeRemoteDisableTodos: true };
    const payload = new TextEncoder().encode(JSON.stringify(settings));
    const encrypted = libsodiumEncryptForPublicKey(payload, publicKey);
    const versioned = new Uint8Array(1 + encrypted.length);
    versioned[0] = 2;
    versioned.set(encrypted, 1);
    const ciphertext = encodeBase64(versioned);

    const decrypted = await decryptAccountSettingsCiphertext({
      credentials: { token: 't', encryption: { type: 'dataKey', publicKey, machineKey } },
      ciphertext,
    });

    expect(decrypted).toBeNull();
  });

});
