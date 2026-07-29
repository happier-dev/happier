import { describe, expect, it } from 'vitest';

import { planDaemonServiceInstall } from './plan';

const baseInstallParams = {
  platform: 'linux',
  mode: 'user',
  channel: 'stable',
  userHomeDir: '/home/alice',
  happierHomeDir: '/home/alice/.happier',
  serverUrl: 'https://api.company.example.test',
  webappUrl: 'https://app.company.example.test',
  publicServerUrl: 'https://api.company.example.test',
  nodePath: '/usr/bin/node',
  entryPath: '/opt/happier/package-dist/index.mjs',
} as const;

describe('daemon service plan active server id', () => {
  it('requires an explicit active server id for pinned service plans', () => {
    expect(() =>
      planDaemonServiceInstall({
        ...baseInstallParams,
        targetMode: 'pinned',
        instanceId: 'service-instance',
      }),
    ).toThrow(/active server id/i);
  });

  it('pins service env to the active server id while keeping service identity separate', () => {
    const plan = planDaemonServiceInstall({
      ...baseInstallParams,
      targetMode: 'pinned',
      instanceId: 'service-instance',
      activeServerId: 'company',
    });

    expect(plan.files[0]?.path).toBe('/home/alice/.config/systemd/user/happier-daemon.service-instance.service');
    expect(plan.files[0]?.content).toContain('Environment=HAPPIER_ACTIVE_SERVER_ID=company');
    expect(plan.files[0]?.content).not.toContain('Environment=HAPPIER_ACTIVE_SERVER_ID=service-instance');
  });

  it('allows default-following service plans without pinning active server env', () => {
    const plan = planDaemonServiceInstall({
      ...baseInstallParams,
      targetMode: 'default-following',
      instanceId: 'service-instance',
    });

    expect(plan.files[0]?.path).toBe('/home/alice/.config/systemd/user/happier-daemon.default.service');
    expect(plan.files[0]?.content).not.toContain('Environment=HAPPIER_ACTIVE_SERVER_ID=');
    expect(plan.files[0]?.content).not.toContain('Environment=HAPPIER_SERVER_URL=');
  });
});
