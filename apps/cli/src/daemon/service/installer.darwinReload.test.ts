import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DaemonServiceInstallPlan } from './plan';

// Only command execution (launchctl) is mocked; planning and discovery run on real files.
const { applyDaemonServiceInstallPlanMock } = vi.hoisted(() => ({
  applyDaemonServiceInstallPlanMock: vi.fn(async (_plan: DaemonServiceInstallPlan) => undefined),
}));

vi.mock('./apply', async () => {
  const actual = await vi.importActual<typeof import('./apply')>('./apply');
  return { ...actual, applyDaemonServiceInstallPlan: applyDaemonServiceInstallPlanMock };
});

describe('installDaemonService on darwin', () => {
  const userHomeDir = mkdtempSync(join(tmpdir(), 'happier-service-reload-'));

  afterEach(() => {
    rmSync(userHomeDir, { recursive: true, force: true });
  });

  // A kickstart keeps launchd's loaded (possibly stale) job; a restart must reload the definition.
  it.each([
    ['its definition changed', 'stable' as const, {}],
    ['it runs a daemon from another CLI', 'publicdev' as const, { restartRunningDaemon: true }],
  ])('reloads the launchd job instead of only kickstarting it when %s', async (_case, installedChannel, restart) => {
    const install = (channel: 'stable' | 'publicdev') => ({
      platform: 'darwin' as const,
      uid: 501,
      userHomeDir,
      happierHomeDir: join(userHomeDir, '.happier'),
      channel,
      targetMode: 'default-following' as const,
      instanceId: 'default',
      autostart: 'at-login' as const,
      serverUrl: 'https://relay.example.test',
      webappUrl: 'https://relay.example.test',
      publicServerUrl: 'https://relay.example.test',
      nodePath: '/opt/happier/bin/happier',
      entryPath: '/opt/happier/package-dist/index.mjs',
    });
    const { planDaemonServiceInstall } = await import('./plan');
    const installed = planDaemonServiceInstall(install(installedChannel)).files[0]!;
    mkdirSync(dirname(installed.path), { recursive: true });
    writeFileSync(installed.path, installed.content);

    const { installDaemonService } = await import('./installer');
    await installDaemonService({
      ...install('publicdev'),
      darwinInstallMode: 'kickstart',
      strategy: 'add',
      ...restart,
      runCommands: true,
      commandFailureMode: 'strict',
    });

    const commands = (applyDaemonServiceInstallPlanMock.mock.calls.at(-1)?.[0]?.commands ?? [])
      .map((command) => [command.cmd, ...command.args].join(' '));
    expect(commands.some((command) => command.startsWith('launchctl bootout'))).toBe(true);
    expect(commands.some((command) => command.startsWith('launchctl bootstrap'))).toBe(true);
  });
});
