import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveRelayRuntimeDefaults } from './relayRuntime.js';
import { installOrUpdateRelayRuntimeLocal } from './relayRuntimeInstall.js';

describe('installOrUpdateRelayRuntimeLocal', () => {
  it('creates and populates the sqlite migrations directory from the server payload', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');

      await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: false,
        skipHealthCheck: true,
      });

      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      const migrationsDestDir = join(defaults.dataDir, 'migrations', 'sqlite');
      const installedMigrationPath = join(migrationsDestDir, '20200101000000_init', 'migration.sql');

      await expect(readFileText(installedMigrationPath)).resolves.toContain('-- init');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

async function readFileText(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return await readFile(path, 'utf8');
}

