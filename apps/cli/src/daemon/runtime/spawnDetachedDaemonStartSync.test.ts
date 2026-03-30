import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';

const spawnMock = vi.fn((..._args: any[]) => ({ unref() {} }));
const resolveDaemonLaunchSpecMock = vi.fn(async (..._args: any[]) => ({
  filePath: '/usr/bin/node',
  args: ['--no-warnings', '--no-deprecation', '/opt/happier/package-dist/index.mjs', 'daemon', 'start-sync'],
}));

vi.mock('child_process', () => ({
  spawn: (...args: any[]) => spawnMock(...args),
}));

vi.mock('./resolveDaemonLaunchSpec', () => ({
  resolveDaemonLaunchSpec: (...args: any[]) => resolveDaemonLaunchSpecMock(...args),
}));

describe('spawnDetachedDaemonStartSync', () => {
  const envScope = createEnvKeyScope(['HAPPIER_RELEASE_RING', 'HAPPIER_PUBLIC_RELEASE_CHANNEL']);

  afterEach(() => {
    envScope.restore();
    spawnMock.mockClear();
    resolveDaemonLaunchSpecMock.mockClear();
    vi.resetModules();
  });

  it('propagates the public release channel to the detached daemon so state files are scoped per lane', async () => {
    envScope.patch({
      HAPPIER_RELEASE_RING: 'dev',
      HAPPIER_PUBLIC_RELEASE_CHANNEL: undefined,
    });

    const mod = await import('./spawnDetachedDaemonStartSync');
    await mod.spawnDetachedDaemonStartSync();

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, , options] = spawnMock.mock.calls[0] as any[];
    expect(options?.env?.HAPPIER_PUBLIC_RELEASE_CHANNEL).toBe('dev');
  });
});
