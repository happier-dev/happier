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
      instanceId: 'company',
      userHomeDir: '/home/test',
      uid: 123,
    });
    const lines = plan.commands.map((c) => `${c.cmd} ${c.args.join(' ')}`).join('\n');
    expect(lines).toContain(expectedLine);
  });

  it.each([
    ['stop', 'launchctl bootout gui/501/com.happier.cli.daemon.official'],
    ['start', 'launchctl bootstrap gui/501 /Users/test/Library/LaunchAgents/com.happier.cli.daemon.official.plist'],
    ['restart', 'launchctl kickstart -k gui/501/com.happier.cli.daemon.official'],
    ['status', 'launchctl list com.happier.cli.daemon.official'],
  ] as const)('plans darwin %s command set', (action, expectedLine) => {
    const plan = planDaemonServiceLifecycle({
      platform: 'darwin',
      action,
      instanceId: 'official',
      userHomeDir: '/Users/test',
      uid: 501,
    });
    const lines = plan.commands.map((c) => `${c.cmd} ${c.args.join(' ')}`).join('\n');
    expect(lines).toContain(expectedLine);
  });

  it('returns no darwin commands when uid is unavailable', () => {
    const plan = planDaemonServiceLifecycle({
      platform: 'darwin',
      action: 'start',
      instanceId: 'official',
      userHomeDir: '/Users/test',
    });
    expect(plan.commands).toEqual([]);
  });
});
