import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { runNodeCapture } from './testkit/core/run_node_capture.mjs';

const script = new URL('./host.mjs', import.meta.url).pathname;
const launcher = new URL('../bin/hstack.mjs', import.meta.url).pathname;

test('host status reports an absent candidate without creating or starting a VM', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-host-status-' });
  const result = await runNodeCapture([script, 'status', '--json'], {
    env: {
      ...process.env,
      HAPPIER_STACK_HOME_DIR: fixture.path('home'),
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    configured: false,
    authoritative: false,
    activation: null,
    doctor: null,
  });
});

test('host exec uses only an explicitly configured candidate and preserves command arguments', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-host-exec-' });
  const home = fixture.path('home');
  const bin = fixture.path('bin');
  const log = fixture.path('limactl.log');
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(fixture.path('mirror'), { recursive: true });
  await writeFile(fixture.path('bin', 'uname'), '#!/bin/sh\necho Darwin\n', 'utf8');
  const instance = {
    name: 'candidate', status: 'Running', vmType: 'vz', arch: 'aarch64',
    cpus: 8, memory: 16 * 1024 ** 3, disk: 160 * 1024 ** 3,
    config: {
      mounts: [],
      vmOpts: { vz: { diskImageFormat: 'raw', rosetta: { enabled: false, binfmt: false } } },
      ssh: { forwardAgent: false },
      containerd: { user: false, system: false },
      portForwards: [
        { guestPortRange: [52005, 54004], hostPortRange: [52005, 54004] },
        { guestPortRange: [18081, 20080], hostPortRange: [18081, 20080] },
      ],
    },
  };
  await writeFile(fixture.path('bin', 'limactl'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
    'if [ "$1" = "--version" ]; then echo "limactl version 2.1.0"; exit 0; fi',
    `if [ "$1" = "list" ]; then echo '${JSON.stringify(instance)}'; exit 0; fi`,
    'exit 0',
    '',
  ].join('\n'), 'utf8');
  await Promise.all([
    chmod(fixture.path('bin', 'uname'), 0o755),
    chmod(fixture.path('bin', 'limactl'), 0o755),
  ]);
  await writeFile(fixture.path('home', 'execution-host.json'), `${JSON.stringify({
    version: 1,
    mode: 'managed-lima',
    activation: 'candidate',
    instance: 'candidate',
    limaHome: fixture.path('lima'),
    profile: 'small',
    guestWorkspaceDir: '/home/happier/workspace',
    mirrorWorkspaceDir: fixture.path('mirror'),
  })}\n`, 'utf8');

  const result = await runNodeCapture([
    script, 'exec', '--guest-cwd=/home/happier/workspace/dev', '--', 'rg', 'needle', 'path with spaces',
  ], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HAPPIER_STACK_HOME_DIR: home,
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });

  assert.equal(result.code, 0, result.stderr);
  const calls = await readFile(log, 'utf8');
  assert.match(calls, /shell --workdir \/home\/happier\/workspace\/dev candidate -- rg needle path with spaces/);
  assert.doesNotMatch(calls, /create|delete/);
});

test('hstack registry exposes the host controller without requiring workspace admission', async () => {
  const result = await runNodeCapture([launcher, '--help'], {
    env: {
      ...process.env,
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /hstack host setup\|mirror \[status\|sync\|stop\]\|status\|doctor\|start\|stop\|shell\|exec/);
});

test('host mirror status inspects continuous candidate sync without touching the VM', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-host-mirror-status-' });
  const home = fixture.path('home');
  const bin = fixture.path('bin');
  await mkdir(fixture.path('home', 'execution-host-candidate'), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(fixture.path('home', 'execution-host.json'), `${JSON.stringify({
    version: 1,
    mode: 'managed-lima',
    activation: 'candidate',
    instance: 'candidate',
    limaHome: fixture.path('lima'),
    profile: 'small',
    guestWorkspaceDir: '/home/happier/workspace',
    mirrorWorkspaceDir: fixture.path('mirror'),
  })}\n`);
  await writeFile(
    fixture.path('home', 'execution-host-candidate', 'state.v1.json'),
    `${JSON.stringify({
      version: 1,
      activation: 'candidate',
      authoritative: false,
      sourceDir: '/Users/dev/happier/dev',
      guestRepositoryDir: '/home/happier/workspace/dev',
      capture: { head: 'a'.repeat(40), refCount: 1, refsDigest: '0'.repeat(64), worktreeHeadCount: 1 },
    })}\n`,
  );
  await writeFile(fixture.path('bin', 'mutagen'), [
    '#!/bin/sh',
    'if [ "$1 $2" = "sync list" ]; then',
    '  echo \'[{"name":"happier-execution--host--candidate","status":"watching","successfulCycles":1}]\'',
    '  exit 0',
    'fi',
    'exit 9',
    '',
  ].join('\n'));
  await chmod(fixture.path('bin', 'mutagen'), 0o755);

  const result = await runNodeCapture([script, 'mirror', 'status', '--json'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HAPPIER_STACK_HOME_DIR: home,
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status.state, 'ready');
});

test('active execution profile delegates an ordinary hstack command before local workspace admission', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-host-active-' });
  const home = fixture.path('home');
  const bin = fixture.path('bin');
  const log = fixture.path('limactl.log');
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(fixture.path('mirror'), { recursive: true });
  await writeFile(fixture.path('bin', 'uname'), '#!/bin/sh\necho Darwin\n', 'utf8');
  const instance = {
    name: 'candidate', status: 'Running', vmType: 'vz', arch: 'aarch64',
    cpus: 8, memory: 16 * 1024 ** 3, disk: 160 * 1024 ** 3,
    config: {
      mounts: [],
      vmOpts: { vz: { diskImageFormat: 'raw', rosetta: { enabled: false, binfmt: false } } },
      ssh: { forwardAgent: false },
      containerd: { user: false, system: false },
      portForwards: [
        { guestPortRange: [52005, 54004], hostPortRange: [52005, 54004] },
        { guestPortRange: [18081, 20080], hostPortRange: [18081, 20080] },
      ],
    },
  };
  await writeFile(fixture.path('bin', 'limactl'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
    'if [ "$1" = "--version" ]; then echo "limactl version 2.1.0"; exit 0; fi',
    `if [ "$1" = "list" ]; then echo '${JSON.stringify(instance)}'; exit 0; fi`,
    'if [ "$1" = "shell" ]; then',
    '  case "$*" in *"timeout 5 loginctl"*) exit 0 ;; esac',
    '  exit 23',
    'fi',
    'exit 0',
    '',
  ].join('\n'), 'utf8');
  await Promise.all([
    chmod(fixture.path('bin', 'uname'), 0o755),
    chmod(fixture.path('bin', 'limactl'), 0o755),
  ]);
  await writeFile(fixture.path('home', 'execution-host.json'), `${JSON.stringify({
    version: 1,
    mode: 'managed-lima',
    activation: 'active',
    instance: 'candidate',
    limaHome: fixture.path('lima'),
    profile: 'small',
    guestWorkspaceDir: '/home/happier/workspace',
    mirrorWorkspaceDir: fixture.path('mirror'),
  })}\n`, 'utf8');

  const result = await runNodeCapture([launcher, 'where', '--json'], {
    cwd: fixture.path('mirror'),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HAPPIER_STACK_HOME_DIR: home,
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });

  assert.equal(result.code, 23, result.stderr);
  assert.match(await readFile(log, 'utf8'), /shell --workdir \/home\/happier\/workspace candidate -- env HAPPIER_STACK_EXECUTION_HOST_REENTRY=1/);
});
