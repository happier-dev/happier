import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';

const { ensureJavaScriptRuntimeExecutableMock } = vi.hoisted(() => ({
  ensureJavaScriptRuntimeExecutableMock: vi.fn(async () => '/managed/node'),
}));

describe('resolveDaemonServiceListEntries', () => {
  const envScope = createEnvKeyScope([
    'HAPPIER_HOME_DIR',
    'HAPPIER_ACTIVE_SERVER_ID',
    'HAPPIER_PUBLIC_RELEASE_CHANNEL',
  ]);

  afterEach(() => {
    envScope.restore();
    vi.doUnmock('@/packagedRuntime/js/ensureJavaScriptRuntimeExecutable');
    vi.doUnmock('./discoverInstalledDaemonServiceEntries');
    ensureJavaScriptRuntimeExecutableMock.mockReset();
    ensureJavaScriptRuntimeExecutableMock.mockResolvedValue('/managed/node');
    vi.resetModules();
  });

  it('matches a default-following systemd unit installed through the managed default shim', async () => {
    await withTempDir('happier-daemon-service-list-managed-default-shim-', async (userHomeDir) => {
      const happierHomeDir = join(userHomeDir, '.happier');
      const managedBinDir = join(happierHomeDir, 'bin');
      const defaultShimPath = join(managedBinDir, 'happier');
      const previewShimPath = join(managedBinDir, 'hprev');
      mkdirSync(managedBinDir, { recursive: true });
      writeFileSync(defaultShimPath, '#!/bin/sh\n', 'utf8');
      writeFileSync(previewShimPath, '#!/bin/sh\n', 'utf8');
      writeFileSync(join(happierHomeDir, 'default-cli-release-channel.json'), '{"releaseChannel":"preview"}\n', 'utf8');

      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview',
      });
      vi.resetModules();

      const [{ planDaemonServiceInstall }, { resolveDaemonServiceListEntries }] = await Promise.all([
        import('./plan'),
        import('./cli'),
      ]);

      const runtime = {
        platform: 'linux' as const,
        channel: 'preview' as const,
        targetMode: 'default-following' as const,
        instanceId: 'cloud',
        activeServerId: 'cloud',
        uid: 1000,
        userHomeDir,
        happierHomeDir,
        serverUrl: 'https://example.test',
        webappUrl: 'https://app.example.test',
        publicServerUrl: 'https://example.test',
        nodePath: previewShimPath,
        entryPath: '',
      };

      const expectedPlan = planDaemonServiceInstall({
        platform: 'linux',
        mode: 'user',
        channel: runtime.channel,
        targetMode: 'default-following',
        instanceId: runtime.instanceId,
        userHomeDir: runtime.userHomeDir,
        happierHomeDir: runtime.happierHomeDir,
        serverUrl: runtime.serverUrl,
        webappUrl: runtime.webappUrl,
        publicServerUrl: runtime.publicServerUrl,
        nodePath: defaultShimPath,
        entryPath: '',
        uid: runtime.uid,
      });

      const expectedServicePath = expectedPlan.files[0]?.path ?? '';
      mkdirSync(dirname(expectedServicePath), { recursive: true });
      writeFileSync(expectedServicePath, expectedPlan.files[0]?.content ?? '', 'utf8');

      const entries = await resolveDaemonServiceListEntries(runtime, { mode: 'user' });
      const defaultEntry = entries.find((entry) => entry.path === expectedServicePath) ?? null;
      expect(defaultEntry).not.toBeNull();
      expect(defaultEntry?.installedDefinitionMatchesExpected).toBe(true);
    });
  });

  it('reports when the installed default-following systemd unit does not match the expected contents', async () => {
    await withTempDir('happier-daemon-service-list-definition-match-', async (userHomeDir) => {
      const happierHomeDir = join(userHomeDir, '.happier');
      mkdirSync(happierHomeDir, { recursive: true });

      envScope.patch({
        HAPPIER_HOME_DIR: happierHomeDir,
        HAPPIER_ACTIVE_SERVER_ID: 'cloud',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'stable',
      });
      vi.resetModules();

      const [{ planDaemonServiceInstall }, { resolveDaemonServiceListEntries }, { discoverInstalledDaemonServiceEntries }] = await Promise.all([
        import('./plan'),
        import('./cli'),
        import('./discoverInstalledDaemonServiceEntries'),
      ]);

      const runtime = {
        platform: 'linux' as const,
        channel: 'stable' as const,
        targetMode: 'default-following' as const,
        instanceId: 'cloud',
        activeServerId: 'cloud',
        uid: 1000,
        userHomeDir,
        happierHomeDir,
        serverUrl: 'https://example.test',
        webappUrl: 'https://app.example.test',
        publicServerUrl: 'https://example.test',
        nodePath: '/usr/bin/node',
        entryPath: '/opt/happier/index.mjs',
      };

      const expectedPlan = planDaemonServiceInstall({
        platform: 'linux',
        mode: 'user',
        channel: runtime.channel,
        targetMode: 'default-following',
        instanceId: runtime.instanceId,
        userHomeDir: runtime.userHomeDir,
        happierHomeDir: runtime.happierHomeDir,
        serverUrl: runtime.serverUrl,
        webappUrl: runtime.webappUrl,
        publicServerUrl: runtime.publicServerUrl,
        nodePath: runtime.nodePath,
        entryPath: runtime.entryPath,
        uid: runtime.uid,
      });

      const plannedFile = expectedPlan.files[0];
      expect(plannedFile).toBeTruthy();

      const expectedServicePath = plannedFile?.path ?? '';
      const expectedServiceContents = plannedFile?.content ?? '';
      expect(expectedServicePath).toMatch(/happier-daemon\.default\.service$/u);

      const installedServiceContents = expectedServiceContents
        .replaceAll(/^ManagedOOMPreference=.*\n/gmu, '');
      mkdirSync(dirname(expectedServicePath), { recursive: true });
      writeFileSync(expectedServicePath, installedServiceContents, 'utf8');

      const entries = await resolveDaemonServiceListEntries(runtime, { mode: 'user' });
      const defaultEntry = entries.find((entry) => entry.path === expectedServicePath) ?? null;
      expect(defaultEntry).not.toBeNull();
      expect(defaultEntry?.installedDefinitionMatchesExpected).toBe(false);
    });
  });

  it('does not bootstrap the managed js runtime when a Windows default-following scheduled task wrapper is missing', async () => {
    await withTempDir('happier-daemon-service-list-windows-wrapper-missing-', async (hostHomeDir) => {
      const userHomeDir = 'C:\\Users\\tester';
      const happierHomeDir = 'C:\\Users\\tester\\.happier';
      const expectedWrapperPath = 'C:\\Users\\tester\\.happier\\services\\happier-daemon.default.ps1';

      envScope.patch({
        HAPPIER_HOME_DIR: join(hostHomeDir, '.happier'),
        HAPPIER_ACTIVE_SERVER_ID: 'default',
        HAPPIER_PUBLIC_RELEASE_CHANNEL: 'preview',
      });
      vi.resetModules();
      vi.doMock('@/packagedRuntime/js/ensureJavaScriptRuntimeExecutable', () => ({
        ensureJavaScriptRuntimeExecutable: ensureJavaScriptRuntimeExecutableMock,
      }));
      vi.doMock('./discoverInstalledDaemonServiceEntries', async (importOriginal) => {
        const actual = await importOriginal<typeof import('./discoverInstalledDaemonServiceEntries')>();
        return {
          ...actual,
          discoverInstalledDaemonServiceEntries: async () => [{
            serverId: 'default',
            name: 'Default background service',
            installed: true,
            path: expectedWrapperPath,
            platform: 'win32',
            mode: 'user',
            happierHomeDir,
            releaseChannel: 'preview',
            label: 'Happier\\happier-daemon.default',
            targetMode: 'default-following',
          }],
        };
      });

      const [{ planDaemonServiceInstall }, { resolveDaemonServiceListEntries }] = await Promise.all([
        import('./plan'),
        import('./cli'),
      ]);

      const runtime = {
        platform: 'win32' as const,
        channel: 'preview' as const,
        targetMode: 'default-following' as const,
        instanceId: 'default',
        activeServerId: 'cloud',
        uid: null,
        userHomeDir,
        happierHomeDir,
        serverUrl: 'http://127.0.0.1:3005',
        webappUrl: 'http://127.0.0.1:3005',
        publicServerUrl: 'http://127.0.0.1:3005',
        nodePath: 'C:\\Program Files\\nodejs\\node.exe',
        entryPath: 'C:\\Users\\tester\\.happier\\cli-preview\\current\\package-dist\\index.mjs',
      };

      const expectedPlan = planDaemonServiceInstall({
        platform: 'win32',
        mode: 'user',
        channel: runtime.channel,
        targetMode: 'default-following',
        instanceId: runtime.instanceId,
        userHomeDir: runtime.userHomeDir,
        happierHomeDir: runtime.happierHomeDir,
        serverUrl: runtime.serverUrl,
        webappUrl: runtime.webappUrl,
        publicServerUrl: runtime.publicServerUrl,
        nodePath: runtime.nodePath,
        entryPath: runtime.entryPath,
        uid: undefined,
      });

      const expectedServicePath = expectedPlan.files[0]?.path ?? '';
      expect(expectedServicePath).toBe(expectedWrapperPath);

      const entries = await resolveDaemonServiceListEntries(runtime, { mode: 'user' });
      const defaultEntry = entries.find((entry) => entry.path === expectedServicePath) ?? null;
      expect(defaultEntry).not.toBeNull();
      expect(defaultEntry?.installedDefinitionMatchesExpected).toBe(false);
      expect(ensureJavaScriptRuntimeExecutableMock).not.toHaveBeenCalled();
    });
  });
});
