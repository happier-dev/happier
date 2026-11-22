import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

test('Playwright scratch is removed after exit and the durable result is kept', async t => {
  const root = await mkdtemp(join(tmpdir(), 'happier-playwright-wrapper-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const result = join(root, 'result');
  const runner = join(root, 'runner.cjs');
  await writeFile(runner, [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const scratch = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'playwright-artifacts-'));",
    "fs.writeFileSync(process.env.PLAYWRIGHT_FIXTURE_RESULT, scratch);",
    'process.exit(19);',
  ].join('\n'));

  await assert.rejects(promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('./run-playwright-with-heartbeat.mjs', import.meta.url)), '--config', 'fake.config.mjs',
  ], {
    env: {
      ...process.env,
      npm_execpath: runner,
      TMPDIR: root, TMP: root, TEMP: root,
      HAPPIER_CI_DIAGNOSTIC_PATH: join(root, 'diagnostic.ndjson'),
      PLAYWRIGHT_FIXTURE_RESULT: result,
    },
  }), { code: 19 });
  assert.match(await readFile(result, 'utf8'), /playwright-artifacts-/);
  assert.deepEqual((await readdir(root)).sort(), ['diagnostic.ndjson', 'result', 'runner.cjs']);
});
