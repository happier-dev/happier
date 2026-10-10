import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createMinimalMonorepoFixture } from './testkit/core/minimal_monorepo_layout.mjs';
import {
  buildStackHarnessEnv,
  writeLoggedJsonBin,
} from './testkit/core/fake_bin_harness.mjs';
import { runNodeCapture } from './testkit/core/run_node_capture.mjs';
import {
  resolveStackScriptPath,
  resolveStackRootFromMeta,
} from './testkit/core/stack_root.mjs';

// Yarn is the OS/process boundary; target selection and command orchestration stay real.
test('hstack lint uses the root lint owner for all sources and propagates failure in JSON mode', async (t) => {
  const fixture = await createMinimalMonorepoFixture(t, {
    prefix: 'hstack-lint-',
  });
  await writeFile(
    join(fixture.root, 'package.json'),
    JSON.stringify({ scripts: { lint: 'oxlint' } }),
  );
  await writeFile(join(fixture.root, 'yarn.lock'), '');
  await mkdir(join(fixture.root, 'node_modules'));
  const log = join(fixture.root, 'calls.jsonl');
  const fake = writeLoggedJsonBin({
    root: fixture.root,
    name: 'yarn',
    logEnvVar: 'LINT_TEST_LOG',
    body: 'process.exit(process.argv.includes("lint") ? 1 : 0);',
  });
  const env = buildStackHarnessEnv({
    binDirs: [fake.binDir],
    extraEnv: {
      HAPPIER_STACK_REPO_DIR: fixture.root,
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
      HAPPIER_STACK_ENV_FILE: '',
      LINT_TEST_LOG: log,
    },
  });
  const script = resolveStackScriptPath(
    resolveStackRootFromMeta(import.meta.url),
    'lint.mjs',
  );
  const result = await runNodeCapture([script, '--json'], {
    cwd: fixture.root,
    env,
  });
  assert.equal(result.code, 1, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, false);
  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0].target, 'all');
  assert.equal(payload.results[0].skipped, false);
  const calls = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.filter((call) => call.argv.includes('lint')).map((call) => call.argv),
    [['-s', 'lint']],
  );
});

test('hstack lint inferred UI scope runs root policy against that app and plugin UI', async (t) => {
  const fixture = await createMinimalMonorepoFixture(t, {
    prefix: 'hstack-lint-ui-',
    writeGitDirMarker: true,
  });
  await writeFile(
    join(fixture.root, 'package.json'),
    JSON.stringify({ scripts: { lint: 'oxlint' } }),
  );
  await writeFile(join(fixture.root, 'yarn.lock'), '');
  await mkdir(join(fixture.root, 'node_modules'));
  await mkdir(
    join(fixture.root, 'packages', 'plugins', 'example', 'src', 'ui'),
    { recursive: true },
  );
  const log = join(fixture.root, 'calls.jsonl');
  const fake = writeLoggedJsonBin({
    root: fixture.root,
    name: 'yarn',
    logEnvVar: 'LINT_TEST_LOG',
  });
  const env = buildStackHarnessEnv({
    binDirs: [fake.binDir],
    extraEnv: {
      HAPPIER_STACK_REPO_DIR: fixture.root,
      HAPPIER_STACK_INVOKED_CWD: fixture.uiDir,
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
      HAPPIER_STACK_ENV_FILE: '',
      LINT_TEST_LOG: log,
    },
  });
  const script = resolveStackScriptPath(
    resolveStackRootFromMeta(import.meta.url),
    'lint.mjs',
  );
  const result = await runNodeCapture([script, '--json'], {
    cwd: fixture.uiDir,
    env,
  });
  assert.equal(result.code, 0, result.stdout + result.stderr);
  const payload = JSON.parse(result.stdout.trim());
  assert.equal(payload.ok, true);
  assert.equal(payload.results[0].skipped, false);
  const calls = (await readFile(log, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    calls.filter((call) => call.argv.includes('lint')).map((call) => call.argv),
    [['-s', 'lint', 'apps/ui', 'packages/plugins/example/src/ui']],
  );
});
