import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

import {
  applyCliRuntimeLaunchProvenanceEnv,
  resolveCliRuntimeLaunchProvenance,
  resolveCliRuntimeLaunchSpec,
} from './resolveCliRuntimeLaunchSpec.mjs';
import { resolveServerRuntimeLaunchSpec } from './resolveServerRuntimeLaunchSpec.mjs';

test('source server launch executes nonexecutable emitted JS through its managed runtime and honors disabled migrations', async t => {
  const serverDir = await mkdtemp(join(tmpdir(), 'hstack-source-launch-'));
  t.after(() => rm(serverDir, { recursive: true, force: true }));
  const entrypoint = join(serverDir, 'main.mjs');
  await writeFile(entrypoint, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  await chmod(entrypoint, 0o644);
  const sourceRuntimeLaunch = { runtimeCommand: entrypoint, entrypoint, serverDir, args: ['source-launch'],
    migration: { mode: 'external', command: join(serverDir, 'scripts/migrate.mjs'), args: [], cwd: serverDir } };
  const enabled = resolveServerRuntimeLaunchSpec({ sourceRuntimeLaunch, migrationsEnabled: true });
  const child = spawnSync(enabled.command, enabled.args, { encoding: 'utf8' });
  assert.equal(child.status, 0, child.error?.message ?? child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), ['source-launch']);
  assert.equal(enabled.command, process.execPath);
  assert.deepEqual(enabled.args, [entrypoint, 'source-launch']);
  assert.equal(enabled.migration.mode, 'external');
  const disabled = resolveServerRuntimeLaunchSpec({ sourceRuntimeLaunch, migrationsEnabled: false });
  assert.deepEqual(disabled.migration, { mode: 'disabled' });
});

