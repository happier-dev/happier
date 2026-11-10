import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { runNodeCapture } from './testkit/core/run_node_capture.mjs';
import { sanitizeStackTestRunnerEnv } from './utils/test/test_env.mjs';

const repoDir = fileURLToPath(new URL('../../../', import.meta.url));

test('controlled source start reaches local daemon selection with a remote server and source boundary', {
  skip: process.platform === 'win32',
}, async t => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-controlled-source-' });
  const bin = fixture.path('bin');
  const storage = fixture.path('stacks');
  await mkdir(bin, { recursive: true });
  // SSH is the substituted OS transport boundary. Run its generated read-only
  // host probe locally; configuration, placement and source selection stay real.
  await writeFile(join(bin, 'ssh'), '#!/bin/bash\nexec bash -c "${@: -1}"\n', { mode: 0o755 });
  const target = { name: 'worker', platform: 'posix', ssh: 'fixture-ssh', repoDir,
    cliHomeDir: fixture.path('worker-home') };
  const config = { version: 3, targets: [target], runtimePlacement: {
    server: { mode: 'prefer-target', target: 'worker', fallback: 'error' },
    daemon: { mode: 'local' }, qa: { mode: 'local' },
  } };
  for (const name of ['consumer', 'producer']) {
    const base = join(storage, name);
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'dev-targets.json'), JSON.stringify(config));
  }
  const result = await runNodeCapture([join(repoDir, 'apps/stack/scripts/run.mjs'), '--runtime=source', '--no-ui',
    '--no-browser', '--source-after=2026-11-10T12:00:00.000Z'], {
    cwd: repoDir,
    env: { ...sanitizeStackTestRunnerEnv(process.env, { isolatedStackRoot: fixture.root, repoDir }),
      PATH: `${bin}:${process.env.PATH}`, HAPPIER_STACK_STORAGE_DIR: storage,
      HAPPIER_STACK_STACK: 'consumer', HAPPIER_STACK_RUNTIME_MODE: 'source-snapshot',
      HAPPIER_STACK_RUNTIME_BUILD_AUTHORITY_STACK: 'producer',
      HAPPIER_STACK_PREPARED_SOURCE_RELOAD: '1',
      HAPPIER_STACK_CLI_HOME_DIR: fixture.path('consumer-cli'),
      HAPPIER_STACK_QA_DAEMON_TARGETS: '', HAPPIER_STACK_EXPO_SOURCE_STACK: '',
    },
  });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  // An absent prepared daemon must reach the source owner and its recoverable
  // unavailable result, rather than crashing in the caller's option handoff.
  assert.match(result.stderr, /selected source daemon bundle is unavailable/, result.stdout + result.stderr);
});
