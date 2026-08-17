import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { createRuntimeSnapshotFixture } from '../testkit/runtime_snapshot_testkit.mjs';
import { resolveStackDaemonCommandContext } from './stack_daemon_command.mjs';

test('stack daemon command retains admitted runtime provenance in its composed launch context', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'daemon-command-runtime' });
  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_RUNTIME_MODE: 'require',
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_SERVER_PORT: '4102',
  };

  const context = await resolveStackDaemonCommandContext({
    rootDir: fixture.root,
    stackName: fixture.stackName,
    env,
    identity: 'default',
    argv: [],
  });

  assert.deepEqual(context.runtimeProvenance, {
    runtimeBacked: true,
    admittedDistClosureFingerprint: context.runtimeProvenance.admittedDistClosureFingerprint,
    distEntrypoint: join(fixture.snapshotDir, 'cli', 'package-dist', 'index.mjs'),
  });
  assert.match(context.runtimeProvenance.admittedDistClosureFingerprint, /^[a-f0-9]{16}$/);
  assert.equal(context.cliEntrypoint.startsWith(fixture.snapshotDir), true);
  assert.equal(context.envForIdentity.HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED, '1');
  assert.equal(context.envForIdentity.HAPPIER_CLI_SUBPROCESS_DIST_ENTRYPOINT, join(fixture.snapshotDir, 'cli', 'package-dist', 'index.mjs'));
  assert.equal(
    context.envForIdentity.HAPPIER_CLI_SUBPROCESS_DAEMON_DIST_CLOSURE_FINGERPRINT,
    context.runtimeProvenance.admittedDistClosureFingerprint,
  );
});

test('stack daemon command follows an active source-backed runtime before required stack env mode', async (t) => {
  const fixture = await createRuntimeSnapshotFixture(t, { stackName: 'daemon-command-source' });
  const env = {
    ...process.env,
    HAPPIER_STACK_STACK: fixture.stackName,
    HAPPIER_STACK_STORAGE_DIR: fixture.storageDir,
    HAPPIER_STACK_RUNTIME_MODE: 'require',
    HAPPIER_STACK_ENV_FILE: join(fixture.stackDir, 'env'),
    HAPPIER_STACK_SERVER_PORT: '4102',
  };

  const context = await resolveStackDaemonCommandContext({
    rootDir: fixture.root,
    stackName: fixture.stackName,
    env,
    identity: 'default',
    argv: [],
    activeRuntimeState: { runtimeSnapshotId: null },
  });

  assert.deepEqual(context.runtimeProvenance, {
    runtimeBacked: false,
    admittedDistClosureFingerprint: null,
    distEntrypoint: '',
  });
  assert.equal(context.cliEntrypoint, '');
  assert.equal(context.envForIdentity.HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED, undefined);
});
