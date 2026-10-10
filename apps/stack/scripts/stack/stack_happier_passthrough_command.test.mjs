import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import * as stackHappierPassthrough from './stack_happier_passthrough_command.mjs';
import { createTempFixture } from '../testkit/core/temp_fixture.mjs';
import { createStackHappierCliCommandFixture } from '../testkit/stack_happier_cli_command_testkit.mjs';
import { buildStackHarnessEnv, writeFakeBin } from '../testkit/core/fake_bin_harness.mjs';
import { runNodeCapture } from '../testkit/stack_script_command_testkit.mjs';
import { fileURLToPath } from 'node:url';
import { buildStubHappierServerSetSource } from '../testkit/core/stub_happier_cli_server_set.mjs';

const { resolveStackHappierPassthroughInvocation } = stackHappierPassthrough;

test('stack happier dispatches to the recorded daemon host with remote identity and preserves SSH output and status', async t => {
  const fixture = await createStackHappierCliCommandFixture(t, {
    prefix: 'hstack-remote-cli-',
    distIndexScript: 'console.log("LOCAL CLI");',
  });
  const target = { name: 'nl1', platform: 'posix', ssh: 'qa-daemon',
    sshConfigFile: '/controller/ssh.config', repoDir: '/remote/source repo', cliHomeDir: '/remote/state' };
  await writeFile(join(fixture.storageDir, fixture.stackName, 'dev-targets.json'), JSON.stringify({
    version: 3, targets: [target], runtimePlacement: { daemon: { mode: 'prefer-target', target: 'nl1', fallback: 'local' } },
  }));
  await writeFile(join(fixture.storageDir, fixture.stackName, 'stack.runtime.json'), JSON.stringify({
    version: 1, stackName: fixture.stackName, ownerPid: process.pid,
    placement: { daemon: 'nl1' }, remoteTargets: { nl1: { services: { daemon: true }, runtimeMode: 'source-snapshot' } },
  }));
  // SSH is the process/transport boundary; placement, identity and command builders stay real.
  const ssh = writeFakeBin({ root: fixture.root, name: 'ssh', content:
    '#!/usr/bin/env node\nconsole.log(JSON.stringify(process.argv.slice(2))); console.error("REMOTE STDERR"); process.exit(7);\n' });
  const result = await runNodeCapture([fileURLToPath(new URL('../../bin/hstack.mjs', import.meta.url)),
    'stack', 'happier', fixture.stackName, '--identity=account-b', '--runtime', '--',
    'actions', 'get', 'widgets.group.create', '--json'], {
    cwd: fixture.root, env: buildStackHarnessEnv({ baseEnv: fixture.baseEnv, binDirs: [ssh.binDir],
      // A routed test runner is on a worker; the fixture represents its controller.
      extraEnv: { HAPPIER_DEV_TARGET_EXECUTION: '' } }),
  });
  assert.equal(result.code, 7, `stdout=${result.stdout}\nstderr=${result.stderr}`);
  assert.match(result.stderr, /REMOTE STDERR/);
  const args = JSON.parse(result.stdout);
  assert.ok(args.includes('-T'));
  assert.ok(args.includes('/controller/ssh.config'));
  assert.equal(args.at(-2), 'qa-daemon');
  const command = args.at(-1);
  assert.match(command, /stack happier/);
  assert.ok(command.includes(fixture.stackName));
  assert.ok(command.includes('/remote/state/stack-state/' + fixture.stackName + '/cli'));
  assert.ok(command.includes('--identity=account-b'));
  assert.ok(command.includes('--runtime'));
  assert.ok(command.includes('widgets.group.create'));
  assert.doesNotMatch(command, /stack (start|dev|new|stop)|stack env/);
});

