import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({
  failWritePath: null as string | null,
  commands: [] as Array<{ command: string; args: readonly string[] }>,
  enabled: true,
  running: false,
  stateReadFailure: false,
  activityReadFailure: false,
}));
// Only filesystem failure and OS service commands are replaced; planner and installer stay real.
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
    if (String(args[0]) === boundary.failWritePath) {
      boundary.failWritePath = null;
      throw new Error('replacement definition write failed');
    }
    return await actual.writeFile(...args);
  } };
});
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawnSync: (command: string, args: readonly string[]) => {
    boundary.commands.push({ command, args });
    if (boundary.stateReadFailure) return { status: 1, stdout: '', stderr: 'Service manager unavailable' };
    if (command === 'systemctl' && args.includes('show')) return { status: 0, stdout: `UnitFileState=${boundary.enabled ? 'enabled' : 'disabled'}\nActiveState=${boundary.running ? 'active' : 'inactive'}\n`, stderr: '' };
    if (command === 'launchctl' && args[0] === 'print-disabled') return { status: 0, stdout: `disabled services = {\n "com.happier.cli.daemon.default" => ${!boundary.enabled}\n "com.happier.cli.daemon.preview.default" => ${!boundary.enabled}\n}`, stderr: '' };
    if (command === 'launchctl' && args[0] === 'print') return boundary.activityReadFailure
      ? { status: 1, stdout: '', stderr: 'Operation not permitted' }
      : { status: boundary.running ? 0 : 113, stdout: boundary.running ? 'state = running' : '', stderr: boundary.running ? '' : `Could not find service "${args[1]?.split('/').at(-1)}" in domain for user gui: 501` };
    if (command === 'powershell.exe' && args.join(' ').includes('Get-ScheduledTask')) return { status: 0, stdout: JSON.stringify({ exists: true, enabled: boundary.enabled, active: boundary.running, autostart: true }), stderr: '' };
    return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
  },
}));

import { planDaemonServiceInstall } from '@/daemon/service/plan';
import { readInstalledDaemonServiceInstallOptions, readInstalledDaemonServiceManagedBy } from '@/daemon/service/discoverInstalledDaemonServiceEntries';
import { buildBackgroundServiceRepairPlan } from './buildBackgroundServiceRepairPlan';
import { applyBackgroundServiceRepairPlan } from './applyBackgroundServiceRepairPlan';

afterEach(() => { vi.unstubAllEnvs(); boundary.failWritePath = null; boundary.commands.length = 0; boundary.enabled = true; boundary.running = false; boundary.stateReadFailure = false; boundary.activityReadFailure = false; });

