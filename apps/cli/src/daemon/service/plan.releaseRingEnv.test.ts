import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { planDaemonServiceInstall } from './plan';
import { readInstalledDaemonServiceInstallOptions } from './discoverInstalledDaemonServiceEntries';

describe('daemon service plan release ring env', () => {
  it('writes HAPPIER_PUBLIC_RELEASE_CHANNEL=dev into systemd unit env for the public dev lane', () => {
    const plan = planDaemonServiceInstall({
      platform: 'linux',
      mode: 'user',
      channel: 'publicdev',
      instanceId: 'cloud',
      activeServerId: 'cloud',
      userHomeDir: '/home/alice',
      happierHomeDir: '/home/alice/.happier',
      firstPartyInstallHome: '/opt/happier',
      serverUrl: 'https://api.example.test',
      webappUrl: 'https://app.example.test',
      publicServerUrl: 'https://api.example.test',
      nodePath: '/usr/bin/node',
      entryPath: '/opt/happier/package-dist/index.mjs',
    });

    expect(plan.files[0]?.content ?? '').toContain('HAPPIER_PUBLIC_RELEASE_CHANNEL=dev');
    expect(plan.files[0]?.content ?? '').toContain('UMask=0002');
    expect(plan.files[0]?.content ?? '').toContain('Slice=happier-critical.slice');
    expect(plan.files[0]?.content ?? '').toContain('ManagedOOMPreference=avoid');
    expect(plan.files[0]?.content ?? '').toContain('Environment=HAPPIER_HOME_DIR=/home/alice/.happier');
    expect(plan.files[0]?.content ?? '').toContain('Environment=HAPPIER_FIRST_PARTY_INSTALL_HOME=/opt/happier');
    expect(plan.files[0]?.content ?? '').not.toContain('HAPPIER_MANAGED_TOOLS_ROOT');
    const dir = mkdtempSync(join(tmpdir(), 'happier-service-layout-'));
    try {
      const path = join(dir, 'daemon.service');
      writeFileSync(path, plan.files[0]!.content);
      expect(readInstalledDaemonServiceInstallOptions({ platform: 'linux', path })).toMatchObject({
        firstPartyInstallHome: '/opt/happier',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
