import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { renderHappierCliPathExportLine, HAPPIER_DESKTOP_PATH_MARKER_LINE } from './ensureHappierCliPathExposure.js';
import { installVersionedPayload } from './installVersionedPayload.js';
import { recordDesktopResourceUse, readDesktopResourceOwnership } from './desktopResourceOwnership.js';
import { resolveFirstPartyInstallLayout } from './installLayout.js';
import { uninstallDesktopOwnedCli, uninstallManagedFirstPartyComponent } from './uninstallManagedFirstPartyComponent.js';

async function withInstallations(test: (fixture: {
  processEnv: NodeJS.ProcessEnv;
  install: (channel: 'stable' | 'preview', bundleId?: string) => Promise<ReturnType<typeof resolveFirstPartyInstallLayout>>;
}) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), 'happier-desktop-uninstall-cli-'));
  const processEnv = { ...process.env, HOME: home, HAPPIER_HOME_DIR: home, HAPPIER_FIRST_PARTY_INSTALL_HOME: home };
  try {
    await test({ processEnv, install: async (channel, desktopBundleId) => {
      const payloadRoot = join(home, `payload-${channel}`);
      await mkdir(join(payloadRoot, 'package-dist'), { recursive: true });
      await writeFile(join(payloadRoot, process.platform === 'win32' ? 'happier.exe' : 'happier'), channel);
      await writeFile(join(payloadRoot, 'package-dist', 'index.mjs'), 'export {};');
      await installVersionedPayload({ componentId: 'happier-cli', channel, versionId: `1.0.0-${channel}`, payloadRoot, processEnv, desktopBundleId });
      return resolveFirstPartyInstallLayout({ componentId: 'happier-cli', channel, processEnv });
    } });
  } finally { await rm(home, { recursive: true, force: true }); }
}

describe('Desktop-owned CLI removal', () => {
  it('relinquishes Desktop authority after explicit component removal before later user recreation', async () => {
    await withInstallations(async ({ processEnv, install }) => {
      const stable = await install('stable', 'dev.happier.app');
      await uninstallManagedFirstPartyComponent({ componentId: 'happier-cli', channel: 'stable', processEnv });
      expect(await readDesktopResourceOwnership(stable.installRoot)).toBeNull();
      await mkdir(stable.installRoot);
      await uninstallDesktopOwnedCli({ bundleId: 'dev.happier.app', processEnv, remainingServiceLaunchers: [] });
      await access(stable.installRoot);
    });
  });

  it.skipIf(process.platform === 'win32')('cleans only its last-channel Desktop PATH exposure and retains the CLI if profile cleanup fails', async () => {
    await withInstallations(async ({ processEnv, install }) => {
      const stable = await install('stable', 'dev.happier.app');
      const preview = await install('preview', 'dev.happier.preview');
      const home = processEnv.HOME!;
      const profile = join(home, '.zprofile');
      const line = `${HAPPIER_DESKTOP_PATH_MARKER_LINE}\n${renderHappierCliPathExportLine(stable.shimDir)}\n`;
      await writeFile(profile, line);
      await uninstallDesktopOwnedCli({ bundleId: 'dev.happier.app', processEnv, remainingServiceLaunchers: [] });
      expect(await readFile(profile, 'utf8')).toBe(line);
      await mkdir(join(home, '.bashrc'));
      await expect(uninstallDesktopOwnedCli({ bundleId: 'dev.happier.preview', processEnv, remainingServiceLaunchers: [] })).rejects.toThrow();
      await access(preview.installRoot);
      expect((await readDesktopResourceOwnership(preview.installRoot))?.consumers).toEqual(['dev.happier.preview']);
      await rm(join(home, '.bashrc'), { recursive: true });
      await uninstallDesktopOwnedCli({ bundleId: 'dev.happier.preview', processEnv, remainingServiceLaunchers: [] });
      expect(await readFile(profile, 'utf8')).toBe('');
    });
  });

  it('removes exclusive channels, retains another Desktop consumer, and removes last-consumer shims', async () => {
    await withInstallations(async ({ processEnv, install }) => {
      const stable = await install('stable', 'dev.happier.app');
      const preview = await install('preview', 'dev.happier.app');
      await recordDesktopResourceUse({ resourcePath: stable.installRoot, bundleId: 'dev.happier.preview', created: false });
      await uninstallDesktopOwnedCli({ bundleId: 'dev.happier.app', processEnv, remainingServiceLaunchers: [] });
      await access(stable.installRoot);
      await expect(access(preview.installRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(join(stable.shimDir, process.platform === 'win32' ? 'happier.exe' : 'happier'), 'utf8')).toBe('stable');
      await uninstallDesktopOwnedCli({ bundleId: 'dev.happier.preview', processEnv, remainingServiceLaunchers: [] });
      await expect(access(stable.installRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(join(stable.shimDir, process.platform === 'win32' ? 'happier.exe' : 'happier'))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  it('retains a CLI needed by a user service and never removes adopted standalone channels', async () => {
    await withInstallations(async ({ processEnv, install }) => {
      const stable = await install('stable', 'dev.happier.app');
      const preview = await install('preview');
      await uninstallDesktopOwnedCli({
        bundleId: 'dev.happier.app', processEnv,
        remainingServiceLaunchers: [[join(stable.installRoot, 'current', 'happier')]],
      });
      await access(stable.installRoot);
      await access(preview.installRoot);
      expect(await readDesktopResourceOwnership(stable.installRoot)).toBeNull();
      expect(await readDesktopResourceOwnership(preview.installRoot)).toBeNull();
    });
  });
});
