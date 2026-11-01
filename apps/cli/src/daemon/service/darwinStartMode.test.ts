import { afterEach, describe, expect, it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CurrentDaemonOwner, DaemonOwnerEvaluation } from '@/daemon/ownership/evaluateCurrentDaemonOwner';
import { withTempDir } from '@/testkit/fs/tempDir';
import { resolveDarwinServiceStartMode } from './darwinStartMode';
import { planDaemonServiceLifecycle, planDaemonServiceInstall } from './plan';
import { runDaemonServiceCommands } from './apply';

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));
// launchd is an OS boundary; ownership and native-result interpretation stay real.
vi.mock('node:child_process', () => ({ spawnSync }));

const label = 'com.happier.cli.daemon.default';
const owner: CurrentDaemonOwner = {
  status: 'running', source: 'state',
  state: { pid: 4242, httpPort: 43137, startedAt: 1, startedWithCliVersion: '0.3.0', serviceLabel: label },
  currentCliVersion: '0.3.0', currentPublicReleaseChannel: 'stable', versionMatches: true,
  releaseChannelMatches: true, serviceManaged: true, startupSource: 'background-service',
};
const ownership: DaemonOwnerEvaluation = { kind: 'compatible', owner };
const params = { platform: 'darwin' as const, uid: 501, label, ownership };

afterEach(() => { spawnSync.mockReset(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('Darwin service start mode', () => {
  it.each(['install', 'start', 'restart'] as const)('loads an absent job before %s attempts kickstart', async (action) => {
    await withTempDir('happier-launchd-start-', async (directory) => {
      // Real command discovery; only native process execution is substituted.
      writeFileSync(join(directory, process.platform === 'win32' ? 'launchctl.exe' : 'launchctl'), '');
      vi.stubEnv('PATH', directory);
      let loaded = false;
      let started = false;
      spawnSync.mockImplementation((_command: string, args: readonly string[]) => {
        if (args[0] === 'bootstrap') loaded = true;
        if (args[0] === 'kickstart') {
          if (!loaded) return { status: 113, stderr: `Could not find service "${label}" in domain for user gui: 501` };
          started = true;
        }
        return args[0] === 'print' && !loaded
          ? { status: 113, stderr: `Could not find service "${label}" in domain for user gui: 501` }
          : { status: 0, stdout: loaded ? 'state = running' : '' };
      });
      const mode = resolveDarwinServiceStartMode(params);
      const identity = { platform: 'darwin' as const, uid: 501, userHomeDir: directory, instanceId: 'default' };
      const plan = action === 'install'
        ? planDaemonServiceInstall({ ...identity, activeServerId: 'default', happierHomeDir: join(directory, '.happier'),
          serverUrl: 'https://home.example.test', webappUrl: 'https://home.example.test',
          publicServerUrl: 'https://home.example.test', nodePath: '/managed/happier', entryPath: '',
          darwinInstallMode: mode })
        : planDaemonServiceLifecycle({ ...identity, action, darwinStartMode: mode, darwinRestartMode: mode });
      runDaemonServiceCommands(plan.commands, { failureMode: 'strict' });
      expect({ loaded, started }).toEqual({ loaded: true, started: true });
    });
  });

  it('bootstraps an unloaded job even when a surviving daemon carries this service label', () => {
    spawnSync.mockReturnValue({ status: 113, stderr: `Could not find service "${label}" in domain for user gui: 501` });
    expect(resolveDarwinServiceStartMode(params)).toBe('rebootstrap');
  });

  it.each(['running', 'waiting'])('kickstarts a loaded %s job without unloading its service-owned caller', (state) => {
    spawnSync.mockReturnValue({ status: 0, stdout: `gui/501/${label} = {\n state = ${state}\n}` });
    expect(resolveDarwinServiceStartMode(params)).toBe('kickstart');
    expect(spawnSync).toHaveBeenCalledWith('launchctl', ['print', `gui/501/${label}`], expect.any(Object));
  });

  it('does not treat an unreadable launchd domain as a loaded job', () => {
    spawnSync.mockReturnValue({ status: 125, stderr: 'Domain does not support specified action' });
    expect(resolveDarwinServiceStartMode(params)).toBe('rebootstrap');
  });

  it('charges native inspection to the existing service deadline', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    spawnSync.mockReturnValue({ status: 0, stdout: 'state = running' });
    expect(resolveDarwinServiceStartMode({ ...params, deadlineMs: 1_100 })).toBe('kickstart');
    expect(spawnSync.mock.calls[0]?.[2]).toMatchObject({ timeout: 100 });
  });

  it.each([
    { platform: 'linux' as const }, { platform: 'win32' as const },
    { ownership: { kind: 'none' } as const },
    { ownership: { kind: 'compatible', owner: { ...owner, serviceManaged: false } } as const },
    { label: 'com.happier.cli.daemon.other' },
  ])('does not use launchd to decide an unrelated owner or platform: %j', (override) => {
    expect(resolveDarwinServiceStartMode({ ...params, ...override })).toBe('rebootstrap');
    expect(spawnSync).not.toHaveBeenCalled();
  });
});
