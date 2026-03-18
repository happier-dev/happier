import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveCliRuntimeLaunchSpec } from './resolveCliRuntimeLaunchSpec.mjs';
import { resolveServerRuntimeLaunchSpec } from './resolveServerRuntimeLaunchSpec.mjs';

test('resolveCliRuntimeLaunchSpec returns a runtime binary command from the snapshot', () => {
  const resolved = resolveCliRuntimeLaunchSpec({
    snapshot: {
      snapshotPath: '/tmp/stack/runtime/builds/snap-1',
      manifest: {
        components: {
          daemon: { entrypoint: 'cli/happier' },
        },
      },
    },
  });

  assert.deepEqual(resolved, {
    source: 'runtime',
    cliDir: '/tmp/stack/runtime/builds/snap-1/cli',
    entrypoint: '/tmp/stack/runtime/builds/snap-1/cli/happier',
    nodeEntrypoint: '/tmp/stack/runtime/builds/snap-1/cli/package-dist/index.mjs',
    command: '/tmp/stack/runtime/builds/snap-1/cli/happier',
    args: [],
  });
});

test('resolveServerRuntimeLaunchSpec returns the runtime server binary command from the snapshot', () => {
  const resolved = resolveServerRuntimeLaunchSpec({
    serverComponent: 'happier-server-light',
    snapshot: {
      snapshotPath: '/tmp/stack/runtime/builds/snap-1',
      manifest: {
        components: {
          server: { entrypoint: 'server/happier-server' },
        },
      },
    },
  });

  assert.deepEqual(resolved, {
    source: 'runtime',
    serverDir: '/tmp/stack/runtime/builds/snap-1/server',
    entrypoint: '/tmp/stack/runtime/builds/snap-1/server/happier-server',
    command: '/tmp/stack/runtime/builds/snap-1/server/happier-server',
    args: [],
  });
});

test('resolveServerRuntimeLaunchSpec falls back to the canonical server binary path when the manifest is absent', () => {
  const resolved = resolveServerRuntimeLaunchSpec({
    serverComponent: 'happier-server',
    snapshot: {
      snapshotPath: '/tmp/stack/runtime/builds/snap-1',
    },
  });

  assert.deepEqual(resolved, {
    source: 'runtime',
    serverDir: '/tmp/stack/runtime/builds/snap-1/server',
    entrypoint: '/tmp/stack/runtime/builds/snap-1/server/happier-server',
    command: '/tmp/stack/runtime/builds/snap-1/server/happier-server',
    args: [],
  });
});

test('resolveCliRuntimeLaunchSpec falls back to the canonical cli path when the manifest entrypoint escapes the snapshot root', () => {
  const resolved = resolveCliRuntimeLaunchSpec({
    snapshot: {
      snapshotPath: '/tmp/stack/runtime/builds/snap-1',
      manifest: {
        components: {
          daemon: { entrypoint: '../outside-cli' },
        },
      },
    },
  });

  assert.deepEqual(resolved, {
    source: 'runtime',
    cliDir: '/tmp/stack/runtime/builds/snap-1/cli',
    entrypoint: '/tmp/stack/runtime/builds/snap-1/cli/happier',
    nodeEntrypoint: '/tmp/stack/runtime/builds/snap-1/cli/package-dist/index.mjs',
    command: '/tmp/stack/runtime/builds/snap-1/cli/happier',
    args: [],
  });
});

test('resolveServerRuntimeLaunchSpec falls back to the canonical server path when the manifest entrypoint escapes the snapshot root', () => {
  const resolved = resolveServerRuntimeLaunchSpec({
    serverComponent: 'happier-server',
    snapshot: {
      snapshotPath: '/tmp/stack/runtime/builds/snap-1',
      manifest: {
        components: {
          server: { entrypoint: '../outside-server' },
        },
      },
    },
  });

  assert.deepEqual(resolved, {
    source: 'runtime',
    serverDir: '/tmp/stack/runtime/builds/snap-1/server',
    entrypoint: '/tmp/stack/runtime/builds/snap-1/server/happier-server',
    command: '/tmp/stack/runtime/builds/snap-1/server/happier-server',
    args: [],
  });
});
