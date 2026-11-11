import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { describe, expect, it } from 'vitest';

import { withTempDir } from '@/testkit/fs/tempDir';

import { readInstalledDaemonServiceBundleId, readInstalledDaemonServiceManagedBy } from './discoverInstalledDaemonServiceEntries';
import { installDaemonService, previewDaemonServiceInstall } from './installer';
import { parseDaemonServiceBundleId, planDaemonServiceInstall } from './plan';

/**
 * A service the desktop app created carries `HAPPIER_DAEMON_SERVICE_MANAGED_BY=desktop` in its own
 * definition, so the inventory can tell it from a service the user installed by hand (which the
 * app must leave alone). The marker survives every rewrite of that definition.
 */

const platforms = ['linux', 'darwin', 'win32'] as const;

function planPinned(params: Readonly<{ platform: (typeof platforms)[number]; homeDir: string; managedBy?: 'desktop' | null; bundleId?: string | null }>) {
  return planDaemonServiceInstall({
    platform: params.platform,
    channel: 'stable',
    targetMode: 'pinned',
    managedBy: params.managedBy ?? null,
    bundleId: params.bundleId ?? null,
    instanceId: 'company',
    activeServerId: 'company',
    uid: 501,
    userHomeDir: params.homeDir,
    happierHomeDir: `${params.homeDir}/.happier`,
    serverUrl: 'https://company.example.test',
    webappUrl: 'https://company.example.test',
    publicServerUrl: 'https://company.example.test',
    nodePath: '/usr/local/bin/happier',
    entryPath: '',
  });
}

function writePlanFile(plan: ReturnType<typeof planDaemonServiceInstall>): string {
  const file = plan.files[0]!;
  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(file.path, file.content, 'utf-8');
  return file.path;
}

