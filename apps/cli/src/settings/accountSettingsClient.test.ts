import { describe, expect, it, vi } from 'vitest';
import { runAddedHostedSession } from '@/agent/runtime/lifecycle/hostedSessionScope';
import { logger } from '@/ui/logger';

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
  it('uses the hosted Session diagnostic preference without changing host logging', async () => {
    vi.stubEnv('HAPPIER_DEBUG_ACCOUNT_SETTINGS', '0');
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const secret = new Uint8Array(32).fill(7);
    const ciphertext = sealAccountScopedBlobCiphertext({ kind: 'account_settings', material: { type: 'legacy', secret },
      payload: { themePreference: 'dark' }, randomBytes: () => new Uint8Array(24).fill(1) });
    try {
      await runAddedHostedSession({ environment: { NODE_ENV: 'test', HAPPIER_DEBUG_ACCOUNT_SETTINGS: '1' },
        workingDirectory: '/session/settings-debug', end() {} }, async () => {
        expect(await decryptAccountSettingsCiphertext({ credentials: { token: 't', encryption: { type: 'legacy', secret } },
          ciphertext })).toEqual({ themePreference: 'dark' });
      });
      expect(debug).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ keyCount: 1 }));
      expect(process.env.HAPPIER_DEBUG_ACCOUNT_SETTINGS).toBe('0');
    } finally { debug.mockRestore(); vi.unstubAllEnvs(); }
  });

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
    const settings = { codexBackendMode: 'mcp', claudeRemoteSettingSources: 'none' };
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

  it('fails closed on ambiguous untagged legacy settings ciphertext', async () => {
    const secret = new Uint8Array(32).fill(7);
    const settings = { codexBackendMode: 'acp', claudeRemoteAgentSdkEnabled: true };
    const ciphertext = encodeBase64(encrypt(secret, 'legacy', settings));

    const decrypted = await decryptAccountSettingsCiphertext({
      credentials: { token: 't', encryption: { type: 'legacy', secret } },
      ciphertext,
    });

    expect(decrypted).toBeNull();
  });

  it('fails closed on ambiguous untagged dataKey settings ciphertext', async () => {
    const machineKey = new Uint8Array(32).fill(9);
    const settings = { codexBackendMode: 'mcp', claudeRemoteSettingSources: 'none' };
    const ciphertext = encodeBase64(encrypt(machineKey, 'dataKey', settings));

    const decrypted = await decryptAccountSettingsCiphertext({
      credentials: { token: 't', encryption: { type: 'dataKey', publicKey: new Uint8Array(32).fill(1), machineKey } },
      ciphertext,
    });

    expect(decrypted).toBeNull();
  });

  it('rejects an untagged automation object authenticated by the shared historical raw key', async () => {
    const secret = new Uint8Array(32).fill(7);
    const ciphertext = encodeBase64(encrypt(secret, 'legacy', {
      name: 'nightly automation',
      prompt: 'do not interpret this as settings',
    }));

    await expect(decryptAccountSettingsCiphertext({
      credentials: {
        token: 't',
        encryption: { type: 'legacy', secret },
      },
      ciphertext,
    })).resolves.toBeNull();
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
