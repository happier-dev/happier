import { createWindowsServiceLauncherPeFixture } from '../../../../scripts/testing/windowsServiceLauncherPeFixture.mjs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  planWindowsServiceLauncher,
  resolveInstalledWindowsServiceLauncherPaths,
  resolvePackagedWindowsServiceLauncherInstallSpec,
  resolveWindowsServiceLauncherInstallSpec,
  validateWindowsServiceLauncherPe,
} from './windowsLauncher';

describe('Windows service launcher asset', () => {
  it('plans the staged launcher and the quoted task action together', () => {
    const plan = planWindowsServiceLauncher({
      definitionPath: 'C:\\Users\\QA User\\services\\updater.ps1', label: 'updater',
      windowsLauncher: { sourcePath: 'C:\\package\\happier-service-launcher.exe', version: 'test' },
    });
    expect(plan.copy).toEqual({
      sourcePath: 'C:\\package\\happier-service-launcher.exe', destinationPath: plan.action.executable,
      validation: 'windows-service-launcher-x64-v1',
    });
    expect(plan.commandLine).toBe(`"${plan.action.executable}" ${plan.action.arguments}`);
    expect(plan.action.arguments).toContain('--wrapper "C:\\Users\\QA User\\services\\updater.ps1"');
    expect(plan.action.arguments).toContain(`--diagnostic-log "${plan.diagnosticLogPath}"`);
  });

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
      await writeFile(first, createWindowsServiceLauncherPeFixture());
      await writeFile(rebuilt, Buffer.concat([createWindowsServiceLauncherPeFixture(), Buffer.from('different toolchain output')]));

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
      await writeFile(currentLauncher, createWindowsServiceLauncherPeFixture());
      await writeFile(payloadLauncher, createWindowsServiceLauncherPeFixture());

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

  it('accepts only an x64 PE32+ GUI executable', () => {
    expect(() => validateWindowsServiceLauncherPe(createWindowsServiceLauncherPeFixture())).not.toThrow();
    expect(() => validateWindowsServiceLauncherPe(createWindowsServiceLauncherPeFixture({ machine: 0x14c }))).toThrow(/x64/u);
    expect(() => validateWindowsServiceLauncherPe(createWindowsServiceLauncherPeFixture({ optionalMagic: 0x10b }))).toThrow(/PE32\+/u);
    expect(() => validateWindowsServiceLauncherPe(createWindowsServiceLauncherPeFixture({ subsystem: 3 }))).toThrow(/GUI subsystem/u);
    expect(() => validateWindowsServiceLauncherPe(Buffer.from(createWindowsServiceLauncherPeFixture()).fill(0, 0x120))).toThrow(/provenance marker/u);
  });
});
