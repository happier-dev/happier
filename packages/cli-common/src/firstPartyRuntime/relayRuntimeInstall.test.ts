import { access, chmod, lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { resolveRelayRuntimeDefaults } from './relayRuntime.js';
import { installOrUpdateRelayRuntimeLocal } from './relayRuntimeInstall.js';
import { createWindowsServiceLauncherPeFixture } from '../../../../scripts/testing/windowsServiceLauncherPeFixture.mjs';
import { writePersonalHomeServerArtifactCapability } from './personalHome/artifactContract.js';

describe('installOrUpdateRelayRuntimeLocal', () => {
  it('rejects a capability-less Personal Home artifact before any durable runtime mutation', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-personal-home-artifact-admission-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      await mkdir(payloadRoot, { recursive: true });
      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho incompatible\n', 'utf8');
      const cleanupLegacyServiceBeforeInstall = vi.fn(async () => undefined);
      const assertPersonalHomeStopped = vi.fn(async () => undefined);

      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        homeDir,
        purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
        assertPersonalHomeStopped,
        cleanupLegacyServiceBeforeInstall,
        env: { PORT: '43123', AUTH_ANONYMOUS_SIGNUP_ENABLED: '0' },
        runServiceCommands: false,
        skipHealthCheck: true,
      })).rejects.toMatchObject({ code: 'personal_home_artifact_update_required' });

      const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'preview', homeDir });
      expect(cleanupLegacyServiceBeforeInstall).not.toHaveBeenCalled();
      expect(assertPersonalHomeStopped).not.toHaveBeenCalled();
      expect(existsSync(join(defaults.installRoot, 'self-host-state.json'))).toBe(false);
      expect(existsSync(join(defaults.installRoot, 'bin', 'happier-server'))).toBe(false);
      expect(existsSync(defaults.configDir)).toBe(false);
      expect(existsSync(join(defaults.dataDir, 'pglite'))).toBe(false);
      expect(existsSync(join(defaults.dataDir, 'migrations'))).toBe(false);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

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
        purpose: { kind: 'generic' },
        env: {
          PORT: '4010',
        },
        runServiceCommands: false,
        skipHealthCheck: true,
      })).resolves.toMatchObject({
        baseUrl: 'http://127.0.0.1:4010',
      });

      const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'preview', homeDir });
      const envText = await readFileText(join(defaults.configDir, 'server.env'));
      expect(envText).toContain('HAPPIER_MANAGED_RELAY_PURPOSE=generic');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('preserves the frozen Home device-approval setting on a first Personal Home install', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-personal-home-approval-'));
    const previousApproval = process.env.HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED;
    try {
      process.env.HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED = '1';
      const payloadRoot = join(homeDir, 'payload');
      await mkdir(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init'), { recursive: true });
      await writeFile(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init', 'migration.sql'), '-- init\n', 'utf8');
      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');
      await writePersonalHomeServerArtifactCapability(payloadRoot);

      await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
        assertPersonalHomeStopped: async () => undefined,
        env: { PORT: '43123' },
        runServiceCommands: false,
        skipHealthCheck: true,
      });

      const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'preview', homeDir });
      const envText = await readFileText(join(defaults.configDir, 'server.env'));
      expect(envText).toContain('HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED=1');
    } finally {
      if (previousApproval === undefined) delete process.env.HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED;
      else process.env.HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED = previousApproval;
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('rejects a Personal Home payload mutation without the canonical stopped-Home assertion', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-personal-home-missing-stop-assertion-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      await mkdir(payloadRoot, { recursive: true });
      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');

      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        homeDir,
        purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
        env: { PORT: '43123', AUTH_ANONYMOUS_SIGNUP_ENABLED: '0' },
        runServiceCommands: false,
        skipHealthCheck: true,
      })).rejects.toThrow('requires the canonical stopped-Home assertion');

      const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'preview', homeDir });
      await expect(lstat(join(defaults.installRoot, 'bin', 'happier-server'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('preserves signup closure and the existing Home approval policy across a managed update', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-personal-home-update-policy-'));
    const previousApproval = process.env.HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED;
    try {
      const canonicalServerUrl = 'http://127.0.0.1:43123';
      const payloadRoot = join(homeDir, 'payload');
      await mkdir(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init'), { recursive: true });
      await writeFile(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init', 'migration.sql'), '-- init\n', 'utf8');
      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');
      await writePersonalHomeServerArtifactCapability(payloadRoot);
      const personalHomeEnv = {
        HAPPIER_SERVER_HOST: '127.0.0.1',
        PORT: '43123',
        HAPPIER_CANONICAL_SERVER_URL: canonicalServerUrl,
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
        HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',
        AUTH_ANONYMOUS_SIGNUP_ENABLED: '0',
      };
      const install = async (env: Readonly<Record<string, string>> = personalHomeEnv) => await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        purpose: { kind: 'personal-home' as const, canonicalServerUrl },
        assertPersonalHomeStopped: async () => undefined,
        env,
        runServiceCommands: false,
        skipHealthCheck: true,
      });

      process.env.HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED = '1';
      await install({
        ...personalHomeEnv,
        HAPPIER_IROH_RELAY_POLICY: 'automatic',
        HAPPIER_IROH_RELAY_URLS: 'https://relay-b.example.test,https://relay-a.example.test',
      });
      const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'preview', homeDir });
      await writeFile(join(defaults.configDir, 'server.env'), `${await readFileText(join(defaults.configDir, 'server.env'))}HAPPIER_PUBLIC_SERVER_URL=${canonicalServerUrl}\nHAPPIER_PUBLIC_SERVER_URL_INFERRED=1\n`, 'utf8');
      await install();
      const contractedEnvText = await readFileText(join(defaults.configDir, 'server.env'));
      expect(contractedEnvText).not.toContain('HAPPIER_PUBLIC_SERVER_URL=');
      expect(contractedEnvText).not.toContain('HAPPIER_PUBLIC_SERVER_URL_INFERRED=');

      await writeFile(join(defaults.configDir, 'server.env'), `${await readFileText(join(defaults.configDir, 'server.env'))}HAPPIER_PUBLIC_SERVER_URL=https://home.example.test\n`, 'utf8');
      process.env.HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED = '0';
      await install();

      const envText = await readFileText(join(defaults.configDir, 'server.env'));
      expect(envText.match(/^AUTH_ANONYMOUS_SIGNUP_ENABLED=0$/gmu)).toHaveLength(1);
      expect(envText.match(/^HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED=1$/gmu)).toHaveLength(1);
      expect(envText).toContain(`HAPPIER_CANONICAL_SERVER_URL=${canonicalServerUrl}`);
      expect(envText).toContain('HAPPIER_PUBLIC_SERVER_URL=https://home.example.test');
      expect(envText).not.toContain('AUTH_ANONYMOUS_SIGNUP_ENABLED=1');
      expect(envText).not.toContain('HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED=0');
      expect(envText.match(/^HAPPIER_IROH_RELAY_POLICY=automatic$/gmu)).toHaveLength(1);
      expect(envText.match(/^HAPPIER_IROH_RELAY_URLS=https:\/\/relay-a\.example\.test,https:\/\/relay-b\.example\.test$/gmu)).toHaveLength(1);

      await install({ ...personalHomeEnv, HAPPIER_IROH_RELAY_POLICY: 'automatic' });
      const automaticEnvText = await readFileText(join(defaults.configDir, 'server.env'));
      expect(automaticEnvText).not.toContain('HAPPIER_IROH_RELAY_URLS=');
      await install({
        ...personalHomeEnv,
        HAPPIER_IROH_RELAY_POLICY: 'automatic',
        HAPPIER_IROH_RELAY_URLS: 'https://relay.example.test',
      });
      await install({ ...personalHomeEnv, HAPPIER_IROH_RELAY_POLICY: 'disabled' });
      const directEnvText = await readFileText(join(defaults.configDir, 'server.env'));
      expect(directEnvText.match(/^HAPPIER_IROH_RELAY_POLICY=disabled$/gmu)).toHaveLength(1);
      expect(directEnvText).not.toContain('HAPPIER_IROH_RELAY_URLS=');
    } finally {
      if (previousApproval === undefined) delete process.env.HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED;
      else process.env.HAPPIER_HOME_DEVICE_APPROVAL_REQUIRED = previousApproval;
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('does not reopen a previously closed Personal Home when an update omits the signup field', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-personal-home-omitted-signup-'));
    try {
      const canonicalServerUrl = 'http://127.0.0.1:43123';
      const payloadRoot = join(homeDir, 'payload');
      await mkdir(payloadRoot, { recursive: true });
      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\n', 'utf8');
      await writePersonalHomeServerArtifactCapability(payloadRoot);
      const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'preview', homeDir });
      await mkdir(defaults.configDir, { recursive: true });
      await writeFile(join(defaults.configDir, 'server.env'), [
        'PORT=43123',
        'AUTH_ANONYMOUS_SIGNUP_ENABLED=0',
        '',
      ].join('\n'), 'utf8');

      await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        homeDir,
        purpose: { kind: 'personal-home', canonicalServerUrl },
        assertPersonalHomeStopped: async () => undefined,
        env: { PORT: '43123' },
        runServiceCommands: false,
        skipHealthCheck: true,
      });

      const envText = await readFileText(join(defaults.configDir, 'server.env'));
      expect(envText).toContain('AUTH_ANONYMOUS_SIGNUP_ENABLED=0');
      expect(envText.match(/^AUTH_ANONYMOUS_SIGNUP_ENABLED=0$/gmu)).toHaveLength(1);
      expect(envText).not.toContain('AUTH_ANONYMOUS_SIGNUP_ENABLED=1');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('persists the Personal Home purpose as runtime-owner metadata for interrupted-bootstrap recovery', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-personal-home-purpose-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      await mkdir(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init'), { recursive: true });
      await writeFile(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init', 'migration.sql'), '-- init\n', 'utf8');
      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');
      await writePersonalHomeServerArtifactCapability(payloadRoot);

      await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
        assertPersonalHomeStopped: async () => undefined,
        env: { PORT: '43123' },
        runServiceCommands: false,
        skipHealthCheck: true,
      });

      const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'preview', homeDir });
      const state = JSON.parse(await readFileText(join(defaults.installRoot, 'self-host-state.json'))) as Record<string, unknown>;
      const envText = await readFileText(join(defaults.configDir, 'server.env'));
      expect(state.purpose).toEqual({
        kind: 'personal-home',
        canonicalServerUrl: 'http://127.0.0.1:43123',
      });
      expect(envText).toContain('HAPPIER_MANAGED_RELAY_PURPOSE=personal-home');
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  // The CLI shows a live step around the install, and the daemon serves other requests meanwhile:
  // the migration must not block the event loop or write over the caller's terminal.
  it('runs the database migration without blocking', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      await mkdir(join(payloadRoot, 'prisma', 'sqlite', 'migrations'), { recursive: true });
      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(
        serverBinaryPath,
        '#!/bin/sh\nif [ "$1" = "--migrate-only" ]; then echo "applied 20200101000000_init"; echo "migration note" >&2; sleep 1; fi\n',
        'utf8',
      );
      await chmod(serverBinaryPath, 0o755);

      let longestStall = 0;
      let lastTick = Date.now();
      const ticker = setInterval(() => {
        const now = Date.now();
        longestStall = Math.max(longestStall, now - lastTick);
        lastTick = now;
      }, 20);
      try {
        await installOrUpdateRelayRuntimeLocal({
          serverBinaryPath,
          channel: 'preview',
          mode: 'user',
          platform: 'linux',
          arch: 'arm64',
          homeDir,
          env: { HAPPIER_SQLITE_AUTO_MIGRATE: '0' },
          runServiceCommands: false,
          skipHealthCheck: true,
        });
      } finally {
        clearInterval(ticker);
      }

      expect(longestStall).toBeLessThan(500);
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('reports what the database migration printed when it fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      await mkdir(join(payloadRoot, 'prisma', 'sqlite', 'migrations'), { recursive: true });
      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(
        serverBinaryPath,
        '#!/bin/sh\nif [ "$1" = "--migrate-only" ]; then echo "database is locked" >&2; exit 3; fi\n',
        'utf8',
      );
      await chmod(serverBinaryPath, 0o755);

      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        env: { HAPPIER_SQLITE_AUTO_MIGRATE: '0' },
        runServiceCommands: false,
        skipHealthCheck: true,
      })).rejects.toThrow(/database migration[\s\S]*exited with status 3[\s\S]*database is locked/);
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

  it('rejects a persisted PORT that collides with a sibling instead of silently moving the Home', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-persisted-port-collision-'));
    try {
      const stableDefaults = resolveRelayRuntimeDefaults({
        platform: 'linux',
        mode: 'user',
        channel: 'stable',
        homeDir,
      });
      await mkdir(stableDefaults.configDir, { recursive: true });
      await writeFile(join(stableDefaults.configDir, 'server.env'), 'PORT=3005\nHAPPIER_SERVER_HOST=127.0.0.1\n', 'utf8');

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

      await expect(installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        runServiceCommands: false,
        skipHealthCheck: true,
      })).rejects.toThrow(/Persisted relay PORT=3005 collides/i);

      await expect(readFileText(join(previewDefaults.configDir, 'server.env')))
        .resolves.toContain('PORT=3005');
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
      await writeFile(join(prismaClientDir, 'query_compiler_fast_bg.wasm-base64.js'), 'compiler\n', 'utf8');
      await writeFile(join(generatedSqliteClientDir, 'query_compiler_fast_bg.wasm-base64.js'), 'generated-compiler\n', 'utf8');

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
      const installedPrismaClientPath = join(defaults.installRoot, 'bin', 'node_modules', '.prisma', 'client', 'query_compiler_fast_bg.wasm-base64.js');
      const installedGeneratedClientPath = join(defaults.installRoot, 'bin', 'generated', 'sqlite-client', 'query_compiler_fast_bg.wasm-base64.js');

      await rm(payloadRoot, { recursive: true, force: true });

      await expect(access(installedBinaryPath, constants.X_OK)).resolves.toBeUndefined();
      await expect(readFileText(installedPrismaClientPath)).resolves.toBe('compiler\n');
      await expect(readFileText(installedGeneratedClientPath)).resolves.toBe('generated-compiler\n');
      await expect(lstat(installedBinaryPath)).resolves.toSatisfy((stats) => stats.isSymbolicLink() === false);
      const envText = await readFileText(envPath);
      expect(envText).toContain('HAPPIER_SQLITE_AUTO_MIGRATE=1');
      expect(envText).toContain(`NODE_PATH=${join(defaults.installRoot, 'bin', 'node_modules')}`);
      expect(envText).not.toMatch(/^PRISMA_/m);
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

  it('locks and stops an owned Personal Home root before migrating it to the canonical preview root', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-personal-home-owned-root-'));
    try {
      const payloadRoot = join(homeDir, 'payload');
      await mkdir(payloadRoot, { recursive: true });
      const serverBinaryPath = join(payloadRoot, 'happier-server');
      await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');
      await writePersonalHomeServerArtifactCapability(payloadRoot);

      const defaults = resolveRelayRuntimeDefaults({ platform: 'linux', mode: 'user', channel: 'preview', homeDir });
      const ownedInstallRoot = join(homeDir, '.happier', 'custom-personal-home-preview-root');
      const externalDataDir = join(homeDir, 'personal-home-data');
      const unitDir = join(homeDir, '.config', 'systemd', 'user');
      await mkdir(join(ownedInstallRoot, 'config'), { recursive: true });
      await writeFile(
        join(ownedInstallRoot, 'config', 'server.env'),
        `HAPPIER_SERVER_LIGHT_DATA_DIR=${externalDataDir}\nPORT=43123\n`,
        'utf8',
      );
      await mkdir(externalDataDir, { recursive: true });
      await writeFile(join(externalDataDir, 'home-marker.txt'), 'keep-home\n', 'utf8');
      await mkdir(unitDir, { recursive: true });
      await writeFile(join(unitDir, 'happier-server-preview.service'), [
        '[Service]',
        `WorkingDirectory=${ownedInstallRoot}`,
        `ExecStart=${join(ownedInstallRoot, 'bin', 'happier-server')}`,
        '',
      ].join('\n'), 'utf8');
      let stoppedChecks = 0;

      await installOrUpdateRelayRuntimeLocal({
        serverBinaryPath,
        channel: 'preview',
        mode: 'user',
        platform: 'linux',
        arch: 'arm64',
        homeDir,
        purpose: { kind: 'personal-home', canonicalServerUrl: 'http://127.0.0.1:43123' },
        assertPersonalHomeStopped: async () => {
          stoppedChecks += 1;
          if (stoppedChecks === 1) {
            expect(existsSync(ownedInstallRoot)).toBe(true);
            expect(existsSync(defaults.installRoot)).toBe(false);
          }
        },
        env: { PORT: '43123', AUTH_ANONYMOUS_SIGNUP_ENABLED: '0' },
        runServiceCommands: false,
        skipHealthCheck: true,
      });

      expect(stoppedChecks).toBe(2);
      await expect(readFileText(join(externalDataDir, 'home-marker.txt'))).resolves.toContain('keep-home');
      expect(existsSync(join(externalDataDir, '.operations', 'lock'))).toBe(false);
      await expect(lstat(ownedInstallRoot)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('installs sibling ui-web assets when the provided Windows server binary lives under bin/', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    const priorExecPath = process.execPath;
    try {
      process.execPath = join(homeDir, 'hstack.exe');
      await writeFile(join(homeDir, 'happier-service-launcher.exe'), createWindowsServiceLauncherPeFixture());
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
      process.execPath = priorExecPath;
      await rm(homeDir, { recursive: true, force: true });
    }
  });

  it('normalizes root-level Windows server payloads into the installRoot bin layout without dropping sidecars', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'happier-cli-common-relay-runtime-'));
    const priorExecPath = process.execPath;
    try {
      process.execPath = join(homeDir, 'hstack.exe');
      await writeFile(join(homeDir, 'happier-service-launcher.exe'), createWindowsServiceLauncherPeFixture());
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
        'bin',
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
      process.execPath = priorExecPath;
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
