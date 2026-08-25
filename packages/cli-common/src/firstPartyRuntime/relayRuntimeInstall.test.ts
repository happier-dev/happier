import { access, chmod, lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveRelayRuntimeDefaults } from './relayRuntime.js';
import { installOrUpdateRelayRuntimeLocal } from './relayRuntimeInstall.js';

describe('installOrUpdateRelayRuntimeLocal', () => {
  it('returns the env-overridden baseUrl instead of the default relay port', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');

      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        env: {
          PORT: '4010',
        },
        runServiceCommands: false,
        skipHealthCheck: true,
      })).resolves.toMatchObject({
        baseUrl: 'http://127.0.0.1:4010',
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

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

  it('preserves an existing configured PORT when reinstalling without an explicit override', async () => {
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
        env: {
          PORT: '4010',
        },
        runServiceCommands: false,
        skipHealthCheck: true,
      });

      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: false,
        skipHealthCheck: true,
      })).resolves.toMatchObject({
        baseUrl: 'http://127.0.0.1:4010',
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('preserves operator-owned web app URLs when reinstalling without explicit overrides', async () => {
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
        env: {
          HAPPIER_WEBAPP_URL: 'https://web.example.test',
          HAPPY_WEBAPP_URL: 'https://legacy-web.example.test',
        },
        runServiceCommands: false,
        skipHealthCheck: true,
      });

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
      const envText = await readFileText(join(defaults.configDir, 'server.env'));
      expect(envText).toContain('HAPPIER_WEBAPP_URL=https://web.example.test');
      expect(envText).toContain('HAPPY_WEBAPP_URL=https://legacy-web.example.test');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('auto-selects a non-colliding port when a sibling relay already uses the default port', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-port-collision-'));
    try {
      const stableDefaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        homeDir,
      });
      await mkdir(stableDefaults.configDir, { recursive: true });
      await mkdir(stableDefaults.installRoot, { recursive: true });
      await writeFile(join(stableDefaults.configDir, 'server.env'), 'PORT=3005\nHAPPIER_SERVER_HOST=127.0.0.1\n', 'utf8');
      await writeFile(join(stableDefaults.installRoot, 'self-host-state.json'), JSON.stringify({ channel: 'stable', mode: 'user', version: '0.3.0-test' }), 'utf8');

      const previewDefaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      await mkdir(previewDefaults.configDir, { recursive: true });
      await writeFile(join(previewDefaults.configDir, 'server.env'), 'PORT=3005\nHAPPIER_SERVER_HOST=127.0.0.1\n', 'utf8');

      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');

      const result = await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: false,
        skipHealthCheck: true,
      });

      expect(result.baseUrl).not.toBe('http://127.0.0.1:3005');

      const envText = await readFileText(join(previewDefaults.configDir, 'server.env'));
      const advertisedPort = new URL(result.baseUrl).port;
      expect(envText).toContain(`PORT=${advertisedPort}`);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('rejects an explicit PORT override that collides with a sibling relay', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-explicit-port-collision-'));
    try {
      const stableDefaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        homeDir,
      });
      await mkdir(stableDefaults.configDir, { recursive: true });
      await mkdir(stableDefaults.installRoot, { recursive: true });
      await writeFile(join(stableDefaults.configDir, 'server.env'), 'PORT=3005\nHAPPIER_SERVER_HOST=127.0.0.1\n', 'utf8');
      await writeFile(join(stableDefaults.installRoot, 'self-host-state.json'), JSON.stringify({ channel: 'stable', mode: 'user', version: '0.3.0-test' }), 'utf8');

      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');

      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        env: { PORT: '3005' },
        runServiceCommands: false,
        skipHealthCheck: true,
      })).rejects.toThrow(/PORT=3005/i);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('copies the installed server binary into the persistent install root so launchd does not depend on the temp payload path', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    const payloadRoot = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-payload-'));
    try {
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      const prismaClientDir = join(payloadRoot, 'node_modules', '.prisma', 'client');
      const generatedSqliteClientDir = join(payloadRoot, 'generated', 'sqlite-client');
      await mkdir(migrationsSourceDir, { recursive: true });
      await mkdir(prismaClientDir, { recursive: true });
      await mkdir(generatedSqliteClientDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');
      await writeFile(join(prismaClientDir, 'libquery_engine-darwin-arm64.dylib.node'), 'engine\n', 'utf8');
      await writeFile(join(generatedSqliteClientDir, 'libquery_engine-darwin-arm64.dylib.node'), 'generated-engine\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');

      await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'darwin',
        arch: 'arm64',
        homeDir,
        runServiceCommands: false,
        skipHealthCheck: true,
      });

      const defaults = resolveRelayRuntimeDefaults({
        platform: 'darwin',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      const installedBinaryPath = join(defaults.installRoot, 'bin', 'happier-server');
      const envPath = join(defaults.configDir, 'server.env');
      const installedPrismaEnginePath = join(defaults.installRoot, 'bin', 'node_modules', '.prisma', 'client', 'libquery_engine-darwin-arm64.dylib.node');
      const installedGeneratedEnginePath = join(defaults.installRoot, 'bin', 'generated', 'sqlite-client', 'libquery_engine-darwin-arm64.dylib.node');

      await rm(payloadRoot, { recursive: true, force: true });

      await expect(access(installedBinaryPath, constants.X_OK)).resolves.toBeUndefined();
      await expect(readFileText(installedPrismaEnginePath)).resolves.toBe('engine\n');
      await expect(readFileText(installedGeneratedEnginePath)).resolves.toBe('generated-engine\n');
      await expect(lstat(installedBinaryPath)).resolves.toSatisfy((stats) => stats.isSymbolicLink() === false);
      const envText = await readFileText(envPath);
      expect(envText).toContain('HAPPIER_SQLITE_AUTO_MIGRATE=1');
      expect(envText).toContain(`NODE_PATH=${join(defaults.installRoot, 'bin', 'node_modules')}`);
      expect(envText).toContain(`PRISMA_QUERY_ENGINE_LIBRARY=${installedPrismaEnginePath}`);
    } finally {
      await rm(payloadRoot, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('writes HAPPIER_SERVER_UI_DIR pointing at the ui-web/current directory under the install root', async () => {
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
      const envPath = join(defaults.configDir, 'server.env');

      await expect(readFileText(envPath)).resolves.toContain(`HAPPIER_SERVER_UI_DIR=${join(defaults.installRoot, 'ui-web', 'current')}`);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('rejects HAPPIER_SERVER_UI_DIR overrides instead of persisting a volatile UI source path', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');

      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        env: {
          HAPPIER_SERVER_UI_DIR: join(tmpdir(), 'happier-ui-web-volatile'),
        },
        runServiceCommands: false,
        skipHealthCheck: true,
      })).rejects.toThrow(/owned by the relay runtime installer/i);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('removes stale managed root entries that are absent from the new payload', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-stale-root-'));
    try {
      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      await mkdir(join(defaults.installRoot, 'ui-web', 'current'), { recursive: true });
      await writeFile(join(defaults.installRoot, 'ui-web', 'current', 'index.html'), '<html>stale</html>\n', 'utf8');

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

      await expect(readFileText(join(defaults.installRoot, 'ui-web', 'current', 'index.html'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('preserves relay payload symlinks instead of materializing their target contents', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-symlink-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      const generatedDir = join(payloadRoot, 'generated');
      const externalTargetPath = join(homeDir, 'external-runtime-sidecar.js');
      await mkdir(migrationsSourceDir, { recursive: true });
      await mkdir(generatedDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');
      await writeFile(externalTargetPath, 'export const outside = true;\n', 'utf8');
      await symlink(externalTargetPath, join(generatedDir, 'runtime-sidecar.js'));

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
      const installedPath = join(defaults.installRoot, 'bin', 'generated', 'runtime-sidecar.js');

      await expect(lstat(installedPath)).resolves.toSatisfy((stats) => stats.isSymbolicLink());
      await expect(readlink(installedPath)).resolves.toBe(externalTargetPath);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('migrates an owned custom suffixed preview unit root into the canonical preview install root', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-owned-root-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');

      const defaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      const ownedInstallRoot = join(homeDir, '.happier', 'custom-preview-root');
      const unitDir = join(homeDir, '.config', 'systemd', 'user');
      await mkdir(join(ownedInstallRoot, 'config'), { recursive: true });
      await writeFile(join(ownedInstallRoot, 'config', 'session.json'), 'keep-me\n', 'utf8');
      await mkdir(unitDir, { recursive: true });
      await writeFile(
        join(unitDir, 'happier-server-preview.service'),
        [
          '[Service]',
          `WorkingDirectory=${ownedInstallRoot}`,
          `ExecStart=${join(ownedInstallRoot, 'bin', 'happier-server')}`,
          '',
        ].join('\n'),
        'utf8',
      );

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

      await expect(readFileText(join(defaults.installRoot, 'config', 'session.json'))).resolves.toContain('keep-me');
      await expect(lstat(ownedInstallRoot)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('installs sibling ui-web assets when the provided Windows server binary lives under bin/', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const binDir = join(payloadRoot, 'bin');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      const uiSourceDir = join(payloadRoot, 'ui-web', 'current');
      await mkdir(binDir, { recursive: true });
      await mkdir(migrationsSourceDir, { recursive: true });
      await mkdir(uiSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');
      await writeFile(join(uiSourceDir, 'index.html'), '<html>preview</html>\n', 'utf8');

      const serverBinaryPath = join(binDir, 'happier-server.exe');
      await writeFile(serverBinaryPath, 'stub exe\n', 'utf8');

      await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'win32',
        arch: 'x64',
        homeDir,
        runServiceCommands: false,
        skipHealthCheck: true,
      });

      const defaults = resolveRelayRuntimeDefaults({
        platform: 'win32',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      const installedUiPath = join(defaults.installRoot, 'ui-web', 'current', 'index.html');

      await expect(readFileText(installedUiPath)).resolves.toContain('preview');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('normalizes root-level Windows server payloads into the installRoot bin layout without dropping sidecars', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      const uiSourceDir = join(payloadRoot, 'ui-web', 'current');
      await mkdir(migrationsSourceDir, { recursive: true });
      await mkdir(uiSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');
      await writeFile(join(uiSourceDir, 'index.html'), '<html>preview</html>\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server.exe');
      await writeFile(serverBinaryPath, 'stub exe\n', 'utf8');

      await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'win32',
        arch: 'x64',
        homeDir,
        runServiceCommands: false,
        skipHealthCheck: true,
      });

      const defaults = resolveRelayRuntimeDefaults({
        platform: 'win32',
        mode: 'user',
        channel: 'preview',
        homeDir,
      });
      const installedBinaryPath = join(defaults.installRoot, 'bin', 'happier-server.exe');
      const installedUiPath = join(defaults.installRoot, 'ui-web', 'current', 'index.html');
      const installedMigrationPath = join(
        defaults.installRoot,
        'prisma',
        'sqlite',
        'migrations',
        '20200101000000_init',
        'migration.sql',
      );

      await expect(readFileText(installedBinaryPath)).resolves.toContain('stub exe');
      await expect(readFileText(installedUiPath)).resolves.toContain('preview');
      await expect(readFileText(installedMigrationPath)).resolves.toContain('-- init');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('rolls back the previous install when a reinstall fails mid-copy', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    const payloadRoot = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-payload-'));
    try {
      const migrationsSourceDir = join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
      await mkdir(migrationsSourceDir, { recursive: true });
      await writeFile(join(migrationsSourceDir, 'migration.sql'), '-- init\n', 'utf8');

      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok1\n', 'utf8');

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
      const installedBinaryPath = join(defaults.installRoot, 'bin', 'happier-server');
      const markerPath = join(defaults.installRoot, 'bin', 'marker.txt');
      await writeFile(markerPath, 'marker\n', 'utf8');

      await expect(readFileText(installedBinaryPath)).resolves.toContain('ok1');

      const failingPayloadRoot = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-failing-payload-'));
      try {
        const failingMigrationsDir = join(failingPayloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init');
        await mkdir(failingMigrationsDir, { recursive: true });
        await writeFile(join(failingMigrationsDir, 'migration.sql'), '-- init2\n', 'utf8');
        const failingBinaryPath = join(failingPayloadRoot, 'happier-server');
        await writeFile(failingBinaryPath, '#!/bin/sh\necho ok2\n', 'utf8');

        const unreadablePath = join(failingPayloadRoot, 'unreadable.txt');
        await writeFile(unreadablePath, 'nope\n', 'utf8');
        await chmod(unreadablePath, 0o000);

        await expect(installOrUpdateRelayRuntimeLocal({
          serverBinaryPath: failingBinaryPath,
          channel: 'preview',
          mode: 'user',
          platform: 'linux',
          arch: 'arm64',
          homeDir,
          runServiceCommands: false,
          skipHealthCheck: true,
        })).rejects.toBeTruthy();
      } finally {
        await rm(failingPayloadRoot, { recursive: true, force: true });
      }

      await expect(readFileText(installedBinaryPath)).resolves.toContain('ok1');
      await expect(readFileText(markerPath)).resolves.toContain('marker');
    } finally {
      await rm(payloadRoot, { recursive: true, force: true });
      await rm(homeDir, { recursive: true, force: true });
    }
  });
});

async function readFileText(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises');
  return await readFile(path, 'utf8');
}
