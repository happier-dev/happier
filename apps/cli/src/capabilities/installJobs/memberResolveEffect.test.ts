import { expect, test } from 'vitest';
import { buildMemberAgentCliResolutionEnvironment } from './memberResolveEffect';

test.each([
  { platform: 'linux', home: '/srv/members/alice', root: undefined,
    bins: ['/srv/members/alice/.local/bin', '/usr/bin', '/bin'], delimiter: ':' },
  { platform: 'darwin', home: '/Users/alice', root: undefined,
    bins: ['/Users/alice/.local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'], delimiter: ':' },
  { platform: 'win32', home: 'D:\\Users\\alice', root: 'D:\\Windows',
    bins: ['D:\\Users\\alice\\.local\\bin', 'D:\\Windows\\System32', 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0'], delimiter: ';' },
])('member execution on $platform has native tools without inheriting the daemon PATH', ({ platform, home, root, bins, delimiter }) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: platform });
  try {
    const environment = buildMemberAgentCliResolutionEnvironment({ HOME: home, USERPROFILE: home,
      SystemRoot: root, PATH: '/daemon/private/bin' });
    expect(environment.PATH?.split(delimiter)).toEqual(expect.arrayContaining(bins));
    expect(environment.PATH).not.toContain('/daemon');
    expect(environment.HOME).toBe(home);
  } finally { Object.defineProperty(process, 'platform', descriptor); }
});
