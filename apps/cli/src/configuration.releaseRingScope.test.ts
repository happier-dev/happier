import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';

const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_RELEASE_RING']);

const argvSnapshot = [...process.argv];

describe('configuration daemon ownership paths', () => {
  afterEach(() => {
    envScope.restore();
    process.argv = [...argvSnapshot];
    vi.resetModules();
  });

  it('uses the canonical daemon state and lock file when invoked via the public dev shim name', async () => {
    process.env.HAPPIER_HOME_DIR = '/tmp/happier-test-home';
    delete process.env.HAPPIER_RELEASE_RING;
    process.argv = ['node', '/Users/alice/.happier/bin/hdev', 'daemon', 'status'];

    const { configuration } = await import('./configuration');
    const base = `/tmp/happier-test-home/servers/${configuration.activeServerId}`;
    expect(configuration.daemonStateFile).toBe(`${base}/daemon.state.json`);
    expect(configuration.daemonLockFile).toBe(`${base}/daemon.state.json.lock`);
  });

  it('uses the canonical daemon state and lock file when invoked via the preview shim name', async () => {
    process.env.HAPPIER_HOME_DIR = '/tmp/happier-test-home';
    delete process.env.HAPPIER_RELEASE_RING;
    process.argv = ['node', '/Users/alice/.happier/bin/hprev', 'daemon', 'status'];

    const { configuration } = await import('./configuration');
    const base = `/tmp/happier-test-home/servers/${configuration.activeServerId}`;
    expect(configuration.daemonStateFile).toBe(`${base}/daemon.state.json`);
    expect(configuration.daemonLockFile).toBe(`${base}/daemon.state.json.lock`);
  });

  it('uses the same canonical daemon state filename when invoked via the stable shim name', async () => {
    process.env.HAPPIER_HOME_DIR = '/tmp/happier-test-home';
    delete process.env.HAPPIER_RELEASE_RING;
    process.argv = ['node', '/Users/alice/.happier/bin/happier', 'daemon', 'status'];

    const { configuration } = await import('./configuration');
    const base = `/tmp/happier-test-home/servers/${configuration.activeServerId}`;
    expect(configuration.daemonStateFile).toBe(`${base}/daemon.state.json`);
    expect(configuration.daemonLockFile).toBe(`${base}/daemon.state.json.lock`);
  });

  it('keeps daemon ownership paths server-scoped even when HAPPIER_RELEASE_RING=dev is set', async () => {
    process.env.HAPPIER_HOME_DIR = '/tmp/happier-test-home';
    process.env.HAPPIER_RELEASE_RING = 'dev';
    process.argv = ['node', '/usr/local/bin/node', 'daemon', 'status'];

    const { configuration } = await import('./configuration');
    const base = `/tmp/happier-test-home/servers/${configuration.activeServerId}`;
    expect(configuration.daemonStateFile).toBe(`${base}/daemon.state.json`);
  });
});
