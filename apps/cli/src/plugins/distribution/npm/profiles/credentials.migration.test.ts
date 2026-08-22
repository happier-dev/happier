import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const migrationFaults = vi.hoisted(() => ({
  failBeforeReseal: false,
  failLegacyKeyRetirement: false,
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async unlink(path: Parameters<typeof actual.unlink>[0]): Promise<void> {
      if (
        migrationFaults.failLegacyKeyRetirement
        && String(path).endsWith('/plugin-secrets-key.v1')
      ) {
        throw new Error('injected legacy-key retirement failure');
      }
      await actual.unlink(path);
    },
  };
});

vi.mock('@/plugins/runtime/context/secrets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/plugins/runtime/context/secrets')>();
  return {
    ...actual,
    async resealPurposeKeyedPluginSecretStore(
      ...args: Parameters<typeof actual.resealPurposeKeyedPluginSecretStore>
    ): Promise<void> {
      if (migrationFaults.failBeforeReseal) {
        throw new Error('injected pre-reseal failure');
      }
      await actual.resealPurposeKeyedPluginSecretStore(...args);
    },
  };
});

import { createNpmRegistryCredentialStore } from './credentials';
import { createPurposeKeyedPluginSecretStore } from '@/plugins/runtime/context/secrets';
import { resolvePluginStorePaths } from '@/plugins/store/paths';

describe('NPM registry credential legacy migration recovery', () => {
  const roots: string[] = [];

  afterEach(async () => {
    migrationFaults.failBeforeReseal = false;
    migrationFaults.failLegacyKeyRetirement = false;
    await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
  });

  async function createLegacyCredentialStore(): Promise<Readonly<{
    happyHomeDir: string;
    legacyKeyPath: string;
  }>> {
    const happyHomeDir = await mkdtemp(join(tmpdir(), 'happier-npm-credential-migration-'));
    roots.push(happyHomeDir);
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const legacyKey = new Uint8Array(32).fill(7);
    const legacyKeyPath = join(paths.secretsDir, 'plugin-secrets-key.v1');
    await mkdir(paths.secretsDir, { recursive: true });
    await writeFile(legacyKeyPath, JSON.stringify({
      t: 'happier_plugin_secret_key_v1',
      key: Buffer.from(legacyKey).toString('base64'),
    }), 'utf8');
    await chmod(legacyKeyPath, 0o600);
    const legacy = createPurposeKeyedPluginSecretStore({
      pluginId: 'happier.npm.registry.credentials',
      paths,
      secretKey: legacyKey,
    });
    await legacy.set('legacy-npm-credential', 'Bearer migration-secret');
    return { happyHomeDir, legacyKeyPath };
  }

  it('keeps the legacy credential readable when resealing fails before the destination rewrite', async () => {
    const { happyHomeDir, legacyKeyPath } = await createLegacyCredentialStore();
    migrationFaults.failBeforeReseal = true;

    const credentials = createNpmRegistryCredentialStore({ happyHomeDir });

    await expect(credentials.get('legacy-npm-credential')).resolves.toBe('Bearer migration-secret');
    await expect(access(legacyKeyPath)).resolves.toBeUndefined();
  });

  it('reseals its namespace while retaining a legacy key that still protects another namespace', async () => {
    const { happyHomeDir, legacyKeyPath } = await createLegacyCredentialStore();
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const unrelatedLegacyStore = createPurposeKeyedPluginSecretStore({
      pluginId: 'example.other-legacy-plugin',
      paths,
      secretKey: new Uint8Array(32).fill(7),
    });
    await unrelatedLegacyStore.set('unrelated-secret', 'must-remain-readable');

    const credentials = createNpmRegistryCredentialStore({ happyHomeDir });

    await expect(credentials.get('legacy-npm-credential')).resolves.toBe('Bearer migration-secret');
    await expect(access(legacyKeyPath)).resolves.toBeUndefined();
    await expect(unrelatedLegacyStore.get('unrelated-secret')).resolves.toBe('must-remain-readable');
    await expect(credentials.get('legacy-npm-credential')).resolves.toBe('Bearer migration-secret');
  });

  it('keeps the resealed destination readable when legacy-key retirement is interrupted, then retries retirement', async () => {
    const { happyHomeDir, legacyKeyPath } = await createLegacyCredentialStore();
    migrationFaults.failLegacyKeyRetirement = true;

    const interrupted = createNpmRegistryCredentialStore({ happyHomeDir });

    await expect(interrupted.get('legacy-npm-credential')).resolves.toBe('Bearer migration-secret');
    await expect(access(legacyKeyPath)).resolves.toBeUndefined();

    migrationFaults.failLegacyKeyRetirement = false;
    const recovered = createNpmRegistryCredentialStore({ happyHomeDir });
    await expect(recovered.get('legacy-npm-credential')).resolves.toBe('Bearer migration-secret');
    await expect(access(legacyKeyPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
