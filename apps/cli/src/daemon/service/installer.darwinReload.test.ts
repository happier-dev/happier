import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveInstalledFirstPartyComponentPaths } from '@happier-dev/cli-common/firstPartyRuntime';

import { withTempDir } from '@/testkit/fs/tempDir';
import { previewDaemonServiceInstall } from './installer';
import { planDaemonServiceInstall } from './plan';

describe('launchd install reloads a changed CLI definition', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('reloads a CLI choice change even when the existing service is running', async () => {
    await withTempDir('happier-service-launchd-reload-', async (userHomeDir) => {
      const happierHomeDir = join(userHomeDir, '.happier');
      vi.stubEnv('HAPPIER_HOME_DIR', happierHomeDir);
      const managedLauncher = resolveInstalledFirstPartyComponentPaths({
        componentId: 'happier-cli', channel: 'stable', processEnv: process.env,
      }).shimPaths[0]!;
      const options = {
        platform: 'darwin' as const, mode: 'user' as const, channel: 'stable' as const,
        targetMode: 'pinned' as const, instanceId: 'company', activeServerId: 'company',
        uid: 501, userHomeDir, happierHomeDir,
        serverUrl: 'https://company.example.test', webappUrl: 'https://company.example.test',
        publicServerUrl: 'https://company.example.test', nodePath: '/npm/happier', entryPath: '',
      };
      const installed = planDaemonServiceInstall(options).files[0]!;
      mkdirSync(dirname(installed.path), { recursive: true });
      writeFileSync(installed.path, installed.content);

      const preview = await previewDaemonServiceInstall({
        ...options, nodePath: managedLauncher, darwinInstallMode: 'kickstart',
      });
      expect(preview.exactTargetExists).toBe(true);
      expect(preview.plan.commands.some((command) => command.args[0] === 'bootstrap')).toBe(true);

      const unchanged = await previewDaemonServiceInstall({ ...options, darwinInstallMode: 'kickstart' });
      expect(unchanged.plan.commands.map((command) => command.args[0])).toEqual(['kickstart']);

      const staleRunningDaemon = await previewDaemonServiceInstall({
        ...options,
        darwinInstallMode: 'kickstart',
        restartRunningDaemon: true,
      });
      expect(staleRunningDaemon.plan.commands.some((command) => command.args[0] === 'bootstrap')).toBe(true);
    });
  });

  it('retains explicit installation inputs when reinstalling a removed service', async () => {
    await withTempDir('happier-service-layout-reinstall-', async (userHomeDir) => {
      vi.stubEnv('HAPPIER_FIRST_PARTY_INSTALL_HOME', '');
      const installHome = join(userHomeDir, 'installation');
      const binary = join(installHome, 'bin', 'happier');
      mkdirSync(dirname(binary), { recursive: true });
      writeFileSync(binary, '#!/bin/sh\nexit 0\n');
      const options = {
        platform: 'linux', mode: 'user', channel: 'stable', targetMode: 'default-following',
        userHomeDir, happierHomeDir: join(userHomeDir, 'private'),
        firstPartyInstallHome: installHome,
        nodePath: binary, entryPath: '',
      } as const;
      const preview = await previewDaemonServiceInstall(options);
      expect(preview.plan.files[0]?.content).toContain(`Environment=HAPPIER_FIRST_PARTY_INSTALL_HOME=${installHome}`);

      const installed = preview.plan.files[0]!;
      mkdirSync(dirname(installed.path), { recursive: true });
      writeFileSync(installed.path, installed.content);
      const rewritten = await previewDaemonServiceInstall({
        ...options, firstPartyInstallHome: undefined, nodePath: undefined,
      });
      expect(rewritten.plan.files[0]?.content).toContain(`Environment=HAPPIER_FIRST_PARTY_INSTALL_HOME=${installHome}`);
      expect(rewritten.plan.files[0]?.content).toContain(`ExecStart=${binary} daemon start-sync --takeover`);
    });
  });
});
