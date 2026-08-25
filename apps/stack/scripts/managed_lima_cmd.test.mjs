import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { runNodeCapture } from './testkit/core/run_node_capture.mjs';

const script = new URL('./managed_lima.mjs', import.meta.url).pathname;

test('managed Lima doctor returns structured drift and a failing exit status without mutation', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-managed-lima-cmd-' });
  const bin = fixture.path('bin');
  await mkdir(bin, { recursive: true });
  await writeFile(fixture.path('bin', 'uname'), '#!/bin/sh\necho Darwin\n', 'utf8');
  await writeFile(fixture.path('bin', 'limactl'), [
    '#!/bin/sh',
    'if [ "$1" = "--version" ]; then echo "limactl version 2.1.0"; exit 0; fi',
    'if [ "$1" = "list" ]; then',
    `  echo '${JSON.stringify({
      name: 'candidate', status: 'Running', vmType: 'qemu', arch: 'aarch64', cpus: 4,
      memory: 8 * 1024 ** 3, disk: 100 * 1024 ** 3, config: {},
    })}'`,
    '  exit 0',
    'fi',
    'echo "unexpected mutation: $*" >&2',
    'exit 91',
    '',
  ].join('\n'), 'utf8');
  await Promise.all([
    chmod(fixture.path('bin', 'uname'), 0o755),
    chmod(fixture.path('bin', 'limactl'), 0o755),
  ]);

  const result = await runNodeCapture([
    script, 'doctor', '--instance=candidate', '--profile=small', '--json',
  ], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });

  assert.equal(result.code, 1, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.drift.creation.some((entry) => entry.field === 'vmType'), true);
  assert.doesNotMatch(result.stderr, /unexpected mutation/);
});

test('managed Lima SSH config command publishes the retained local guest endpoint with strict file modes', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-managed-lima-ssh-cmd-' });
  const bin = fixture.path('bin');
  const source = fixture.path('lima', 'candidate', 'ssh.config');
  const output = fixture.path('published', 'candidate.conf');
  await mkdir(bin, { recursive: true });
  await mkdir(fixture.path('lima', 'candidate'), { recursive: true });
  await writeFile(source, [
    'Host lima-candidate',
    '  Hostname 127.0.0.1',
    '  Port 60022',
    '  User happier',
    '  IdentityFile /tmp/lima-user',
    '',
  ].join('\n'), 'utf8');
  await writeFile(fixture.path('bin', 'limactl'), [
    '#!/bin/sh',
    'if [ "$1" = "list" ]; then',
    `  echo '${JSON.stringify({ name: 'candidate', status: 'Running', sshConfigFile: source })}'`,
    '  exit 0',
    'fi',
    'exit 91',
    '',
  ].join('\n'), 'utf8');
  await chmod(fixture.path('bin', 'limactl'), 0o755);

  const result = await runNodeCapture([
    script, 'ssh-config', '--instance=candidate', `--output=${output}`, '--alias=happier-candidate', '--json',
  ], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ssh: 'happier-candidate', sshConfigFile: output });
});