it.each([false, true])('preserves the prior login trigger, bundle attribution and ownership through repair (rollback=%s)', async (rollback) => {
  const home = await mkdtemp(join(tmpdir(), 'repair-definition-metadata-'));
  try {
    const happierHomeDir = join(home, '.happier');
    const runtime = { platform: 'linux' as const, uid: 501, systemUser: '', userHomeDir: home, happierHomeDir };
    vi.stubEnv('HAPPIER_HOME_DIR', happierHomeDir);
    vi.stubEnv('HAPPIER_DAEMON_SERVICE_USER_HOME_DIR', home);
    const bin = join(home, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'systemctl'), '');
    await chmod(join(bin, 'systemctl'), 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    const prior = planDaemonServiceInstall({
      ...runtime, channel: 'preview', targetMode: 'default-following', instanceId: 'default',
      serverUrl: 'https://company.test', webappUrl: 'https://company.test', publicServerUrl: 'https://company.test',
      nodePath: process.execPath, entryPath: '/opt/happier/index.mjs',
      autostart: 'on-demand', bundleId: 'dev.happier.preview', managedBy: 'desktop',
    });
    const canonical = prior.files[0]!;
    const legacyPath = join(home, '.config', 'systemd', 'user', 'happier-daemon.preview.default.service');
    await mkdir(join(home, '.config', 'systemd', 'user'), { recursive: true });
    await writeFile(legacyPath, canonical.content);
    const plan = buildBackgroundServiceRepairPlan({
      currentReleaseChannel: 'preview', currentHappierHomeDir: happierHomeDir, currentServerId: 'company', preferredMode: 'user',
      services: [{
        serverId: 'default', name: 'Legacy default', verification: 'verified' as const, installed: true, path: legacyPath, platform: 'linux', mode: 'user',
        happierHomeDir, releaseChannel: 'preview', label: 'happier-daemon.preview.default', targetMode: 'default-following',
        installedDefinitionMatchesExpected: false,
      }],
    });
    expect(plan.actions).toEqual([expect.objectContaining({ kind: 'remove-service' }), expect.objectContaining({ kind: 'install-default-following-service' })]);
    if (rollback) boundary.failWritePath = canonical.path;
    const repair = applyBackgroundServiceRepairPlan(plan, runtime);
    if (rollback) await expect(repair).rejects.toThrow('replacement definition write failed');
    else await repair;

    expect(readInstalledDaemonServiceInstallOptions({ platform: 'linux', path: canonical.path }))
      .toEqual({ autostart: 'on-demand', bundleId: 'dev.happier.preview' });
    expect(readInstalledDaemonServiceManagedBy({ platform: 'linux', path: canonical.path })).toBe('desktop');
    expect(await readFile(canonical.path, 'utf8')).toContain('HAPPIER_DAEMON_SERVICE_AUTOSTART=on-demand');
    expect(boundary.commands.some(({ command, args }) => command === 'systemctl' && args.includes('enable'))).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it.each([
  { platform: 'linux', activityOnly: false },
  { platform: 'darwin', activityOnly: false },
  { platform: 'win32', activityOnly: false },
  { platform: 'darwin', activityOnly: true },
] as const)('refuses repair before writes when $platform state is unavailable (activityOnly=$activityOnly)', async ({ platform, activityOnly }) => {
  const home = await mkdtemp(join(tmpdir(), 'repair-unknown-enablement-'));
  try {
    const happierHomeDir = join(home, '.happier');
    const prior = planDaemonServiceInstall({ platform, uid: 501, userHomeDir: home, happierHomeDir, channel: 'preview', targetMode: 'default-following', instanceId: 'default', serverUrl: 'https://company.test', publicServerUrl: 'https://company.test', webappUrl: 'https://company.test', nodePath: process.execPath, entryPath: '/opt/happier/index.mjs', autostart: 'at-login' });
    const file = prior.files[0]!;
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content);
    boundary.stateReadFailure = !activityOnly;
    boundary.activityReadFailure = activityOnly;
    boundary.enabled = !activityOnly;
    const label = platform === 'darwin' ? 'com.happier.cli.daemon.default' : `${platform === 'win32' ? 'Happier\\' : ''}happier-daemon.default`;
    expect(() => buildBackgroundServiceRepairPlan({ currentReleaseChannel: 'preview', currentHappierHomeDir: happierHomeDir, currentServerId: 'company', preferredMode: 'user', services: [{ serverId: 'default', name: 'Default', verification: 'verified' as const, installed: true, path: file.path, platform, mode: 'user', happierHomeDir, releaseChannel: 'preview', label, targetMode: 'default-following', installedDefinitionMatchesExpected: false }] }))
      .toThrow(expect.objectContaining({ code: 'service_inventory_unavailable', message: expect.stringContaining(label) }));
    expect(await readFile(file.path, 'utf8')).toBe(file.content);
  } finally { await rm(home, { recursive: true, force: true }); }
});

it.each(['linux', 'darwin', 'win32'] as const)('preserves actual OS disablement separately from the declared trigger on %s, including compensation', async (platform) => {
  for (const running of [false, true]) for (const rollback of [false, true]) {
    const home = await mkdtemp(join(tmpdir(), 'repair-disabled-'));
    try {
      boundary.enabled = false;
      boundary.running = running;
      boundary.commands.length = 0;
      const happierHomeDir = join(home, '.happier');
      const runtime = { platform, uid: 501, systemUser: '', userHomeDir: home, happierHomeDir };
      vi.stubEnv('HAPPIER_HOME_DIR', happierHomeDir);
      vi.stubEnv('HAPPIER_DAEMON_SERVICE_USER_HOME_DIR', home);
      const bin = join(home, 'bin');
      await mkdir(bin);
      for (const command of ['systemctl', 'launchctl', 'schtasks', 'powershell.exe']) {
        await writeFile(join(bin, command), '');
        await chmod(join(bin, command), 0o755);
      }
      vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
      const prior = planDaemonServiceInstall({ ...runtime, channel: 'preview', targetMode: 'default-following', instanceId: 'default', serverUrl: 'https://company.test', publicServerUrl: 'https://company.test', webappUrl: 'https://company.test', nodePath: process.execPath, entryPath: '/opt/happier/index.mjs', autostart: 'at-login', bundleId: 'dev.happier.preview', managedBy: 'desktop' });
      const canonical = prior.files[0]!;
      const stem = platform === 'darwin' ? 'com.happier.cli.daemon' : 'happier-daemon';
      const legacyPath = canonical.path.replace(`${stem}.default`, `${stem}.preview.default`);
      await mkdir(dirname(legacyPath), { recursive: true });
      await writeFile(legacyPath, canonical.content.replaceAll(`${stem}.default`, `${stem}.preview.default`));
      const label = `${platform === 'win32' ? 'Happier\\' : ''}${stem}.preview.default`;
      const plan = buildBackgroundServiceRepairPlan({ currentReleaseChannel: 'preview', currentHappierHomeDir: happierHomeDir, currentServerId: 'company', preferredMode: 'user', services: [{ serverId: 'default', name: 'Legacy default', verification: 'verified' as const, installed: true, path: legacyPath, platform, mode: 'user', happierHomeDir, releaseChannel: 'preview', label, targetMode: 'default-following', installedDefinitionMatchesExpected: false }] });
      boundary.commands.length = 0;
      if (rollback) boundary.failWritePath = canonical.path;
      const repair = applyBackgroundServiceRepairPlan(plan, runtime);
      if (rollback) await expect(repair).rejects.toThrow('replacement definition write failed');
      else await repair;
      expect(readInstalledDaemonServiceInstallOptions({ platform, path: canonical.path })).toEqual({ autostart: 'at-login', bundleId: 'dev.happier.preview' });
      expect(readInstalledDaemonServiceManagedBy({ platform, path: canonical.path })).toBe('desktop');
      const commands = boundary.commands.map(({ command, args }) => [command, ...args].join(' '));
      const enables = platform === 'linux' ? /systemctl .*\benable\b/u : platform === 'darwin' ? /launchctl enable\b/u : /Enable-ScheduledTask/u;
      const starts = platform === 'linux' ? /systemctl .*\b(?:restart|start)\b/u : platform === 'darwin' ? /launchctl (?:bootstrap|kickstart)\b/u : /schtasks \/Run\b/u;
      const disables = platform === 'linux' ? /systemctl .*\bdisable\b/u : platform === 'darwin' ? /launchctl disable\b/u : /Disable-ScheduledTask/u;
      // launchd requires temporary enablement to reload a running disabled job, then restores it.
      if (!running || platform !== 'darwin') expect(commands.some((command) => enables.test(command))).toBe(false);
      expect(commands.some((command) => starts.test(command) && !command.includes('try-restart'))).toBe(running);
      expect(commands.some((command) => disables.test(command))).toBe(true);
      const lastDisable = commands.reduce((last, command, index) => disables.test(command) ? index : last, -1);
      const lastStart = commands.reduce((last, command, index) => starts.test(command) ? index : last, -1);
      if (platform !== 'linux' && running) expect(lastDisable).toBeGreaterThan(lastStart);
    } finally { await rm(home, { recursive: true, force: true }); }
  }
});
