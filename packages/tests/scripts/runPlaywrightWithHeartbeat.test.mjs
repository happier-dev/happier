// @happier-test-preparation source
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const wrapper = 'packages/tests/scripts/run-playwright-with-heartbeat.mjs';
const launcher = 'apps/stack/bin/hstack-exec';

test('direct Playwright entry takes validation admission before launching the browser runner', {
  skip: process.platform !== 'linux',
}, async t => {
  const fixture = await mkdtemp(join(tmpdir(), 'playwright-placed-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const sources = [wrapper, 'packages/tests/scripts/runPlaywrightWithHeartbeat.shared.mjs',
    'packages/tests/scripts/playwrightWrapperTimeout.mjs', 'scripts/workspaces/execPnpmCommand.mjs',
    'apps/stack/scripts/utils/proc/proc.mjs'];
  for (const source of sources) {
    const destination = join(fixture, source);
    await mkdir(dirname(destination), { recursive: true });
    await symlink(join(repoRoot, source), destination);
  }
  const mark = join(fixture, 'dispatch-args');
  const scratch = join(fixture, 'run-scratch');
  await mkdir(scratch);
  await mkdir(dirname(join(fixture, launcher)), { recursive: true });
  await writeFile(join(fixture, launcher), [
    '#!/bin/sh',
    'printf "%s\\n" "$@" > "../../dispatch-args"',
    'printf "%s" "${FIXTURE_CALLER_ONLY-}" > "../../caller-only-env"',
    'exit 27',
    '',
  ].join('\n'), { mode: 0o700 });
  await writeFile(join(fixture, 'pnpm'), [
    '#!/bin/sh',
    'mktemp -d "$TMPDIR/playwright-artifacts-XXXXXX" > "$PLAYWRIGHT_FIXTURE_RESULT"',
    'exit 19',
    '',
  ].join('\n'), { mode: 0o700 });

  const args = ['--config', 'playwright.ui.config.mjs', 'suites/ui-e2e/example.spec.ts', '--grep', 'keeps argv intact'];
  const invoke = async (env = {}) => execFileAsync(process.execPath, [
    '--preserve-symlinks-main', 'scripts/run-playwright-with-heartbeat.mjs', ...args,
  ], { cwd: join(fixture, 'packages/tests'), env: { PATH: fixture + ':/usr/bin:/bin', FIXTURE_CALLER_ONLY: 'fixture-local-value', ...env } });

  await assert.rejects(invoke(), { code: 27 });
  assert.deepEqual((await readFile(mark, 'utf8')).trimEnd().split('\n'),
    ['--', 'node', 'scripts/run-playwright-with-heartbeat.mjs', ...args]);

  assert.equal(await readFile(join(fixture, 'caller-only-env'), 'utf8'), '');

  for (const env of [{ HAPPIER_E2E_PLUGIN_UI_CURRENT_STACK: '1' }, { HAPPIER_DEV_TARGET_EXECUTION: '1' }]) {
    await assert.rejects(invoke(env), { code: 27 });
    assert.deepEqual((await readFile(mark, 'utf8')).trimEnd().split('\n'),
      ['--heavyweight-admission', '--class=validation', '--', process.execPath,
        'scripts/run-playwright-with-heartbeat.mjs', ...args]);
    assert.equal(await readFile(join(fixture, 'caller-only-env'), 'utf8'), 'fixture-local-value');
  }

  const runEnv = {
    TMPDIR: scratch,
    HAPPIER_CI_DIAGNOSTIC_PATH: join(fixture, 'diagnostic.ndjson'),
    PLAYWRIGHT_FIXTURE_RESULT: join(fixture, 'result'),
  };
  await assert.rejects(invoke({ ...runEnv, HAPPIER_HEAVYWEIGHT_ADMISSION_SLOT: 'fixture-owned-slot' }), { code: 19 });
  await assert.rejects(invoke({ ...runEnv, CI: 'true' }), { code: 19 });
  assert.match(await readFile(join(fixture, 'result'), 'utf8'), /playwright-artifacts-/);
  assert.deepEqual(await readdir(scratch), []);
});
