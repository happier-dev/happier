import { describe, expect, it } from 'vitest';

import { planDaemonServiceInstall, type DaemonServicePlatform } from '../service/plan';
import {
  DAEMON_GLIBC_TUNABLES,
  releaseDaemonAllocatorEnvironment,
  withDaemonAllocatorEnvironment,
} from './daemonAllocatorEnvironment';

function serviceDefinition(platform: DaemonServicePlatform): string {
  return planDaemonServiceInstall({
    platform,
    mode: 'user',
    channel: 'stable',
    targetMode: 'default-following',
    instanceId: 'default',
    userHomeDir: platform === 'win32' ? 'C:\\Users\\test' : '/home/test',
    happierHomeDir: platform === 'win32' ? 'C:\\Users\\test\\.happier' : '/home/test/.happier',
    serverUrl: 'https://api.happier.dev',
    webappUrl: 'https://app.happier.dev',
    publicServerUrl: 'https://api.happier.dev',
    nodePath: platform === 'win32' ? 'C:\\bin\\happier.exe' : '/usr/bin/happier',
    entryPath: '',
  }).files[0]?.content ?? '';
}

// LEAN-DAEMON U5 (owner D3): the resident daemon process alone runs with glibc arena/trim settings.
describe('daemon allocator environment', () => {
  it('starts the Linux service daemon with the glibc settings and leaves macOS and Windows unchanged', () => {
    const line = serviceDefinition('linux').split('\n').find((entry) => entry.startsWith('Environment=GLIBC_TUNABLES='));
    expect(line?.slice('Environment=GLIBC_TUNABLES='.length).replace(/^"(.*)"$/, '$1')).toBe(DAEMON_GLIBC_TUNABLES);
    expect(serviceDefinition('darwin')).not.toContain('GLIBC_TUNABLES');
    expect(serviceDefinition('win32')).not.toContain('GLIBC_TUNABLES');
  });

  it('adds the settings to a Linux daemon launch only, and never overrides a person\'s own tunables', () => {
    expect(withDaemonAllocatorEnvironment({ A: '1' }, 'linux')).toEqual({ A: '1', GLIBC_TUNABLES: DAEMON_GLIBC_TUNABLES });
    expect(withDaemonAllocatorEnvironment({ A: '1' }, 'darwin')).toEqual({ A: '1' });
    expect(withDaemonAllocatorEnvironment({ GLIBC_TUNABLES: 'glibc.malloc.tcache_count=0' }, 'linux'))
      .toEqual({ GLIBC_TUNABLES: 'glibc.malloc.tcache_count=0' });
  });

  it('removes the daemon\'s own settings from its environment so no child process inherits them', () => {
    const env: NodeJS.ProcessEnv = { GLIBC_TUNABLES: DAEMON_GLIBC_TUNABLES, A: '1' };
    releaseDaemonAllocatorEnvironment(env);
    expect(env).toEqual({ A: '1' });
    const personal: NodeJS.ProcessEnv = { GLIBC_TUNABLES: 'glibc.malloc.tcache_count=0' };
    releaseDaemonAllocatorEnvironment(personal);
    expect(personal).toEqual({ GLIBC_TUNABLES: 'glibc.malloc.tcache_count=0' });
  });
});