describe('daemon service management marker', () => {
  it('records actual Desktop creation and shared consumers independently from attribution, then relinquishes on terminal install', async () => {
    await withTempDir('happier-desktop-service-ownership-', async (homeDir) => {
      const options = {
        platform: 'linux' as const, mode: 'user' as const, uid: 501,
        channel: 'stable' as const, targetMode: 'pinned' as const,
        instanceId: 'company', activeServerId: 'company',
        userHomeDir: homeDir, happierHomeDir: `${homeDir}/.happier`,
        serverUrl: 'https://company.example.test', webappUrl: 'https://company.example.test',
        publicServerUrl: 'https://company.example.test', nodePath: '/usr/local/bin/happier', entryPath: '',
        runCommands: false,
      };
      const definitionPath = planPinned({ platform: 'linux', homeDir }).files[0]!.path;
      const ownershipPath = `${definitionPath}.desktop-ownership.json`;
      await installDaemonService({ ...options, desktopBundleId: 'dev.happier.desktop' });
      expect(JSON.parse(readFileSync(ownershipPath, 'utf8'))).toMatchObject({
        version: 1, createdByDesktop: true, consumers: ['dev.happier.desktop'],
      });
      await installDaemonService({ ...options, desktopBundleId: 'dev.happier.desktop.preview' });
      expect(JSON.parse(readFileSync(ownershipPath, 'utf8')).consumers).toEqual([
        'dev.happier.desktop', 'dev.happier.desktop.preview',
      ]);
      await installDaemonService(options);
      expect(existsSync(ownershipPath)).toBe(false);
      expect(existsSync(definitionPath)).toBe(true);
    });
  });
  for (const platform of platforms) {
    it(`persists the desktop marker in a ${platform} definition and reads it back; no marker reads as user-owned`, async () => {
      await withTempDir(`happier-managed-by-${platform}-`, async (homeDir) => {
        const marked = writePlanFile(planPinned({ platform, homeDir, managedBy: 'desktop' }));
        expect(readInstalledDaemonServiceManagedBy({ platform, path: marked })).toBe('desktop');

        const unmarked = writePlanFile(planPinned({ platform, homeDir, managedBy: null }));
        expect(unmarked).toBe(marked);
        expect(readInstalledDaemonServiceManagedBy({ platform, path: unmarked })).toBeNull();
      });
    });
  }

  it('keeps the marker when the service is reinstalled without asking for it', async () => {
    await withTempDir('happier-managed-by-reinstall-', async (homeDir) => {
      writePlanFile(planPinned({ platform: 'linux', homeDir, managedBy: 'desktop' }));

      const preview = await previewDaemonServiceInstall({
        platform: 'linux',
        mode: 'user',
        uid: 501,
        channel: 'stable',
        targetMode: 'pinned',
        instanceId: 'company',
        activeServerId: 'company',
        userHomeDir: homeDir,
        happierHomeDir: `${homeDir}/.happier`,
        serverUrl: 'https://company.example.test',
        webappUrl: 'https://company.example.test',
        publicServerUrl: 'https://company.example.test',
        nodePath: '/usr/local/bin/happier',
        entryPath: '',
      });

      expect(preview.plan.files[0]?.content).toContain('Environment=HAPPIER_DAEMON_SERVICE_MANAGED_BY=desktop');
      expect(preview.exactTargetMatchesExpectedDefinition).toBe(true);
    });
  });

  /**
   * R16 — macOS System Settings › Login Items attributes a LaunchAgent to the app named by its
   * `AssociatedBundleIdentifiers`. Only a service the desktop manages names the desktop app.
   */
  describe('the desktop app bundle a managed service belongs to', () => {
    it('names the desktop app in a darwin definition the desktop installed and records it for rewrites', async () => {
      await withTempDir('happier-bundle-id-', async (homeDir) => {
        const plan = planPinned({ platform: 'darwin', homeDir, managedBy: 'desktop', bundleId: 'dev.happier.app' });
        const content = plan.files[0]!.content;
        expect(content).toContain('<key>AssociatedBundleIdentifiers</key>\n    <array>\n      <string>dev.happier.app</string>\n    </array>');
        expect(readInstalledDaemonServiceBundleId({ platform: 'darwin', path: writePlanFile(plan) })).toBe('dev.happier.app');
      });
    });

    it('attributes a desktop default-following install too, and a terminal install (no bundle id) not at all', async () => {
      await withTempDir('happier-bundle-id-default-', async (homeDir) => {
        const plan = (bundleId: string | null) => planDaemonServiceInstall({
          platform: 'darwin',
          channel: 'stable',
          targetMode: 'default-following',
          managedBy: null,
          bundleId,
          instanceId: 'default',
          uid: 501,
          userHomeDir: homeDir,
          happierHomeDir: `${homeDir}/.happier`,
          serverUrl: 'https://cloud.example.test',
          webappUrl: 'https://cloud.example.test',
          publicServerUrl: 'https://cloud.example.test',
          nodePath: '/usr/local/bin/happier',
          entryPath: '',
        });
        const desktop = plan('dev.happier.app');
        expect(desktop.files[0]!.content).toContain('<key>AssociatedBundleIdentifiers</key>');
        expect(readInstalledDaemonServiceBundleId({ platform: 'darwin', path: writePlanFile(desktop) })).toBe('dev.happier.app');
        // The lifecycle marker is untouched: attribution does not make a service the desktop's.
        expect(desktop.files[0]!.content).not.toContain('HAPPIER_DAEMON_SERVICE_MANAGED_BY');

        const terminal = plan(null);
        expect(terminal.files[0]!.content).not.toContain('AssociatedBundleIdentifiers');
      });
    });

    it('keeps the bundle id when the managed service is reinstalled without asking for it', async () => {
      await withTempDir('happier-bundle-id-reinstall-', async (homeDir) => {
        writePlanFile(planPinned({ platform: 'darwin', homeDir, managedBy: 'desktop', bundleId: 'dev.happier.app.preview' }));
        const preview = await previewDaemonServiceInstall({
          platform: 'darwin',
          mode: 'user',
          uid: 501,
          channel: 'stable',
          targetMode: 'pinned',
          instanceId: 'company',
          activeServerId: 'company',
          userHomeDir: homeDir,
          happierHomeDir: `${homeDir}/.happier`,
          serverUrl: 'https://company.example.test',
          webappUrl: 'https://company.example.test',
          publicServerUrl: 'https://company.example.test',
          nodePath: '/usr/local/bin/happier',
          entryPath: '',
        });
        expect(preview.plan.files[0]?.content).toContain('<string>dev.happier.app.preview</string>');
        expect(preview.exactTargetMatchesExpectedDefinition).toBe(true);
      });
    });

    it('rejects a bundle id that is not reverse-DNS', () => {
      expect(() => parseDaemonServiceBundleId('dev.happier.app')).not.toThrow();
      expect(parseDaemonServiceBundleId('')).toBeNull();
      expect(() => parseDaemonServiceBundleId('not a bundle</string>')).toThrow();
    });
  });
});
