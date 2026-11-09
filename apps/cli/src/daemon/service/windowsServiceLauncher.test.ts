import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const taskState = vi.hoisted(() => ({ xml: null as string | null }));

// Scheduled Tasks is the OS boundary; install planning, discovery and staging stay real.
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawnSync: vi.fn((command: string, args: readonly string[] = []) => ({
    status: 0, stdout: command === 'powershell.exe' && args.some((arg) => arg.includes('.GetFolder("\\Happier")'))
      ? JSON.stringify(taskState.xml ? ['\\Happier\\happier-daemon.default'] : [])
      : command === 'schtasks' && args.includes('/XML') ? taskState.xml ?? '' : '', stderr: '',
  })),
}));

import { withTempDir } from '@/testkit/fs/tempDir';
import { createWindowsServiceLauncherPeFixture } from '../../../../../scripts/testing/windowsServiceLauncherPeFixture.mjs';
import { applyDaemonServiceInstallPlan } from './apply';

describe('Windows daemon launcher installation', () => {
  it('stages the native launcher before publishing the wrapper', async () => {
    await withTempDir('daemon-native-launcher-', async (homeDir) => {
      const sourcePath = join(homeDir, 'packaged.exe');
      const destinationPath = join(homeDir, 'service', 'launcher-1', 'happier-service-launcher.exe');
      const definitionPath = join(homeDir, 'service', 'daemon.ps1');
      const bytes = createWindowsServiceLauncherPeFixture();
      writeFileSync(sourcePath, bytes);
      const plan = {
        platform: 'win32' as const,
        copies: [{ sourcePath, destinationPath, validation: 'windows-service-launcher-x64-v1' as const }],
        files: [{ path: definitionPath, content: 'wrapper', mode: 0o644 }],
        commands: [],
      };
      await applyDaemonServiceInstallPlan(plan, { runCommands: false });
      expect(existsSync(destinationPath)).toBe(true);
      expect(readFileSync(destinationPath)).toEqual(bytes);
      expect(readFileSync(definitionPath, 'utf8')).toBe('wrapper');
    });
  });

  it('rejects a missing packaged launcher before stopping the current daemon owner', async () => {
    await withTempDir('daemon-native-preflight-', async (homeDir) => {
      const execPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!;
      // The real install-root resolver selects this physical self-contained runtime.
      const executable = join(homeDir, 'runtime', 'happier.exe');
      mkdirSync(dirname(executable), { recursive: true });
      writeFileSync(executable, 'runtime fixture');
      Object.defineProperty(process, 'execPath', { configurable: true, value: executable });
      const { installDaemonService } = await import('./installer');
      let ownerStopped = false;
      try {
        const result = await installDaemonService({
          platform: 'win32', channel: 'stable', targetMode: 'default-following',
          instanceId: 'default', activeServerId: 'default', userHomeDir: homeDir, happierHomeDir: homeDir,
          nodePath: executable, entryPath: '', runCommands: false,
          beforeApply: async () => { ownerStopped = true; },
        }).then(() => null, (error: unknown) => error);
        expect(result).toBeInstanceOf(Error);
        expect(String(result)).toMatch(/launcher is unavailable/u);
        expect(ownerStopped).toBe(false);
      } finally {
        Object.defineProperty(process, 'execPath', execPathDescriptor);
      }
    });
  });
  it.each(['legacy', 'current', 'missing'] as const)('converges an unchanged wrapper registered with a %s launcher action', async (actionKind) => {
    await withTempDir('daemon-launcher-convergence-', async (homeDir) => {
      const execPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!;
      const executable = join(homeDir, 'runtime', 'happier.exe');
      mkdirSync(dirname(executable), { recursive: true });
      writeFileSync(executable, 'runtime fixture');
      writeFileSync(join(dirname(executable), 'happier-service-launcher.exe'), createWindowsServiceLauncherPeFixture());
      Object.defineProperty(process, 'execPath', { configurable: true, value: executable });
      try {
        const { installDaemonService, previewDaemonServiceInstall } = await import('./installer');
        const { planDaemonServiceInstall } = await import('./plan');
        const { resolveDaemonWindowsServiceLauncherInstallSpec } = await import('./windowsServiceLauncher');
        const { buildWindowsScheduledTaskLauncherAction, resolveInstalledWindowsServiceLauncherPaths } = await import('@happier-dev/cli-common/service');
        const options = {
          platform: 'win32' as const, channel: 'stable' as const, targetMode: 'default-following' as const,
          instanceId: 'default', activeServerId: 'default', userHomeDir: homeDir, happierHomeDir: homeDir,
          serverUrl: 'https://relay.example.test', webappUrl: 'https://relay.example.test', publicServerUrl: 'https://relay.example.test',
          nodePath: executable, entryPath: '', runCommands: false,
          managedBy: 'desktop' as const, autostart: 'on-demand' as const,
        };
        const plan = planDaemonServiceInstall(options);
        const definition = plan.files[0]!;
        mkdirSync(dirname(definition.path), { recursive: true });
        writeFileSync(definition.path, definition.content);
        const paths = resolveInstalledWindowsServiceLauncherPaths({
          definitionPath: definition.path, label: 'happier-daemon.default',
          version: resolveDaemonWindowsServiceLauncherInstallSpec().version,
        });
        mkdirSync(dirname(paths.launcherPath), { recursive: true });
        writeFileSync(paths.launcherPath, createWindowsServiceLauncherPeFixture());
        const action = buildWindowsScheduledTaskLauncherAction({ launcherPath: paths.launcherPath, definitionPath: definition.path, diagnosticLogPath: paths.diagnosticLogPath });
        taskState.xml = actionKind === 'current'
          ? `<Task><Actions><Exec><Command>${action.executable}</Command><Arguments>${action.arguments.replaceAll('"', '&quot;')}</Arguments></Exec></Actions></Task>`
          : actionKind === 'legacy' ? `<Task><Actions><Exec><Command>powershell.exe</Command><Arguments>-File &quot;${definition.path}&quot;</Arguments></Exec></Actions></Task>` : null;
        const { autostart: _autostart, ...convergenceOptions } = options;
        const preview = await previewDaemonServiceInstall(convergenceOptions);
        expect(preview.exactTargetMatchesExpectedDefinition).toBe(actionKind === 'current');
        let ownerPrepared = false;
        await installDaemonService({ ...convergenceOptions, beforeApply: async () => { ownerPrepared = true; } });
        expect(ownerPrepared).toBe(actionKind !== 'current');
        expect(readFileSync(definition.path, 'utf8')).toBe(definition.content);
      } finally {
        taskState.xml = null;
        Object.defineProperty(process, 'execPath', execPathDescriptor);
      }
    });
  });

  it('keeps a competing registered service intact when the new launcher cannot be staged', async () => {
    await withTempDir('daemon-launcher-conflict-preflight-', async (homeDir) => {
      const execPathDescriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!;
      const executable = join(homeDir, 'runtime', 'happier.exe');
      mkdirSync(dirname(executable), { recursive: true });
      writeFileSync(executable, 'runtime fixture');
      Object.defineProperty(process, 'execPath', { configurable: true, value: executable });
      const oldHome = join(homeDir, 'other-home');
      const oldDefinition = join(oldHome, 'services', 'happier-daemon.default.ps1');
      try {
        const { renderWindowsScheduledTaskWrapperPs1 } = await import('@happier-dev/cli-common/service');
        const { installDaemonService } = await import('./installer');
        mkdirSync(dirname(oldDefinition), { recursive: true });
        const oldContents = renderWindowsScheduledTaskWrapperPs1({
          workingDirectory: oldHome, programArgs: ['happier.exe', 'daemon', 'start-sync'],
          env: { HAPPIER_HOME_DIR: oldHome, HAPPIER_DAEMON_STARTUP_SOURCE: 'background-service' },
        });
        writeFileSync(oldDefinition, oldContents);
        taskState.xml = `<Task><Actions><Exec><Command>powershell.exe</Command><Arguments>-File &quot;${oldDefinition}&quot;</Arguments></Exec></Actions></Task>`;
        await expect(installDaemonService({
          platform: 'win32', channel: 'stable', targetMode: 'default-following',
          instanceId: 'default', activeServerId: 'default', userHomeDir: homeDir, happierHomeDir: homeDir,
          nodePath: executable, entryPath: '', strategy: 'replace-all', runCommands: false,
        })).rejects.toThrow(/launcher is unavailable/u);
        expect(readFileSync(oldDefinition, 'utf8')).toBe(oldContents);
      } finally {
        taskState.xml = null;
        Object.defineProperty(process, 'execPath', execPathDescriptor);
      }
    });
  });

});
