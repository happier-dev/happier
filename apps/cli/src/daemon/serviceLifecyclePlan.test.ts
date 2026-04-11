import { describe, expect, it } from 'vitest';

import { planDaemonServiceLifecycle } from './service/plan';

describe('daemon service lifecycle planning', () => {
  it.each([
    ['start', 'systemctl --user start happier-daemon.company.service'],
    ['stop', 'systemctl --user stop happier-daemon.company.service'],
    ['restart', 'systemctl --user restart happier-daemon.company.service'],
    ['status', 'systemctl --user status happier-daemon.company.service --no-pager'],
  ] as const)('plans linux %s command', (action, expectedLine) => {
    const plan = planDaemonServiceLifecycle({
      platform: 'linux',
      action,
      channel: 'stable',
      instanceId: 'company',
      userHomeDir: '/home/test',
      uid: 123,
    });
    const lines = plan.commands.map((c) => `${c.cmd} ${c.args.join(' ')}`).join('\n');
    expect(lines).toContain(expectedLine);
  });

  it('plans channel-scoped linux lifecycle commands for dev', () => {
    const plan = planDaemonServiceLifecycle({
      platform: 'linux',
      action: 'status',
      channel: 'publicdev',
      instanceId: 'company',
      userHomeDir: '/home/test',
      uid: 123,
    });
    const lines = plan.commands.map((c) => `${c.cmd} ${c.args.join(' ')}`).join('\n');
    expect(lines).toContain('systemctl --user status happier-daemon.dev.company.service --no-pager');
  });

  it.each([
    ['stop', ['launchctl bootout gui/501/com.happier.cli.daemon.cloud']],
    ['start', [
      'launchctl bootout gui/501/com.happier.cli.daemon.cloud',
      'launchctl enable gui/501/com.happier.cli.daemon.cloud',
      'launchctl bootstrap gui/501 /Users/test/Library/LaunchAgents/com.happier.cli.daemon.cloud.plist',
      'launchctl kickstart -k gui/501/com.happier.cli.daemon.cloud',
    ]],
    ['restart', [
      'launchctl bootout gui/501/com.happier.cli.daemon.cloud',
      'launchctl enable gui/501/com.happier.cli.daemon.cloud',
      'launchctl bootstrap gui/501 /Users/test/Library/LaunchAgents/com.happier.cli.daemon.cloud.plist',
      'launchctl kickstart -k gui/501/com.happier.cli.daemon.cloud',
    ]],
    ['status', ['launchctl print gui/501/com.happier.cli.daemon.cloud']],
  ] as const)('plans darwin %s command set', (action, expectedLines) => {
    const plan = planDaemonServiceLifecycle({
      platform: 'darwin',
      action,
      channel: 'stable',
      instanceId: 'cloud',
      userHomeDir: '/Users/test',
      uid: 501,
    });
    const lines = plan.commands.map((c) => `${c.cmd} ${c.args.join(' ')}`);
    for (const expectedLine of expectedLines) {
      expect(lines).toContain(expectedLine);
    }
    if (action === 'start' || action === 'restart') {
      const enableIndex = lines.indexOf('launchctl enable gui/501/com.happier.cli.daemon.cloud');
      const bootstrapIndex = lines.indexOf('launchctl bootstrap gui/501 /Users/test/Library/LaunchAgents/com.happier.cli.daemon.cloud.plist');
      expect(enableIndex).toBeGreaterThanOrEqual(0);
      expect(bootstrapIndex).toBeGreaterThan(enableIndex);
    }
  });

  it('returns no darwin commands when uid is unavailable', () => {
    const plan = planDaemonServiceLifecycle({
      platform: 'darwin',
      action: 'start',
      channel: 'stable',
      instanceId: 'cloud',
      userHomeDir: '/Users/test',
    });
    expect(plan.commands).toEqual([]);
  });

  it('plans darwin start with kickstart-only when requested', () => {
    const plan = planDaemonServiceLifecycle({
      platform: 'darwin',
      action: 'start',
      channel: 'stable',
      instanceId: 'cloud',
      userHomeDir: '/Users/test',
      uid: 501,
      darwinStartMode: 'kickstart',
    });

    expect(plan.commands).toEqual([
      {
        cmd: 'launchctl',
        args: ['kickstart', '-k', 'gui/501/com.happier.cli.daemon.cloud'],
      },
    ]);
  });
});
