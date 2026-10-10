import assert from 'node:assert/strict';
import { once } from 'node:events';
import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { installNativeAdmissionFixture } from './testkit/core/native_admission_fixture.mjs';
import { buildStackHarnessEnv, writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { spawnTestProcess } from './testkit/core/spawn_test_process.mjs';
import { renderNativeExecutionProjection } from './utils/dev_targets/native_execution_projection.mjs';

async function fixture(t) {
  const { root } = await createTempFixture(t, { prefix: 'hstack-atomic-parse-' });
  await mkdir(`/tmp/happier-sync-control-${process.getuid()}${root}/mutagen/hstack-control`, { recursive: true });
  t.after(() => rm(`/tmp/happier-sync-control-${process.getuid()}${root}`, { recursive: true, force: true }));
  const { launcher } = await installNativeAdmissionFixture({ root });
  const checkout = join(root, 'native-owner');
  const targets = join(checkout, 'apps/stack/scripts/utils/dev_targets');
  const custody = join(targets, 'remote_execution_custody.sh');
  const control = join(dirname(launcher), 'hstack-dev-target-control');
  await copyFile(new URL('./utils/dev_targets/native_sync_readiness.sh', import.meta.url), join(targets, 'native_sync_readiness.sh'));
  const configPath = join(root, 'dev-targets.json');
  const config = {
    version: 3,
    targets: [{ name: 'fixture', platform: 'posix', ssh: 'fixture-host', repoDir: checkout, cliHomeDir: root }],
    runtimePlacement: { server: { mode: 'local' }, expo: { mode: 'local' }, daemon: { mode: 'local' } },
    commandExecution: { mode: 'auto', targets: ['fixture'], includeLocal: false, fallback: 'error' },
  };
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(join(root, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(config, { repoRoot: checkout }));
  // Only host telemetry and the SSH/Mutagen transports are substituted. Both
  // the launcher and the command's real remote custody lifecycle execute.
  writeFakeBin({ root, name: 'uname', content: '#!/bin/sh\nprintf "Darwin\\n"\n' });
  writeFakeBin({ root, name: 'systemctl', content: '#!/bin/sh\nexit 1\n' });
  writeFakeBin({ root, name: 'mutagen', content: '#!/bin/sh\nif [ "$2" = list ]; then printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"; fi\n' });
  writeFakeBin({ root, name: 'ssh', content: `#!/bin/sh
case "$*" in
  *getconf*) printf '8 0.1 0.9 22000000 20 0 28000000 30000000 0 0 0 0 0 0 0 linux\\n' ;;
  *"&& command -v "*|*-O\\ check*|*-MNf*|*" cancel "*) exit 0 ;;
  *remote_execution_custody.sh*) exec /bin/bash "$TEST_CUSTODY" run "$TEST_PID_FILE" atomic-payload /bin/sh "$TEST_PAYLOAD" ;;
  *) exit 1 ;;
esac
` });
  const payload = join(root, 'slow-payload.sh');
  const release = join(root, 'release');
  await writeFile(payload, '#!/bin/sh\nprintf "payload-ready\\n"\nwhile [ ! -e "$TEST_RELEASE" ]; do sleep 0.01; done\nexit 37\n');
  const env = buildStackHarnessEnv({
    baseEnv: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('HAPPIER_') && !key.startsWith('HSTACK_'))),
    binDirs: [join(root, 'bin')],
    extraEnv: {
      HOME: root, TMPDIR: root, XDG_RUNTIME_DIR: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath, HAPPIER_STACK_HOME_DIR: root, HAPPIER_STACK_STORAGE_DIR: root,
      MUTAGEN_DATA_DIRECTORY: join(root, 'mutagen/data'),
      TEST_CUSTODY: custody, TEST_PID_FILE: join(root, 'remote-exec/atomic-payload.pid'),
      TEST_PAYLOAD: payload, TEST_RELEASE: release,
    },
  });
  return { root, launcher, custody, control, payload, release, options: { cwd: checkout, env, stdio: ['ignore', 'pipe', 'pipe'] } };
}

function invocation(f, entry, { direct = false } = {}) {
  if (entry === 'launcher') return ['/bin/sh', [f.launcher, ...(direct ? ['--local'] : []), '--', 'sh', f.payload]];
  if (entry === 'custody') return ['/bin/bash', [f.custody, 'run', f.options.env.TEST_PID_FILE, 'atomic-payload', '/bin/sh', f.payload]];
  return ['/bin/sh', [f.control, ...(direct ? ['--'] : ['--locked-sync-flush', 'fixture', '0', '--']), '/bin/sh', f.payload]];
}

function start(f, entry, options) {
  const [command, args] = invocation(f, entry, options);
  const child = spawnTestProcess(command, args, f.options);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const completed = once(child, 'close');
  return { child, completed, stderr: () => stderr };
}

for (const entry of ['launcher', 'custody', 'control']) {
  for (const replacement of ['in-place', 'atomic-rename']) {
    test(`${entry} preserves a running payload across ${replacement} source replacement`, { skip: process.platform === 'win32', timeout: 15000 }, async t => {
      const f = await fixture(t);
      const path = f[entry];
      const original = await readFile(path, 'utf8');
      // Force the final status statement beyond shell read-ahead buffers without
      // changing behavior, so an in-place edit cannot pass by buffered luck.
      const exit = original.lastIndexOf('\nexit "');
      if (entry !== 'control') {
        assert.ok(exit >= 0);
        await writeFile(path, original.slice(0, exit) + '\n#' + ' padding'.repeat(8192) + '\n' + original.slice(exit));
      }
      const running = start(f, entry);
      try {
        const output = await Promise.race([
          once(running.child.stdout, 'data').then(([chunk]) => String(chunk)),
          running.completed.then(result => assert.fail(`payload never started: ${result}; ${running.stderr()}`)),
        ]);
        assert.equal(output, 'payload-ready\n', running.stderr());
        // A valid new program with different offsets. Reading its tail would
        // replace the payload's status with 99; atomic rename must also be safe.
        const changed = '#!/bin/sh\n#' + ' rewritten'.repeat(32768) + '\nexit 99\n';
        if (replacement === 'in-place') await writeFile(path, changed);
        else {
          await writeFile(`${path}.next`, changed, { mode: 0o755 });
          await rename(`${path}.next`, path);
        }
        await writeFile(f.release, '');
        assert.deepEqual(await running.completed, [37, null], running.stderr());
      } finally {
        await writeFile(f.release, '');
        await running.completed;
      }
    });
  }

  test(`${entry} parses the entire program before starting its payload`, { skip: process.platform === 'win32', timeout: 15000 }, async t => {
    const f = await fixture(t);
    const source = await readFile(f[entry], 'utf8');
    // Corrupt the program's tail inside its parse group when one is present.
    const tail = source.endsWith('\n}\n') ? source.length - 2 : source.length;
    await writeFile(f[entry], source.slice(0, tail) + '\nif\n' + source.slice(tail));
    await writeFile(f.release, '');
    const running = start(f, entry, { direct: true });
    let stdout = '';
    running.child.stdout.on('data', chunk => { stdout += chunk; });
    const [code, signal] = await running.completed;
    assert.notEqual(code, 0);
    assert.equal(signal, null);
    assert.equal(stdout, '', 'payload ran before the syntax error was parsed');
    assert.match(running.stderr(), /[Ss]yntax error|unexpected/);
  });
}
