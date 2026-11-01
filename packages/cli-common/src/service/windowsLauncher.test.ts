import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  resolveInstalledWindowsServiceLauncherPaths,
  resolvePackagedWindowsServiceLauncherInstallSpec,
  resolveWindowsServiceLauncherInstallSpec,
  validateWindowsServiceLauncherPe,
  WINDOWS_SERVICE_LAUNCHER_PROVENANCE_MARKER,
} from './windowsLauncher';

function createPeFixture(overrides: Readonly<{
  machine?: number;
  optionalMagic?: number;
  subsystem?: number;
}> = {}): Buffer {
  const bytes = Buffer.alloc(512);
  bytes.writeUInt16LE(0x5a4d, 0);
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.writeUInt32LE(0x00004550, 0x80);
  bytes.writeUInt16LE(overrides.machine ?? 0x8664, 0x84);
  bytes.writeUInt16LE(overrides.optionalMagic ?? 0x20b, 0x98);
  bytes.writeUInt16LE(overrides.subsystem ?? 2, 0x98 + 68);
  bytes.write(WINDOWS_SERVICE_LAUNCHER_PROVENANCE_MARKER, 0x120, 'ascii');
  return bytes;
}

describe('Windows service launcher asset', () => {
  it('uses a versioned task-owned path and a sibling diagnostic log', () => {
    expect(resolveInstalledWindowsServiceLauncherPaths({
      definitionPath: 'C:\\Users\\Zoë & QA\\.happier\\services\\happier-daemon.default.ps1',
      label: 'happier-daemon.default',
      version: '17',
    })).toEqual({
      launcherPath: 'C:\\Users\\Zoë & QA\\.happier\\services\\happier-daemon.default\\launcher-17\\happier-service-launcher.exe',
      diagnosticLogPath: 'C:\\Users\\Zoë & QA\\.happier\\services\\happier-daemon.default.launcher.log',
    });
  });

  it('stages different launcher builds in different version directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-launcher-version-'));
    try {
      const first = join(root, 'first.exe');
      const rebuilt = join(root, 'rebuilt.exe');
      await writeFile(first, createPeFixture());
      await writeFile(rebuilt, Buffer.concat([createPeFixture(), Buffer.from('different toolchain output')]));

      const firstSpec = resolveWindowsServiceLauncherInstallSpec(first);
      const rebuiltSpec = resolveWindowsServiceLauncherInstallSpec(rebuilt);

      expect(firstSpec.sourcePath).toBe(first);
      expect(firstSpec.version).toBe(resolveWindowsServiceLauncherInstallSpec(first).version);
      expect(rebuiltSpec.version).not.toBe(firstSpec.version);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves the packaged launcher from the installed CLI shortcut and from a direct binary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-launcher-shim-'));
    try {
      const happierHome = join(root, 'home', '.happier');
      const currentLauncher = join(happierHome, 'cli-dev', 'current', 'happier-service-launcher.exe');
      const payloadLauncher = join(root, 'payload', 'happier-service-launcher.exe');
      await mkdir(dirname(currentLauncher), { recursive: true });
      await mkdir(dirname(payloadLauncher), { recursive: true });
      await writeFile(currentLauncher, createPeFixture());
      await writeFile(payloadLauncher, createPeFixture());

      expect(resolvePackagedWindowsServiceLauncherInstallSpec({
        execPath: join(happierHome, 'bin', 'hdev.exe'),
      }).sourcePath).toBe(currentLauncher);
      expect(resolvePackagedWindowsServiceLauncherInstallSpec({
        execPath: join(root, 'payload', 'happier.exe'),
      }).sourcePath).toBe(payloadLauncher);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves the npm launcher from cli-common when the resolver runs from a bundling package', async () => {
    // The CLI build inlines this resolver into its own dist; npm installs cli-common under the
    // CLI's node_modules. Run the built resolver from that CLI dist location against that layout.
    const cliCommonRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
    const root = await mkdtemp(join(tmpdir(), 'happier-launcher-bundled-'));
    try {
      const cliRoot = join(root, 'node_modules', '@happier-dev', 'cli');
      const installedCliCommon = join(cliRoot, 'node_modules', '@happier-dev', 'cli-common');
      const launcher = join(installedCliCommon, 'native', 'windows', 'bin', 'windows-x64', 'happier-service-launcher.exe');
      await mkdir(dirname(launcher), { recursive: true });
      await mkdir(join(installedCliCommon, 'dist', 'service'), { recursive: true });
      await copyFile(join(cliCommonRoot, 'package.json'), join(installedCliCommon, 'package.json'));
      await writeFile(join(installedCliCommon, 'dist', 'service', 'index.js'), 'export {};\n');
      await writeFile(launcher, createPeFixture());
      for (const relativePath of [
        join('service', 'windowsLauncher.js'),
        join('firstPartyRuntime', 'resolveSelfContainedCliRuntimeRoot.js'),
      ]) {
        await mkdir(dirname(join(cliRoot, 'dist', relativePath)), { recursive: true });
        await copyFile(join(cliCommonRoot, 'dist', relativePath), join(cliRoot, 'dist', relativePath));
      }

      const bundled = await import(pathToFileURL(join(cliRoot, 'dist', 'service', 'windowsLauncher.js')).href) as
        typeof import('./windowsLauncher');

      expect(bundled.resolvePackagedWindowsServiceLauncherInstallSpec().sourcePath).toBe(launcher);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('accepts only an x64 PE32+ GUI executable', () => {
    expect(() => validateWindowsServiceLauncherPe(createPeFixture())).not.toThrow();
    expect(() => validateWindowsServiceLauncherPe(createPeFixture({ machine: 0x14c }))).toThrow(/x64/u);
    expect(() => validateWindowsServiceLauncherPe(createPeFixture({ optionalMagic: 0x10b }))).toThrow(/PE32\+/u);
    expect(() => validateWindowsServiceLauncherPe(createPeFixture({ subsystem: 3 }))).toThrow(/GUI subsystem/u);
    expect(() => validateWindowsServiceLauncherPe(Buffer.from(createPeFixture()).fill(0, 0x120))).toThrow(/provenance marker/u);
  });
});
