import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

import { readOrCreateDeviceLocalSecretStorage } from './deviceLocalSecretStorage';

describe('deviceLocalSecretStorage', () => {
  it('publishes one device-local key under concurrent startup and reuses it across daemon restarts', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-device-local-secret-'));
    const privateDirectory = join(home, 'private');
    const path = join(privateDirectory, 'device-local-secret.json');
    try {
      const stores = await Promise.all(
        Array.from({ length: 8 }, async () =>
          await readOrCreateDeviceLocalSecretStorage({ path })),
      );
      const sealed = stores[0]!.sealJson({
        purpose: 'session_respawn_environment',
        value: { OPENAI_API_KEY: 'secret' },
        randomBytes: (length) => new Uint8Array(length).fill(7),
      });

      expect(sealed).not.toContain('secret');
      for (const store of stores) {
        expect(store.openJson({
          purpose: 'session_respawn_environment',
          ciphertext: sealed,
        })).toEqual({ OPENAI_API_KEY: 'secret' });
      }
      const cursorIdentity = stores[0]!.deriveOpaqueIdentity({
        purpose: 'external_session_transcript_refresh_cursor',
        value: 'authority-and-cursor',
      });
      expect(cursorIdentity).toMatch(/^[0-9a-f]{64}$/);
      for (const store of stores) {
        expect(store.deriveOpaqueIdentity({
          purpose: 'external_session_transcript_refresh_cursor',
          value: 'authority-and-cursor',
        })).toBe(cursorIdentity);
      }
      expect(stores[0]!.deriveOpaqueIdentity({
        purpose: 'external_session_transcript_refresh_cursor',
        value: 'changed-authority-or-cursor',
      })).not.toBe(cursorIdentity);
      const memorySettingsKey = stores[0]!.deriveSecretKey({
        purpose: 'memory_settings_secrets',
      });
      expect(memorySettingsKey).toHaveLength(32);
      for (const store of stores) {
        expect(store.deriveSecretKey({
          purpose: 'memory_settings_secrets',
        })).toEqual(memorySettingsKey);
      }
      const pluginSecretsKey = stores[0]!.deriveSecretKey({
        purpose: 'plugin_secrets',
      });
      expect(pluginSecretsKey).toHaveLength(32);
      expect(pluginSecretsKey).not.toEqual(memorySettingsKey);
      for (const store of stores) {
        expect(store.deriveSecretKey({
          purpose: 'plugin_secrets',
        })).toEqual(pluginSecretsKey);
      }
      const npmRegistryCredentialsKey = stores[0]!.deriveSecretKey({
        purpose: 'npm_registry_credentials',
      });
      expect(npmRegistryCredentialsKey).toHaveLength(32);
      expect(npmRegistryCredentialsKey).not.toEqual(pluginSecretsKey);
      expect(npmRegistryCredentialsKey).not.toEqual(memorySettingsKey);
      for (const store of stores) {
        expect(store.deriveSecretKey({
          purpose: 'npm_registry_credentials',
        })).toEqual(npmRegistryCredentialsKey);
      }
      if (process.platform !== 'win32') {
        expect((await stat(privateDirectory)).mode & 0o777).toBe(0o700);
        expect((await stat(path)).mode & 0o777).toBe(0o600);
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it('binds ciphertext to its exact local purpose and device key', async () => {
    const firstHome = await mkdtemp(join(tmpdir(), 'happier-device-local-secret-a-'));
    const secondHome = await mkdtemp(join(tmpdir(), 'happier-device-local-secret-b-'));
    try {
      const first = await readOrCreateDeviceLocalSecretStorage({
        path: join(firstHome, 'key.json'),
      });
      const second = await readOrCreateDeviceLocalSecretStorage({
        path: join(secondHome, 'key.json'),
      });
      const sealed = first.sealJson({
        purpose: 'session_respawn_environment',
        value: { TOKEN: 'one' },
        randomBytes: (length) => new Uint8Array(length).fill(3),
      });

      expect(second.openJson({
        purpose: 'session_respawn_environment',
        ciphertext: sealed,
      })).toBeNull();
      expect(first.openJson({
        purpose: 'session_respawn_environment',
        ciphertext: `${sealed}x`,
      })).toBeNull();
    } finally {
      await Promise.all([
        rm(firstHome, { recursive: true, force: true }),
        rm(secondHome, { recursive: true, force: true }),
      ]);
    }
  });

  it('fails closed on a corrupt existing key instead of replacing it', async () => {
    const home = await mkdtemp(join(tmpdir(), 'happier-device-local-secret-corrupt-'));
    const path = join(home, 'key.json');
    try {
      await writeFile(path, '{"version":1,"key":"invalid"}', { mode: 0o600 });
      await expect(readOrCreateDeviceLocalSecretStorage({ path })).rejects.toThrow(
        /Invalid device-local secret key/,
      );
      await expect(readOrCreateDeviceLocalSecretStorage({ path })).rejects.toThrow(
        /Invalid device-local secret key/,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
