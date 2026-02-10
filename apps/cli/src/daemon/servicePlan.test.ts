import { describe, expect, it } from 'vitest';

import { planDaemonServiceInstall } from './service/plan';
import { escapeSystemdValue } from './service/systemdUser';

describe('daemon service install plan', () => {
  it('escapes systemd Environment= values with percent signs and newlines', () => {
    expect(escapeSystemdValue('100%')).toBe('"100%%"');
    expect(escapeSystemdValue('line1\nline2')).toBe('"line1\\nline2"');
    expect(escapeSystemdValue('line1\r\nline2')).toBe('"line1\\nline2"');
    expect(escapeSystemdValue('line1\rline2')).toBe('"line1\\nline2"');
  });

  it('plans a LaunchAgent install (darwin)', () => {
    const plan = planDaemonServiceInstall({
      platform: 'darwin',
      instanceId: 'cloud',
      uid: 501,
      userHomeDir: '/Users/test',
      happierHomeDir: '/Users/test/.happier',
      serverUrl: 'https://api.happier.dev',
      webappUrl: 'https://app.happier.dev',
      publicServerUrl: 'https://api.happier.dev',
      nodePath: '/opt/homebrew/bin/node',
      entryPath: '/usr/local/lib/node_modules/@happier-dev/cli/dist/index.mjs',
    });

    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]?.path).toBe('/Users/test/Library/LaunchAgents/com.happier.cli.daemon.cloud.plist');
    expect(plan.files[0]?.content).toContain('<string>/opt/homebrew/bin/node</string>');
    expect(plan.files[0]?.content).toContain('<string>/usr/local/lib/node_modules/@happier-dev/cli/dist/index.mjs</string>');
    expect(plan.files[0]?.content).toContain('<string>daemon</string>');
    expect(plan.files[0]?.content).toContain('<string>start-sync</string>');
    expect(plan.files[0]?.content).toContain('<key>HAPPIER_HOME_DIR</key>');
    expect(plan.files[0]?.content).toContain('<key>HAPPIER_SERVER_URL</key>');
    expect(plan.files[0]?.content).toContain('<key>HAPPIER_DAEMON_WAIT_FOR_AUTH</key>');

    let hasLaunchctl = false;
    let commandsText = '';
    for (const c of plan.commands) {
      if (c.cmd === 'launchctl') hasLaunchctl = true;
      commandsText += `${c.cmd} ${c.args.join(' ')}\n`;
    }
    expect(hasLaunchctl).toBe(true);
    expect(commandsText).toContain('launchctl bootstrap gui/501');
  });

  it('plans a systemd --user unit install (linux)', () => {
    const plan = planDaemonServiceInstall({
      platform: 'linux',
      instanceId: 'cloud',
      userHomeDir: '/home/test',
      happierHomeDir: '/home/test/.happier',
      serverUrl: 'https://api.happier.dev',
      webappUrl: 'https://app.happier.dev',
      publicServerUrl: 'https://api.happier.dev',
      nodePath: '/usr/bin/node',
      entryPath: '/usr/lib/node_modules/@happier-dev/cli/dist/index.mjs',
    });

    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]?.path).toBe('/home/test/.config/systemd/user/happier-daemon.cloud.service');
    expect(plan.files[0]?.content).toContain('ExecStart=/usr/bin/node /usr/lib/node_modules/@happier-dev/cli/dist/index.mjs daemon start-sync');
    expect(plan.files[0]?.content).toContain('Environment=HAPPIER_HOME_DIR=/home/test/.happier');
    expect(plan.files[0]?.content).toContain('Environment=HAPPIER_SERVER_URL=https://api.happier.dev');
    expect(plan.files[0]?.content).toContain('Environment=HAPPIER_DAEMON_WAIT_FOR_AUTH=1');

    let hasSystemctl = false;
    let systemctlArgsText = '';
    for (const c of plan.commands) {
      if (c.cmd === 'systemctl') hasSystemctl = true;
      systemctlArgsText += `${c.args.join(' ')}\n`;
    }
    expect(hasSystemctl).toBe(true);
    expect(systemctlArgsText).toContain('--user daemon-reload');
  });

  it('quotes ExecStart paths that contain spaces (linux)', () => {
    const plan = planDaemonServiceInstall({
      platform: 'linux',
      instanceId: 'cloud',
      userHomeDir: '/home/test',
      happierHomeDir: '/home/test/.happier',
      serverUrl: 'https://api.happier.dev',
      webappUrl: 'https://app.happier.dev',
      publicServerUrl: 'https://api.happier.dev',
      nodePath: '/opt/Node With Spaces/bin/node',
      entryPath: '/home/test/Library/Application Support/Happier/dist/index.mjs',
    });

    expect(plan.files).toHaveLength(1);
    expect(plan.files[0]?.content).toContain('ExecStart="/opt/Node With Spaces/bin/node" "/home/test/Library/Application Support/Happier/dist/index.mjs" daemon start-sync');
  });

  it('plans instance-specific unit names (linux)', () => {
    const plan = planDaemonServiceInstall({
      platform: 'linux',
      instanceId: 'company',
      userHomeDir: '/home/test',
      happierHomeDir: '/home/test/.happier',
      nodePath: '/usr/bin/node',
      entryPath: '/usr/lib/node_modules/@happier-dev/cli/dist/index.mjs',
      serverUrl: 'https://company.example.test',
      webappUrl: 'https://app.company.example.test',
      publicServerUrl: 'https://company.example.test',
    });

    expect(plan.files[0]?.path).toBe('/home/test/.config/systemd/user/happier-daemon.company.service');
    expect(plan.files[0]?.content).toContain('Environment=HAPPIER_SERVER_URL=https://company.example.test');
  });
});