test('stack happier keeps recorded local daemon placement despite a configured remote preference', async t => {
  const fixture = await createStackHappierCliCommandFixture(t, {
    prefix: 'hstack-local-cli-',
    distIndexScript: `const args = process.argv.slice(2); ${buildStubHappierServerSetSource()} console.log('LOCAL CLI');`,
  });
  await writeFile(join(fixture.storageDir, fixture.stackName, 'dev-targets.json'), JSON.stringify({
    version: 3, targets: [{ name: 'nl1', platform: 'posix', ssh: 'qa-daemon',
      repoDir: '/remote/repo', cliHomeDir: '/remote/state' }],
    runtimePlacement: { daemon: { mode: 'prefer-target', target: 'nl1', fallback: 'local' } },
  }));
  await writeFile(join(fixture.storageDir, fixture.stackName, 'stack.runtime.json'), JSON.stringify({
    version: 1, stackName: fixture.stackName, ownerPid: process.pid, placement: { daemon: 'local' }, runtimeSnapshotId: null,
  }));
  const ssh = writeFakeBin({ root: fixture.root, name: 'ssh', content: '#!/usr/bin/env node\nprocess.exit(7);\n' });
  const result = await runNodeCapture([fileURLToPath(new URL('../../bin/hstack.mjs', import.meta.url)),
    'stack', 'happier', fixture.stackName, '--', '--version'], {
    cwd: fixture.root, env: buildStackHarnessEnv({ baseEnv: fixture.baseEnv, binDirs: [ssh.binDir],
      extraEnv: { HAPPIER_DEV_TARGET_EXECUTION: '' } }),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'LOCAL CLI');
});

test('resolveStackHappierPassthroughInvocation strips spaced wrapper identity args when no separator is used', () => {
  const invocation = resolveStackHappierPassthroughInvocation({
    passthrough: ['--identity', 'account-b', '--json'],
  });

  assert.equal(invocation.identity, 'account-b');
  assert.deepEqual(invocation.childArgs, ['--json']);
});

test('resolveStackHappierPassthroughInvocation strips inline wrapper identity args when no separator is used', () => {
  const invocation = resolveStackHappierPassthroughInvocation({
    passthrough: ['--identity=account-b', '--json'],
  });

  assert.equal(invocation.identity, 'account-b');
  assert.deepEqual(invocation.childArgs, ['--json']);
});

test('resolveStackHappierPassthroughInvocation preserves child identity args after separator', () => {
  const invocation = resolveStackHappierPassthroughInvocation({
    passthrough: ['--identity=account-b', '--', '--identity', 'child-account', '--json'],
  });

  assert.equal(invocation.identity, 'account-b');
  assert.deepEqual(invocation.childArgs, ['--identity', 'child-account', '--json']);
});

test('resolveStackHappierPassthroughEntrypoint prefers the stack-pinned repo wrapper over the launcher root', async (t) => {
  const resolveStackHappierPassthroughEntrypoint =
    stackHappierPassthrough.resolveStackHappierPassthroughEntrypoint;
  assert.equal(typeof resolveStackHappierPassthroughEntrypoint, 'function');

  const fixture = await createTempFixture(t, { prefix: 'happier-passthrough-entrypoint-' });
  const fixtureRoot = fixture.root;
  const launcherRoot = join(fixtureRoot, 'launcher', 'apps', 'stack');
  const targetRepoRoot = join(fixtureRoot, 'target-repo');
  const targetStackRoot = join(targetRepoRoot, 'apps', 'stack');
  await mkdir(join(launcherRoot, 'scripts'), { recursive: true });
  await mkdir(join(targetRepoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(targetRepoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(targetRepoRoot, 'apps', 'server'), { recursive: true });
  await mkdir(join(targetStackRoot, 'bin'), { recursive: true });
  await writeFile(join(launcherRoot, 'scripts', 'happier.mjs'), 'export {};\n', 'utf-8');
  await writeFile(join(targetRepoRoot, 'apps', 'ui', 'package.json'), '{"name":"@happier-dev/app"}\n', 'utf-8');
  await writeFile(join(targetRepoRoot, 'apps', 'cli', 'package.json'), '{"name":"@happier-dev/cli"}\n', 'utf-8');
  await writeFile(join(targetRepoRoot, 'apps', 'server', 'package.json'), '{"name":"@happier-dev/server"}\n', 'utf-8');
  await writeFile(join(targetStackRoot, 'bin', 'happier.mjs'), 'export {};\n', 'utf-8');

  const resolved = resolveStackHappierPassthroughEntrypoint({
    rootDir: launcherRoot,
    env: {
      HAPPIER_STACK_REPO_DIR: targetRepoRoot,
    },
  });

  assert.deepEqual(resolved, {
    cwd: targetStackRoot,
    entrypoint: join(targetStackRoot, 'bin', 'happier.mjs'),
    source: 'stack-repo-wrapper',
  });
});
