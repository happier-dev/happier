import { describe, expect, it } from 'vitest';

import { decodeBase64, encodeBase64, encrypt } from '@/api/encryption';

import { decryptAccountSettingsCiphertext } from './accountSettingsClient';

describe('accountSettingsClient', () => {
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
});

