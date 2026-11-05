// @happier-test-preparation source
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { writeFakeBin, buildStackHarnessEnv } from './testkit/core/fake_bin_harness.mjs';
import { buildNativeAdmissionFixtureEnv } from './testkit/core/native_admission_fixture.mjs';
import { renderNativeExecutionProjection } from './utils/dev_targets/native_execution_projection.mjs';

const repoRoot = resolve(import.meta.dirname, '../../..');

for (const longUnreserved of [0, 28000000]) {
  test(`AUTO ranks admission backlog without overruling immediate capacity, unreserved=${longUnreserved}`, async t => {
    const { root } = await createTempFixture(t, { prefix: 'hstack-placement-backlog-' });
    const stack = join(root, 'stack');
    await mkdir(stack);
    const config = { version: 3,
      targets: ['long', 'short'].map(name => ({ name, platform: 'posix', ssh: `${name}-host`,
        repoDir: repoRoot, cliHomeDir: join(root, name) })),
      commandExecution: { mode: 'auto', targets: ['long', 'short'], includeLocal: false, fallback: 'error' } };
    const configPath = join(stack, 'dev-targets.json');
    await writeFile(configPath, JSON.stringify(config));
    await writeFile(join(stack, 'dev-target-exec-v1.sh'), renderNativeExecutionProjection(config, { repoRoot }));
    const bin = (name, content) => writeFakeBin({ root, name, content });
    bin('node', `#!/bin/sh\ncase "$*" in *service_memory.mjs*) printf 'service 0\\n' ;; *) exec '${process.execPath}' "$@" ;; esac\n`);
    bin('uname', '#!/bin/sh\nprintf "Darwin\\n"\n');
    bin('systemctl', '#!/bin/sh\nexit 1\n');
    bin('date', '#!/bin/sh\ncase "$*" in +%s) printf "1700000000\\n" ;; *) exec /bin/date "$@" ;; esac\n');
    bin('mutagen', '#!/bin/sh\n[ "$2" != list ] || printf "%s|Watching|false|true|1|0/0|0/0|true|1|0/0|0/0|active|7|ok|0|0\\n" "$3"\n');
    // Only telemetry and transports are substituted. Samples reproduce the
    // observed fleet shape: more free RAM and lower CPU, but a much longer queue.
    bin('ssh', `#!/bin/sh
  case "$*" in
    *getconf*)
      printf 'probe\\n' >> "$PROBES"
      case "$*" in
        *long-host*) printf '48 27.36 0.39 22000000 20 0 102700000 263354188 0 0 0 0 0 0 0 linux ${longUnreserved} 0 118345467 250609664\\n' ;;
        *) printf '8 12 0.63 22000000 20 0 82765328 131348608 0 0 0 0 0 0 0 linux 0 0 101280777 26214400\\n' ;;
      esac ;;
    *"&& command -v "*|*-O\\ check*|*-MNf*) exit 0 ;;
    *) case "$*" in *long-host*) printf 'long\\n' ;; *) printf 'short\\n' ;; esac ;;
  esac
  `);
    const baseEnv = Object.fromEntries(Object.entries(buildNativeAdmissionFixtureEnv()).filter(([key]) =>
      !key.startsWith('HAPPIER_HEAVYWEIGHT_') && !key.startsWith('HAPPIER_HSTACK_') &&
      !['HAPPIER_DEV_TARGET_EXECUTION', 'HAPPIER_PREFERRED_EXECUTION', 'HAPPIER_TYPECHECK_DISPATCHED',
        'npm_node_execpath', 'npm_execpath'].includes(key)));
    const env = buildStackHarnessEnv({ baseEnv, binDirs: [join(root, 'bin')], extraEnv: {
      HOME: root, TMPDIR: root, XDG_RUNTIME_DIR: root, HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'), HAPPIER_STACK_HOME_DIR: root,
      HAPPIER_STACK_REPO_DIR: repoRoot, HAPPIER_STACK_ENV_FILE: '', HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
      PROBES: join(root, 'probes'),
    } });
    const invoke = () => spawnSync('/bin/sh', [join(repoRoot, 'apps/stack/bin/hstack-exec'), '--',
      './apps/stack/bin/hstack-exec', '--heavyweight-admission', '--class=focused-validation',
      '--machine=worker', '--', 'probe-command'], { cwd: repoRoot, env, encoding: 'utf8' });
    for (const cached of [false, true]) {
      const result = invoke();
      assert.equal(result.status, 0, result.stderr);
      // Admission publishes the capacity a new request can use. Queued work
      // blocked on publication has no reservation; do not overrule that budget.
      const expected = longUnreserved > 0 ? 'long\n' : 'short\n';
      assert.equal(result.stdout, expected, `cached=${cached}: use immediate capacity, then admission backlog, then CPU load`);
    }
    assert.equal((await readFile(env.PROBES, 'utf8')).trim().split('\n').length, 2,
      'one load observation per worker serves both dispatches');
    const light = spawnSync('/bin/sh', [join(repoRoot, 'apps/stack/bin/hstack-exec'), '--', 'rg', 'source'],
      { cwd: repoRoot, env, encoding: 'utf8' });
    assert.equal(light.status, 0, light.stderr);
    assert.equal(light.stdout, 'long\n', 'heavyweight queues do not change lightweight placement');
    const pinned = spawnSync('/bin/sh', [join(repoRoot, 'apps/stack/bin/hstack-exec'), '--target=long', '--',
      './apps/stack/bin/hstack-exec', '--heavyweight-admission', '--class=focused-validation',
      '--machine=worker', '--', 'probe-command'], { cwd: repoRoot, env, encoding: 'utf8' });
    assert.equal(pinned.status, 0, pinned.stderr);
    assert.equal(pinned.stdout, 'long\n', 'an explicit pin keeps its selected worker');
  });
}
