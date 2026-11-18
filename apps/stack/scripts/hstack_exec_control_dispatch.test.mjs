import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');

async function writeExecutable(path, contents) {
  await writeFile(path, contents, 'utf8');
  await chmod(path, 0o755);
}

function waitForText(state, text, timeoutMs = 5_000) {
  if (state.output.includes(text)) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const started = Date.now();
    const check = () => {
      if (state.output.includes(text)) {
        resolvePromise();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`timed out waiting for ${JSON.stringify(text)}; output=${JSON.stringify(state.output)} error=${JSON.stringify(state.error)}`));
        return;
      }
      setTimeout(check, 10);
    };
    check();
  });
}

test('control dispatch keeps the framed remote script writer open for later input', { timeout: 15_000 }, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-control-dispatch-' });
  const bin = fixture.path('bin');
  const machineHome = fixture.path('machine-home');
  const stackStorage = fixture.path('stacks');
  await mkdir(bin, { recursive: true });
  await mkdir(machineHome, { recursive: true });
  await mkdir(stackStorage, { recursive: true });
  await mkdir(fixture.path('stacks/mutagen/data'), { recursive: true });
  await mkdir(fixture.path('stacks/mutagen/openssh'), { recursive: true });

  await writeExecutable(fixture.path('bin/mutagen'), `#!/bin/sh
case "$*" in
  sync\\ list*) printf '%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0|WatchModeWatch|WatchModeWatch|proj\\n' "$3" ;;
esac
exit 0
`);
  await writeExecutable(fixture.path('bin/ssh'), `#!/bin/sh
case "$*" in
  *getconf*) printf '8 12 0.9 22000000 20 0 28000000 30000000 0 0 0 0 0 0 linux\\n' ;;
  *'&& command -v '*) exit 0 ;;
  *'-O check'*) exit 1 ;;
  *'-MNf'*) exit 1 ;;
  *) remote_command=; for argument do remote_command=$argument; done; exec /bin/bash -lc "$remote_command" ;;
esac
`);

  const configPath = fixture.path('config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, targets: [] }), 'utf8');
  const projectionPath = fixture.path('dev-target-exec-v1.sh');
  await writeFile(projectionPath, `projection_config_path=${JSON.stringify(configPath)}
projection_mutagen_data_dir=${JSON.stringify(fixture.path('stacks/mutagen/data'))}
projection_mutagen_ssh_path=${JSON.stringify(fixture.path('stacks/mutagen/openssh'))}
HSTACK_EXEC_PROJECTION_VERSION='2'
projection_repo_root=${JSON.stringify(repoRoot)}
command_mode='auto'
include_local='0'
fallback_mode='error'
load_ttl_seconds='300'
unavailable_ttl_seconds='120'
target_count='1'
target_1_name='fake'
target_1_ssh='fake-host'
target_1_ssh_config=''
target_1_repo_dir=${JSON.stringify(repoRoot)}
target_1_cli_home=${JSON.stringify(machineHome)}
target_1_remote_path='/usr/bin:/bin'
`, 'utf8');

  const child = spawn(join(repoRoot, 'apps/stack/bin/hstack-exec'), [
    '--control-stdin', '--target=fake', '--', 'node', '-e',
    'console.log("READY"); process.stdin.once("data", chunk => { console.log("BODY:" + chunk.toString().trim()); process.exit(0); }); setInterval(() => {}, 1000);',
  ], {
    cwd: repoRoot,
    env: (() => {
      const { HAPPIER_DEV_TARGET_EXECUTION, HAPPIER_HSTACK_EXECUTION, ...parentEnv } = process.env;
      return {
      ...parentEnv,
      CI: '1',
      HOME: fixture.root,
      PATH: `${bin}:/usr/bin:/bin:${process.env.PATH ?? ''}`,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: stackStorage,
      TMPDIR: fixture.root,
      };
    })(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => {
    if (!child.killed && child.exitCode === null) child.kill('SIGTERM');
  });

  const state = { output: '', error: '' };
  child.stdout.on('data', chunk => { state.output += chunk; });
  child.stderr.on('data', chunk => { state.error += chunk; });
  await waitForText(state, 'READY\n');
  child.stdin.write('reload-request\n');
  await waitForText(state, 'BODY:reload-request\n');
  child.stdin.end();
  const [status, signal] = await new Promise(resolvePromise => child.once('close', (...args) => resolvePromise(args)));
  assert.equal(signal, null, state.error);
  assert.equal(status, 130, state.error);
});