test('source bundle CLI launch uses its retained entry without native snapshot provenance', () => {
  const spec = resolveCliRuntimeLaunchSpec({ sourceRuntimeLaunch: { cliDir: '/qa/source/cli', entrypoint: '/qa/source/cli/src/index.mjs' } });
  assert.equal(spec.command, '/qa/source/cli/src/index.mjs');
  assert.equal(spec.sourceSnapshot, true);
  assert.equal(resolveCliRuntimeLaunchProvenance(spec).runtimeBacked, false);
  const env = applyCliRuntimeLaunchProvenanceEnv({ cliLaunchSpec: spec, env: { HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1' } });
  assert.equal(env.HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED, undefined);
  assert.equal(env.HAPPIER_CLI_SUBPROCESS_ENTRYPOINT, spec.entrypoint);
  assert.equal(env.HAPPIER_CLI_SUBPROCESS_PREFER_TSX, '0');
});

test('runtime launch refuses to invent a missing service entrypoint in a component snapshot', () => {
  const snapshot = { snapshotPath: '/tmp/server-only', daemonDistClosureFingerprint: '1111111111111111',
    manifest: { source: { serverComponent: 'happier-server-light' }, components: {} } };
  assert.throws(() => resolveServerRuntimeLaunchSpec({ serverComponent: 'happier-server-light', snapshot }), /server.*entrypoint/);
  assert.throws(() => resolveCliRuntimeLaunchSpec({ snapshot }), /daemon.*entrypoint/);
});

test('resolveCliRuntimeLaunchSpec returns a runtime binary command from the snapshot', () => {
  const resolved = resolveCliRuntimeLaunchSpec({
    snapshot: {
      snapshotPath: '/tmp/stack/runtime/builds/snap-1',
      daemonDistClosureFingerprint: '1111111111111111',
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
    runtimeBacked: true,
    daemonDistClosureFingerprint: '1111111111111111',
  });
});

test('runtime CLI provenance is one canonical shape for daemon options and nested CLI environment', () => {
  const launchSpec = resolveCliRuntimeLaunchSpec({
    snapshot: {
      snapshotPath: '/tmp/runtime/builds/snap-a',
      launchPath: '/tmp/runtime/builds/snap-a',
      daemonDistClosureFingerprint: 'abcdef1234567890',
      manifest: {
        components: { daemon: { entrypoint: 'cli/happier' } },
      },
    },
  });

  assert.deepEqual(resolveCliRuntimeLaunchProvenance(launchSpec), {
    runtimeBacked: true,
    admittedDistClosureFingerprint: 'abcdef1234567890',
    distEntrypoint: '/tmp/runtime/builds/snap-a/cli/package-dist/index.mjs',
  });
  const projected = applyCliRuntimeLaunchProvenanceEnv({ env: {}, cliLaunchSpec: launchSpec });
  assert.equal(projected.HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED, '1');
  assert.equal(projected.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT, '/tmp/runtime/builds/snap-a/cli/package-dist/index.mjs');
  assert.equal(projected.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT, 'abcdef1234567890');
});

test('source CLI provenance clears inherited runtime-backed subprocess policy', () => {
  const projected = applyCliRuntimeLaunchProvenanceEnv({
    env: {
      HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: '1',
      HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT: '/stale/runtime/index.mjs',
      HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT: 'abcdef1234567890',
      KEEP_ME: 'yes',
    },
    cliLaunchSpec: null,
  });
  assert.deepEqual(resolveCliRuntimeLaunchProvenance(null), {
    runtimeBacked: false,
    admittedDistClosureFingerprint: null,
    distEntrypoint: '',
  });
  assert.equal(projected.HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED, undefined);
  assert.equal(projected.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT, undefined);
  assert.equal(projected.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT, undefined);
  assert.equal(projected.KEEP_ME, 'yes');
});

test('resolveServerRuntimeLaunchSpec returns the runtime server binary command from the snapshot', () => {
  const resolved = resolveServerRuntimeLaunchSpec({
    serverComponent: 'happier-server-light',
    snapshot: {
      snapshotPath: '/tmp/stack/runtime/builds/snap-1',
      manifest: {
        source: { serverComponent: 'happier-server-light' },
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
    migration: { mode: 'in-process' },
  });
});

test('resolveServerRuntimeLaunchSpec rejects a snapshot without admitted server component metadata', () => {
  assert.throws(
    () => resolveServerRuntimeLaunchSpec({
      serverComponent: 'happier-server',
      snapshot: { snapshotPath: '/tmp/stack/runtime/builds/snap-1' },
    }),
    (error) => error.code === 'ERUNTIMESERVERCOMPONENTUNAVAILABLE'
      && error.reason === 'missing_admitted_server_component',
  );
});

test('resolveServerRuntimeLaunchSpec rejects both requested/admitted server component mismatch directions', () => {
  for (const [requested, admitted] of [
    ['happier-server-light', 'happier-server'],
    ['happier-server', 'happier-server-light'],
  ]) {
    assert.throws(
      () => resolveServerRuntimeLaunchSpec({
        serverComponent: requested,
        snapshot: {
          snapshotPath: '/tmp/stack/runtime/builds/snap-1',
          manifest: {
            source: { serverComponent: admitted },
            components: { server: { entrypoint: 'server/happier-server' } },
          },
        },
      }),
      (error) => error.code === 'ERUNTIMESERVERCOMPONENTMISMATCH'
        && error.requestedServerComponent === requested
        && error.admittedServerComponent === admitted,
      `${requested} must reject admitted ${admitted}`,
    );
  }
});

test('resolveServerRuntimeLaunchSpec derives the Windows full-server migration executable beside the admitted entrypoint', () => {
  const resolved = resolveServerRuntimeLaunchSpec({
    serverComponent: 'happier-server',
    dbProvider: 'postgres',
    snapshot: {
      snapshotPath: 'C:\\runtime\\builds\\snap-1',
      manifest: {
        source: { serverComponent: 'happier-server' },
        components: {
          server: { entrypoint: 'server/happier-server.exe' },
        },
      },
    },
  });

  assert.equal(resolved.migration.command, 'C:\\runtime\\builds\\snap-1/server/happier-server-migrate.exe');
  assert.deepEqual(resolved.migration.args, []);
  assert.equal(resolved.migration.cwd, 'C:\\runtime\\builds\\snap-1/server');
});

test('resolveServerRuntimeLaunchSpec derives packaged migrations from the provider, not the preset', () => {
  const snapshot = {
    snapshotPath: '/tmp/stack/runtime/builds/snap-1',
    manifest: {
      source: { serverComponent: 'happier-server-light' },
      components: { server: { entrypoint: 'server/happier-server' } },
    },
  };

  for (const dbProvider of ['postgres', 'mysql', 'pglite']) {
    const resolved = resolveServerRuntimeLaunchSpec({
      serverComponent: 'happier-server-light',
      dbProvider,
      snapshot,
    });
    assert.equal(resolved.migration.mode, 'packaged');
    assert.equal(resolved.migration.command, '/tmp/stack/runtime/builds/snap-1/server/happier-server-migrate');
  }

  assert.deepEqual(resolveServerRuntimeLaunchSpec({
    serverComponent: 'happier-server-light',
    dbProvider: 'sqlite',
    snapshot,
  }).migration, { mode: 'in-process' });
  assert.deepEqual(resolveServerRuntimeLaunchSpec({
    serverComponent: 'happier-server-light',
    dbProvider: 'postgres',
    migrationsEnabled: false,
    snapshot,
  }).migration, { mode: 'disabled' });
});

test('resolveCliRuntimeLaunchSpec rejects a manifest entrypoint that escapes the snapshot root', () => {
  assert.throws(() => resolveCliRuntimeLaunchSpec({
    snapshot: {
      snapshotPath: '/tmp/stack/runtime/builds/snap-1',
      daemonDistClosureFingerprint: '1111111111111111',
      manifest: {
        components: {
          daemon: { entrypoint: '../outside-cli' },
        },
      },
    },
  }), /daemon entrypoint/);
});

test('resolveServerRuntimeLaunchSpec rejects a manifest entrypoint that escapes the snapshot root', () => {
  assert.throws(() => resolveServerRuntimeLaunchSpec({
    serverComponent: 'happier-server',
    dbProvider: 'postgres',
    snapshot: {
      snapshotPath: '/tmp/stack/runtime/builds/snap-1',
      manifest: {
        source: { serverComponent: 'happier-server' },
        components: {
          server: { entrypoint: '../outside-server' },
        },
      },
    },
  }), error => error.code === 'ERUNTIMESERVERCOMPONENTUNAVAILABLE' && error.reason === 'missing_admitted_server_entrypoint');
});
