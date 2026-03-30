import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';

const envScope = createEnvKeyScope([
  'HAPPIER_VARIANT',
  'HAPPIER_PUBLIC_RELEASE_CHANNEL',
  'HAPPIER_RELEASE_RING',
  'HAPPIER_RELEASE_CHANNEL',
  'HAPPIER_HOME_DIR',
]);

describe('spawnDetachedDaemonStartSync', () => {
  afterEach(() => {
    envScope.restore();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('forwards HAPPIER_PUBLIC_RELEASE_CHANNEL to the detached daemon so it does not fall back to stable', async () => {
    envScope.patch({
      HAPPIER_VARIANT: 'dev',
      HAPPIER_HOME_DIR: '/tmp/happier-spawn-detached-test',
    });
    // Simulate invoking the CLI via the dev shim name.
    process.argv = ['node', '/Users/alice/.happier/bin/hdev', 'daemon', 'start'];

    const spawnMock: Mock<(typeof import('child_process'))['spawn']> = vi.fn(() => ({ unref() {} }) as any);
    vi.doMock('child_process', () => ({
      spawn: spawnMock,
    }));

    vi.resetModules();
    const { spawnDetachedDaemonStartSync } = await import('./spawnDetachedDaemonStartSync');
    await spawnDetachedDaemonStartSync();

    expect(spawnMock).toHaveBeenCalled();
    const opts = spawnMock.mock.calls[0]?.[2] as { env?: Record<string, string> } | undefined;
    expect(opts?.env?.HAPPIER_PUBLIC_RELEASE_CHANNEL).toBe('dev');
  });
});
