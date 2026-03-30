import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';

const envScope = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_RELEASE_RING']);

const argvSnapshot = [...process.argv];

describe('configuration release ring scoping', () => {
  afterEach(() => {
    envScope.restore();
    process.argv = [...argvSnapshot];
    vi.resetModules();
  });

  it('scopes daemon state and lock files when invoked via the public dev shim name', async () => {
    process.env.HAPPIER_HOME_DIR = '/tmp/happier-test-home';
    delete process.env.HAPPIER_RELEASE_RING;
    process.argv = ['node', '/Users/alice/.happier/bin/hdev', 'daemon', 'status'];

    const { configuration } = await import('./configuration');
    const base = `/tmp/happier-test-home/servers/${configuration.activeServerId}`;
    expect(configuration.daemonStateFile).toBe(`${base}/daemon.dev.state.json`);
    expect(configuration.daemonLockFile).toBe(`${base}/daemon.dev.state.json.lock`);
  });

  it('scopes daemon state and lock files when invoked via the preview shim name', async () => {
    process.env.HAPPIER_HOME_DIR = '/tmp/happier-test-home';
    delete process.env.HAPPIER_RELEASE_RING;
    process.argv = ['node', '/Users/alice/.happier/bin/hprev', 'daemon', 'status'];

    const { configuration } = await import('./configuration');
    const base = `/tmp/happier-test-home/servers/${configuration.activeServerId}`;
    expect(configuration.daemonStateFile).toBe(`${base}/daemon.preview.state.json`);
    expect(configuration.daemonLockFile).toBe(`${base}/daemon.preview.state.json.lock`);
  });

  it('keeps the legacy stable daemon state filename when invoked via the stable shim name', async () => {
    process.env.HAPPIER_HOME_DIR = '/tmp/happier-test-home';
    delete process.env.HAPPIER_RELEASE_RING;
    process.argv = ['node', '/Users/alice/.happier/bin/happier', 'daemon', 'status'];

    const { configuration } = await import('./configuration');
    const base = `/tmp/happier-test-home/servers/${configuration.activeServerId}`;
    expect(configuration.daemonStateFile).toBe(`${base}/daemon.state.json`);
    expect(configuration.daemonLockFile).toBe(`${base}/daemon.state.json.lock`);
  });

  it('accepts HAPPIER_RELEASE_RING=dev as an override for service scenarios where argv[1] is not the shim name', async () => {
    process.env.HAPPIER_HOME_DIR = '/tmp/happier-test-home';
    process.env.HAPPIER_RELEASE_RING = 'dev';
    process.argv = ['node', '/usr/local/bin/node', 'daemon', 'status'];

    const { configuration } = await import('./configuration');
    const base = `/tmp/happier-test-home/servers/${configuration.activeServerId}`;
    expect(configuration.daemonStateFile).toBe(`${base}/daemon.dev.state.json`);
  });
});
