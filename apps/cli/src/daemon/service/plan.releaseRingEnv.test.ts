import { describe, expect, it } from 'vitest';

import { planDaemonServiceInstall } from './plan';

describe('daemon service plan release ring env', () => {
  it('writes HAPPIER_PUBLIC_RELEASE_CHANNEL=dev into systemd unit env for the public dev lane', () => {
    const plan = planDaemonServiceInstall({
      platform: 'linux',
      mode: 'user',
      channel: 'publicdev',
      instanceId: 'cloud',
      userHomeDir: '/home/alice',
      happierHomeDir: '/home/alice/.happier',
      serverUrl: 'https://api.example.test',
      webappUrl: 'https://app.example.test',
      publicServerUrl: 'https://api.example.test',
      nodePath: '/usr/bin/node',
      entryPath: '/opt/happier/package-dist/index.mjs',
    });

    expect(plan.files[0]?.content ?? '').toContain('HAPPIER_PUBLIC_RELEASE_CHANNEL=dev');
  });
});
