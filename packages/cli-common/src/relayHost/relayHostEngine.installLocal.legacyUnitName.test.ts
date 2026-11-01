import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderWindowsScheduledTaskWrapperPs1 } from '../service/windows.js';

describe('RelayHostEngine (installOrUpdate local legacy unit name)', () => {
  it('migrates the legacy unsuffixed unit to the suffixed unit when the suffixed unit is missing', async () => {
    const originalPlatform = process.platform;

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-relay-host-legacy-unit-'));
    const payloadRoot = join(homeDir, 'payload');
    await mkdir(payloadRoot, { recursive: true });
    await mkdir(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init'), { recursive: true });
    await writeFile(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init', 'migration.sql'), '-- init\n', 'utf8');

    const serverBinaryPath = join(payloadRoot, 'happier-server');
    await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');

    Object.defineProperty(process, 'platform', { value: 'linux' });

    try {
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => homeDir,
        };
      });

      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'systemctl' && Array.isArray(args) && args.includes('show')) {
              const unit = String(args.find((value) => value.endsWith('.service')) ?? '');
              if (unit === 'happier-server-preview.service') {
                return {
                  status: 0,
                  stdout: 'LoadState=not-found\nUnitFileState=\nActiveState=inactive\nSubState=dead\n',
                  stderr: '',
                };
              }
              if (unit === 'happier-server.service') {
                return {
                  status: 0,
                  stdout: 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=enabled\n',
                  stderr: '',
                };
              }
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      const installRoot = join(homeDir, '.happier', 'self-host-preview');
      const unitDir = join(homeDir, '.config', 'systemd', 'user');
      await mkdir(unitDir, { recursive: true });
      await writeFile(
        join(unitDir, 'happier-server.service'),
        `[Service]\nWorkingDirectory=${installRoot}\nEnvironment=PORT=3005\n`,
        'utf8',
      );

      const { createRelayHostEngine } = await import('./relayHostEngine.js');

      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'preview-1' }),
        localInstallPolicy: {
          runServiceCommands: false,
          skipHealthCheck: true,
        },
      });

      await expect(engine.installOrUpdate({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        selfHostRelayBinaryOverride: serverBinaryPath,
      })).resolves.toEqual({
        relayUrl: expect.stringContaining('http://'),
        mode: 'user',
      });

      await expect(access(join(homeDir, '.config', 'systemd', 'user', 'happier-server.service'))).rejects.toBeDefined();
      await expect(access(join(homeDir, '.config', 'systemd', 'user', 'happier-server-preview.service'))).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      vi.resetModules();
      vi.clearAllMocks();
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('removes the legacy unsuffixed unit when both legacy and suffixed units exist for the same install root', async () => {
    const originalPlatform = process.platform;

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-relay-host-legacy-unit-dupe-'));
    const payloadRoot = join(homeDir, 'payload');
    await mkdir(payloadRoot, { recursive: true });
    await mkdir(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init'), { recursive: true });
    await writeFile(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init', 'migration.sql'), '-- init\n', 'utf8');

    const serverBinaryPath = join(payloadRoot, 'happier-server');
    await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');

    Object.defineProperty(process, 'platform', { value: 'linux' });

    try {
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => homeDir,
        };
      });

      const installRoot = join(homeDir, '.happier', 'self-host-preview');
      const unitDir = join(homeDir, '.config', 'systemd', 'user');
      await mkdir(unitDir, { recursive: true });
      await writeFile(
        join(unitDir, 'happier-server-preview.service'),
        `[Service]\nWorkingDirectory=${installRoot}\nEnvironment=PORT=3005\n`,
        'utf8',
      );
      await writeFile(
        join(unitDir, 'happier-server.service'),
        `[Service]\nWorkingDirectory=${installRoot}\nEnvironment=PORT=3005\n`,
        'utf8',
      );

      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'systemctl' && Array.isArray(args) && args.includes('show')) {
              const unit = String(args.find((value) => value.endsWith('.service')) ?? '');
              if (unit === 'happier-server-preview.service') {
                return {
                  status: 0,
                  stdout: 'LoadState=loaded\nUnitFileState=enabled\nActiveState=active\nSubState=running\n',
                  stderr: '',
                };
              }
              if (unit === 'happier-server.service') {
                return {
                  status: 0,
                  stdout: 'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n',
                  stderr: '',
                };
              }
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      const { createRelayHostEngine } = await import('./relayHostEngine.js');

      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'preview-1' }),
        localInstallPolicy: {
          runServiceCommands: false,
          skipHealthCheck: true,
        },
      });

      await expect(engine.installOrUpdate({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        selfHostRelayBinaryOverride: serverBinaryPath,
      })).resolves.toEqual({
        relayUrl: expect.stringContaining('http://'),
        mode: 'user',
      });

      await expect(access(join(unitDir, 'happier-server.service'))).rejects.toBeDefined();
      await expect(access(join(unitDir, 'happier-server-preview.service'))).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      vi.resetModules();
      vi.clearAllMocks();
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('migrates the legacy unsuffixed launchd plist to the suffixed plist on macOS', async () => {
    const originalPlatform = process.platform;

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-relay-host-legacy-launchd-'));
    const payloadRoot = join(homeDir, 'payload');
    await mkdir(payloadRoot, { recursive: true });
    await mkdir(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init'), { recursive: true });
    await writeFile(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init', 'migration.sql'), '-- init\n', 'utf8');

    const serverBinaryPath = join(payloadRoot, 'happier-server');
    await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');

    Object.defineProperty(process, 'platform', { value: 'darwin' });

    try {
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => homeDir,
        };
      });

      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'launchctl' && Array.isArray(args) && args[0] === 'list') {
              const label = String(args[1] ?? '');
              if (label === 'happier-server') {
                return { status: 0, stdout: '', stderr: '' };
              }
              return { status: 1, stdout: '', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      const installRoot = join(homeDir, '.happier', 'self-host-preview');
      const launchAgentsDir = join(homeDir, 'Library', 'LaunchAgents');
      await mkdir(launchAgentsDir, { recursive: true });
      await writeFile(
        join(launchAgentsDir, 'happier-server.plist'),
        `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>happier-server</string>
    <key>WorkingDirectory</key>
    <string>${installRoot}</string>
  </dict>
</plist>
`,
        'utf8',
      );

      const { createRelayHostEngine } = await import('./relayHostEngine.js');

      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'darwin', arch: 'arm64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'preview-1' }),
        localInstallPolicy: {
          runServiceCommands: false,
          skipHealthCheck: true,
        },
      });

      await expect(engine.installOrUpdate({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        selfHostRelayBinaryOverride: serverBinaryPath,
      })).resolves.toEqual({
        relayUrl: expect.stringContaining('http://'),
        mode: 'user',
      });

      await expect(access(join(launchAgentsDir, 'happier-server.plist'))).rejects.toBeDefined();
      await expect(access(join(launchAgentsDir, 'happier-server-preview.plist'))).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      vi.resetModules();
      vi.clearAllMocks();
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('ignores and removes the legacy unsuffixed Windows wrapper when it is owned by the preview install root', async () => {
    const originalPlatform = process.platform;

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-relay-host-legacy-windows-$HOME-'));
    const payloadRoot = join(homeDir, 'payload');
    await mkdir(payloadRoot, { recursive: true });
    await mkdir(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init'), { recursive: true });
    await writeFile(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init', 'migration.sql'), '-- init\n', 'utf8');

    const serverBinaryPath = join(payloadRoot, 'happier-server.exe');
    await writeFile(serverBinaryPath, 'stub exe\n', 'utf8');

    Object.defineProperty(process, 'platform', { value: 'win32' });

    try {
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => homeDir,
        };
      });

      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'powershell.exe' && Array.isArray(args) && args.includes('-Command')) {
              const commandText = String(args[args.indexOf('-Command') + 1] ?? '');
              const taskNameMatch = commandText.match(/\$taskName = "([^"]+)"/u);
              const taskName = taskNameMatch?.[1] ?? '';
              if (taskName === 'happier-server-preview') {
                return {
                  status: 0,
                  stdout: '{"exists":false,"enabled":false,"active":false,"stateLabel":"not_installed"}\n',
                  stderr: '',
                };
              }
              if (taskName === 'happier-server') {
                return {
                  status: 0,
                  stdout: '{"exists":true,"enabled":true,"active":false,"stateLabel":"Ready"}\n',
                  stderr: '',
                };
              }
            }
            if (cmd === 'schtasks') {
              return { status: 0, stdout: '', stderr: '' };
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      // The packaged Windows service launcher is a release-built native asset that clean checkouts
      // and non-Windows runners do not have; this Windows-target install stages a minimal launcher PE.
      const launcherFixturePath = join(homeDir, 'launcher-fixture', 'happier-service-launcher.exe');
      const launcherBytes = Buffer.alloc(512);
      launcherBytes.writeUInt16LE(0x5a4d, 0);
      launcherBytes.writeUInt32LE(0x80, 0x3c);
      launcherBytes.writeUInt32LE(0x00004550, 0x80);
      launcherBytes.writeUInt16LE(0x8664, 0x84);
      launcherBytes.writeUInt16LE(0x20b, 0x98);
      launcherBytes.writeUInt16LE(2, 0x98 + 68);
      launcherBytes.write('HAPPIER_SERVICE_LAUNCHER_V1', 0x120, 'ascii');
      await mkdir(join(homeDir, 'launcher-fixture'), { recursive: true });
      await writeFile(launcherFixturePath, launcherBytes);
      vi.doMock('../service/windowsLauncher.js', async () => {
        const actual = await vi.importActual<typeof import('../service/windowsLauncher.js')>('../service/windowsLauncher.js');
        return {
          ...actual,
          resolvePackagedWindowsServiceLauncherInstallSpec: () =>
            actual.resolveWindowsServiceLauncherInstallSpec(launcherFixturePath),
        };
      });

      const previewInstallRoot = `${homeDir}\\.happier\\self-host-preview`;
      const legacyWrapperPath = `${homeDir}\\.happier\\services\\happier-server.ps1`;
      await mkdir(join(homeDir, '.happier', 'services'), { recursive: true });
      await writeFile(
        legacyWrapperPath,
        renderWindowsScheduledTaskWrapperPs1({ workingDirectory: previewInstallRoot }),
        'utf8',
      );

      const { createRelayHostEngine } = await import('./relayHostEngine.js');

      const engine = createRelayHostEngine({
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'preview-1' }),
        localInstallPolicy: {
          runServiceCommands: false,
          skipHealthCheck: true,
        },
      });

      await expect(engine.installOrUpdate({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        selfHostRelayBinaryOverride: serverBinaryPath,
      })).resolves.toEqual({
        relayUrl: expect.stringContaining('http://'),
        mode: 'user',
      });

      await expect(access(legacyWrapperPath)).rejects.toBeDefined();
      await expect(access(`${homeDir}\\.happier\\services\\happier-server-preview.ps1`)).resolves.toBeUndefined();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      vi.resetModules();
      vi.clearAllMocks();
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('migrates an owned custom legacy root into the canonical preview install root', async () => {
    const originalPlatform = process.platform;

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-relay-host-custom-root-'));
    const payloadRoot = join(homeDir, 'payload');
    await mkdir(payloadRoot, { recursive: true });
    await mkdir(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init'), { recursive: true });
    await writeFile(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init', 'migration.sql'), '-- init\n', 'utf8');

    const serverBinaryPath = join(payloadRoot, 'happier-server');
    await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');

    Object.defineProperty(process, 'platform', { value: 'linux' });

    try {
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => homeDir,
        };
      });

      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'systemctl' && Array.isArray(args) && args.includes('show')) {
              const unit = String(args.find((value) => String(value).endsWith('.service')) ?? '');
              if (unit === 'happier-server-preview.service') {
                return { status: 0, stdout: 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=\n', stderr: '' };
              }
              if (unit === 'happier-server.service') {
                return { status: 0, stdout: 'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n', stderr: '' };
              }
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      const legacyInstallRoot = join(homeDir, '.happier', 'l1');
      const previewInstallRoot = join(homeDir, '.happier', 'self-host-preview');
      const unitDir = join(homeDir, '.config', 'systemd', 'user');
      await mkdir(legacyInstallRoot, { recursive: true });
      await mkdir(join(legacyInstallRoot, 'data'), { recursive: true });
      await mkdir(unitDir, { recursive: true });
      await writeFile(join(legacyInstallRoot, 'data', 'session-marker.txt'), 'session-data\n', 'utf8');
      await writeFile(
        join(legacyInstallRoot, 'self-host-state.json'),
        JSON.stringify({ channel: 'preview', mode: 'user', version: '0.1.2' }) + '\n',
        'utf8',
      );
      await writeFile(
        join(unitDir, 'happier-server.service'),
        [
          '[Unit]',
          'Description=Happier Relay Runtime',
          '[Service]',
          `WorkingDirectory=${legacyInstallRoot}`,
          'Environment=PORT=3005',
          'Environment=HAPPIER_SERVER_HOST=127.0.0.1',
          `ExecStart=${legacyInstallRoot}/bin/happier-server`,
          '',
        ].join('\n'),
        'utf8',
      );

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        localInstallPolicy: {
          runServiceCommands: false,
          skipHealthCheck: true,
        },
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'preview-1' }),
      });

      await expect(engine.installOrUpdate({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        selfHostRelayBinaryOverride: serverBinaryPath,
      })).resolves.toBeDefined();

      expect(existsSync(join(previewInstallRoot, 'data', 'session-marker.txt'))).toBe(true);
      expect(existsSync(join(legacyInstallRoot, 'data', 'session-marker.txt'))).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      vi.resetModules();
      vi.clearAllMocks();
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('migrates an owned custom suffixed preview unit root into the canonical preview install root', async () => {
    const originalPlatform = process.platform;

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-relay-host-custom-suffixed-root-'));
    const payloadRoot = join(homeDir, 'payload');
    await mkdir(payloadRoot, { recursive: true });
    await mkdir(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init'), { recursive: true });
    await writeFile(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init', 'migration.sql'), '-- init\n', 'utf8');

    const serverBinaryPath = join(payloadRoot, 'happier-server');
    await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');

    Object.defineProperty(process, 'platform', { value: 'linux' });

    try {
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => homeDir,
        };
      });

      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'systemctl' && Array.isArray(args) && args.includes('show')) {
              const unit = String(args.find((value) => value.endsWith('.service')) ?? '');
              if (unit === 'happier-server-preview.service') {
                return {
                  status: 0,
                  stdout: 'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n',
                  stderr: '',
                };
              }
              if (unit === 'happier-server.service') {
                return {
                  status: 0,
                  stdout: 'LoadState=not-found\nActiveState=inactive\nSubState=dead\nUnitFileState=\n',
                  stderr: '',
                };
              }
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      const customInstallRoot = join(homeDir, '.happier', 'l1');
      const previewInstallRoot = join(homeDir, '.happier', 'self-host-preview');
      const unitDir = join(homeDir, '.config', 'systemd', 'user');
      await mkdir(customInstallRoot, { recursive: true });
      await mkdir(join(customInstallRoot, 'data'), { recursive: true });
      await mkdir(unitDir, { recursive: true });
      await writeFile(join(customInstallRoot, 'data', 'session-marker.txt'), 'session-data\n', 'utf8');
      await writeFile(
        join(customInstallRoot, 'self-host-state.json'),
        JSON.stringify({ channel: 'preview', mode: 'user', version: '0.1.2' }) + '\n',
        'utf8',
      );
      await writeFile(
        join(unitDir, 'happier-server-preview.service'),
        [
          '[Unit]',
          'Description=Happier Relay Runtime (happier-server-preview)',
          '[Service]',
          `WorkingDirectory=${customInstallRoot}`,
          'Environment=PORT=3005',
          'Environment=HAPPIER_SERVER_HOST=127.0.0.1',
          'Environment=HAPPIER_PUBLIC_SERVER_URL=http://127.0.0.1:43215',
          `ExecStart=${customInstallRoot}/bin/happier-server`,
          '',
        ].join('\n'),
        'utf8',
      );

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        localInstallPolicy: {
          runServiceCommands: false,
          skipHealthCheck: true,
        },
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'preview-1' }),
      });

      await expect(engine.installOrUpdate({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        selfHostRelayBinaryOverride: serverBinaryPath,
      })).resolves.toBeDefined();

      expect(existsSync(join(previewInstallRoot, 'data', 'session-marker.txt'))).toBe(true);
      expect(existsSync(join(customInstallRoot, 'data', 'session-marker.txt'))).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      vi.resetModules();
      vi.clearAllMocks();
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('fails closed when a legacy preview root with a different data secret remains beside the canonical preview root', async () => {
    const originalPlatform = process.platform;

    const homeDir = await mkdtemp(join(tmpdir(), 'happier-relay-host-stranded-legacy-root-'));
    const payloadRoot = join(homeDir, 'payload');
    await mkdir(payloadRoot, { recursive: true });
    await mkdir(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init'), { recursive: true });
    await writeFile(join(payloadRoot, 'prisma', 'sqlite', 'migrations', '20200101000000_init', 'migration.sql'), '-- init\n', 'utf8');

    const serverBinaryPath = join(payloadRoot, 'happier-server');
    await writeFile(serverBinaryPath, '#!/bin/sh\necho ok\n', 'utf8');

    Object.defineProperty(process, 'platform', { value: 'linux' });

    try {
      vi.doMock('node:os', async () => {
        const actual = await vi.importActual<typeof import('node:os')>('node:os');
        return {
          ...actual,
          homedir: () => homeDir,
        };
      });

      vi.doMock('node:child_process', async () => {
        const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
        return {
          ...actual,
          spawnSync: (cmd: string, args?: readonly string[]) => {
            if (cmd === 'systemctl' && Array.isArray(args) && args.includes('show')) {
              const unit = String(args.find((value) => value.endsWith('.service')) ?? '');
              if (unit === 'happier-server-preview.service') {
                return {
                  status: 0,
                  stdout: 'LoadState=loaded\nActiveState=active\nSubState=running\nUnitFileState=enabled\n',
                  stderr: '',
                };
              }
              if (unit === 'happier-server.service') {
                return {
                  status: 0,
                  stdout: 'LoadState=loaded\nActiveState=inactive\nSubState=dead\nUnitFileState=disabled\n',
                  stderr: '',
                };
              }
            }
            return { status: 0, stdout: '', stderr: '' };
          },
        };
      });

      const legacyInstallRoot = join(homeDir, '.happier', 'l1', 'self-host');
      const previewInstallRoot = join(homeDir, '.happier', 'self-host-preview');
      const unitDir = join(homeDir, '.config', 'systemd', 'user');
      await mkdir(join(legacyInstallRoot, 'data'), { recursive: true });
      await mkdir(join(previewInstallRoot, 'data'), { recursive: true });
      await mkdir(unitDir, { recursive: true });
      await writeFile(join(legacyInstallRoot, 'data', 'handy-master-secret.txt'), 'legacy-secret\n', 'utf8');
      await writeFile(join(previewInstallRoot, 'data', 'handy-master-secret.txt'), 'preview-secret\n', 'utf8');
      await writeFile(join(legacyInstallRoot, 'data', 'happier-server-light.sqlite'), 'legacy-db\n', 'utf8');
      await writeFile(join(previewInstallRoot, 'data', 'happier-server-light.sqlite'), 'preview-db\n', 'utf8');
      await writeFile(
        join(previewInstallRoot, 'self-host-state.json'),
        JSON.stringify({ channel: 'preview', mode: 'user', version: '0.2.4' }) + '\n',
        'utf8',
      );
      await writeFile(
        join(unitDir, 'happier-server.service'),
        [
          '[Unit]',
          'Description=Happier Relay Runtime',
          '[Service]',
          `WorkingDirectory=${legacyInstallRoot}`,
          'Environment=PORT=3005',
          'Environment=HAPPIER_SERVER_HOST=127.0.0.1',
          `ExecStart=${legacyInstallRoot}/bin/happier-server`,
          '',
        ].join('\n'),
        'utf8',
      );
      await writeFile(
        join(unitDir, 'happier-server-preview.service'),
        [
          '[Unit]',
          'Description=Happier Relay Runtime (happier-server-preview)',
          '[Service]',
          `WorkingDirectory=${previewInstallRoot}`,
          'Environment=PORT=3005',
          'Environment=HAPPIER_SERVER_HOST=127.0.0.1',
          `ExecStart=${previewInstallRoot}/bin/happier-server`,
          '',
        ].join('\n'),
        'utf8',
      );

      const { createRelayHostEngine } = await import('./relayHostEngine.js');
      const engine = createRelayHostEngine({
        localInstallPolicy: {
          runServiceCommands: false,
          skipHealthCheck: true,
        },
        resolveRemoteReleaseTarget: async () => ({ os: 'linux', arch: 'x64' }),
        runRemoteText: async () => ({ status: 0, stdout: '', stderr: '' }),
        copyLocalDirectoryToRemote: async () => {},
        installRemoteComponent: async () => ({ binaryPath: '$HOME/.happier/happier-server/current/happier-server', versionId: 'preview-1' }),
      });

      await expect(engine.installOrUpdate({
        target: { kind: 'local' },
        mode: 'user',
        channel: 'preview',
        selfHostRelayBinaryOverride: serverBinaryPath,
      })).rejects.toThrow(/different data secret/i);
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform });
      vi.resetModules();
      vi.clearAllMocks();
      await rm(homeDir, { recursive: true, force: true });
    }
  }, 60_000);
});
