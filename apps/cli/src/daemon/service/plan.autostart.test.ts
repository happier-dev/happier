import { describe, expect, it } from 'vitest';
import { planDaemonServiceInstall } from './plan';

const base = {
  channel: 'stable', targetMode: 'pinned', instanceId: 'cloud', activeServerId: 'cloud', uid: 501,
  userHomeDir: '/home/test', happierHomeDir: '/home/test/.happier', serverUrl: 'https://api.happier.dev',
  webappUrl: 'https://app.happier.dev', publicServerUrl: 'https://api.happier.dev', nodePath: '/usr/bin/happier', entryPath: '',
} as const;
const lines = (plan: ReturnType<typeof planDaemonServiceInstall>) => plan.commands.map(c => `${c.cmd} ${c.args.join(' ')}`);

describe('daemon service login trigger', () => {
  it('attributes both service targets without claiming desktop management, validates IDs, and preserves omitted defaults', () => {
    for (const targetMode of ['pinned', 'default-following'] as const) {
      const params = { ...base, platform: 'darwin', targetMode } as const;
      const terminal = planDaemonServiceInstall(params);
      expect(planDaemonServiceInstall({ ...params, bundleId: null })).toEqual(terminal);
      const attributed = planDaemonServiceInstall({ ...params, bundleId: 'dev.happier.app' });
      expect(attributed.files[0]!.content).toContain('<key>AssociatedBundleIdentifiers</key>');
      expect(attributed.files[0]!.content).toContain('<key>HAPPIER_DAEMON_SERVICE_BUNDLE_ID</key>');
      expect(attributed.files[0]!.content).not.toContain('HAPPIER_DAEMON_SERVICE_MANAGED_BY');
      expect(() => planDaemonServiceInstall({ ...params, bundleId: 'bad value' })).toThrow();
      expect(planDaemonServiceInstall({ ...params, autostart: undefined })).toEqual(terminal);
    }
  });
  it('keeps launchd startable but removes RunAtLoad and KeepAlive in on-demand mode', () => {
    const plan = planDaemonServiceInstall({ ...base, platform: 'darwin', autostart: 'on-demand' });
    expect(plan.files[0]!.content).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
    expect(plan.files[0]!.content).not.toContain('KeepAlive');
    expect(lines(plan)).toContain('launchctl enable gui/501/com.happier.cli.daemon.cloud');
    expect(lines(plan)).toContain('launchctl kickstart -k gui/501/com.happier.cli.daemon.cloud');
  });
  it('clears systemd login enablement without stopping the service', () => {
    const plan = planDaemonServiceInstall({ ...base, platform: 'linux', autostart: 'on-demand' });
    expect(lines(plan)).toContain('systemctl --user disable happier-daemon.cloud.service');
    expect(lines(plan)).toContain('systemctl --user restart happier-daemon.cloud.service');
    expect(lines(plan)).not.toContain('systemctl --user enable happier-daemon.cloud.service');
    expect(plan.files[0]!.content).toContain('HAPPIER_DAEMON_SERVICE_AUTOSTART=on-demand');
  });
  it('registers a Windows task without a login trigger that can still run explicitly', () => {
    const plan = planDaemonServiceInstall({ ...base, platform: 'win32', autostart: 'on-demand' });
    const create = plan.commands.find(c => c.cmd === 'powershell.exe' && String(c.args.at(-1)).includes('RegisterTask'))!;
    expect(create.args.at(-1)).toContain('<Triggers/>');
    expect(create.args.at(-1)).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(create.args.at(-1)).not.toContain('LogonTrigger');
    expect(lines(plan)).toContain('schtasks /Run /TN Happier\\happier-daemon.cloud');
  });
  it('scopes the Windows login task to the invoking interactive user', () => {
    const plan = planDaemonServiceInstall({ ...base, platform: 'win32', managedBy: 'desktop', bundleId: 'dev.happier.app' });
    const registration = plan.commands.find(c => String(c.args.at(-1)).includes('RegisterTask'))!;
    expect(registration.args.at(-1)).toContain('$xml.Task.Triggers.LogonTrigger.UserId = $userId');
    expect(registration.args.at(-1)).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(plan.files[0]!.content).toContain('HAPPIER_DAEMON_SERVICE_MANAGED_BY');
    expect(plan.files[0]!.content).toContain('HAPPIER_DAEMON_SERVICE_BUNDLE_ID');
  });
  it('preserves explicit disabled-service convergence independently of the login trigger', () => {
    const plan = planDaemonServiceInstall({ ...base, platform: 'darwin', autostart: 'on-demand', enablement: 'disabled' });
    expect(lines(plan)).toContain('launchctl disable gui/501/com.happier.cli.daemon.cloud');
    expect(lines(plan).some(line => line.includes(' kickstart '))).toBe(false);
  });
});
