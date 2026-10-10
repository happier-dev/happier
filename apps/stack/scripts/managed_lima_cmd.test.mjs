import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import test from 'node:test';

import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { runNodeCapture } from './testkit/core/run_node_capture.mjs';

const script = new URL('./managed_lima.mjs', import.meta.url).pathname;

// limactl is the external boundary; the real CLI, profile and lifecycle owners run beneath it.
async function networkingFixture(t, { status = 'Running', networks = [], editFails = false } = {}) {
  const fixture = await createTempFixture(t, { prefix: 'hstack-lima-network-' });
  const bin = fixture.path('bin');
  const state = fixture.path('instance.json');
  const log = fixture.path('calls.jsonl');
  const instance = {
    name: 'candidate', status, vmType: 'vz', arch: 'aarch64', cpus: 14,
    memory: 72 * 1024 ** 3, disk: 640 * 1024 ** 3,
    config: { networks, ssh: { forwardAgent: false }, portForwards: [{ proto: 'any', ignore: true }],
      vmOpts: { vz: { diskImageFormat: 'asif' } } },
  };
  await mkdir(bin, { recursive: true });
  await writeFile(state, JSON.stringify(instance));
  await writeFile(fixture.path('bin', 'uname'), '#!/bin/sh\necho Darwin\n');
  await writeFile(fixture.path('bin', 'limactl'), [
    `#!${process.execPath}`,
    'const fs = require("node:fs");',
    `const state = ${JSON.stringify(state)}, log = ${JSON.stringify(log)};`,
    'const args = process.argv.slice(2); fs.appendFileSync(log, JSON.stringify(args) + "\\n");',
    'const instance = JSON.parse(fs.readFileSync(state));',
    'if (args[0] === "--version") { console.log("limactl version 2.1.0"); process.exit(0); }',
    'if (args[0] === "list") { console.log(JSON.stringify(instance)); process.exit(0); }',
    'if (args[0] === "stop") instance.status = "Stopped";',
    'else if (args[0] === "restart") instance.status = "Running";',
    'else if (args[0] === "edit") {',
    '  if (instance.status !== "Stopped") process.exit(92);',
    `  if (${editFails}) process.exit(93);`,
    '  const expression = args[args.indexOf("--set") + 1];',
    '  instance.config.networks = JSON.parse(expression.slice(".networks = ".length));',
    '} else process.exit(91);',
    'fs.writeFileSync(state, JSON.stringify(instance));',
  ].join('\n'));
  await Promise.all([chmod(fixture.path('bin', 'uname'), 0o755), chmod(fixture.path('bin', 'limactl'), 0o755)]);
  return {
    instance,
    run: (force) => runNodeCapture([script, 'network', 'apply', '--instance=candidate', '--json', ...(force ? ['--force'] : [])], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1' },
    }),
    read: async () => JSON.parse(await readFile(state, 'utf8')),
    mutations: async () => (await readFile(log, 'utf8')).trim().split('\n').map(JSON.parse)
      .filter((args) => ['stop', 'edit', 'restart', 'create', 'delete'].includes(args[0])),
  };
}

test('managed Lima network apply requires explicit restart permission without changing the VM', async (t) => {
  const fixture = await networkingFixture(t);
  const result = await fixture.run(false);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /--force/);
  assert.deepEqual(await fixture.read(), fixture.instance);
  assert.deepEqual(await fixture.mutations(), []);
});

test('managed Lima network apply stops, edits only networking, starts and is idempotent', async (t) => {
  const existing = { lima: 'shared', interface: 'custom0', macAddress: '52:55:55:01:02:03', metric: 300 };
  const fixture = await networkingFixture(t, { networks: [existing] });
  const result = await fixture.run(true);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).changed, true);
  const current = await fixture.read();
  assert.deepEqual(current, { ...fixture.instance, config: { ...fixture.instance.config,
    networks: [existing, { vzNAT: true }] } });
  const mutations = await fixture.mutations();
  assert.deepEqual(mutations.map((args) => args[0]), ['stop', 'edit', 'restart']);
  assert.equal(mutations[1].includes('--cpus'), false);
  const repeat = await fixture.run(false);
  assert.equal(repeat.code, 0, repeat.stderr);
  assert.equal(JSON.parse(repeat.stdout).changed, false);
  assert.deepEqual(await fixture.mutations(), mutations);
});

test('network apply corrects native NAT route priority without replacing its interface identity', async (t) => {
  const native = { vzNAT: true, interface: 'lima0', macAddress: '52:55:55:01:02:03', metric: 250 };
  const fixture = await networkingFixture(t, { status: 'Stopped', networks: [native] });
  const result = await fixture.run(true);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual((await fixture.read()).config.networks, [{ ...native, metric: 100 }]);
  assert.deepEqual((await fixture.mutations()).map((args) => args[0]), ['edit', 'restart']);
});

test('failed network edit leaves the retained VM stopped and reports failure', async (t) => {
  const fixture = await networkingFixture(t, { editFails: true });
  const result = await fixture.run(true);
  assert.equal(result.code, 1);
  assert.equal((await fixture.read()).status, 'Stopped');
  assert.deepEqual((await fixture.mutations()).map((args) => args[0]), ['stop', 'edit']);
});

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
