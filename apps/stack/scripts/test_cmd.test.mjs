import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildStackHarnessEnv, writeFakeBin } from './testkit/core/fake_bin_harness.mjs';
import { runNodeCapture } from './testkit/core/run_node_capture.mjs';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';

async function writeYarnOkPackage({ dir, name, scriptOutput }) {
  await mkdir(join(dir, 'node_modules'), { recursive: true });
  await writeFile(join(dir, 'yarn.lock'), '# stub lock\n', 'utf-8');
  await writeFile(join(dir, 'test-script.mjs'), `process.stdout.write(${JSON.stringify(scriptOutput)});\n`, 'utf-8');
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name,
        private: true,
        packageManager: 'yarn@1.22.22',
        scripts: {
          test: 'node ./test-script.mjs',
        },
      },
      null,
      2
    ),
    'utf-8'
  );
  // Ensure deps are considered "already installed" by hstack.
  await writeFile(join(dir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
}

async function writeFakeYarn({ dir }) {
  return writeFakeBin({
    root: dir,
    name: 'yarn',
    content: [
      '#!/usr/bin/env node',
      "const args = process.argv.slice(2);",
      "if (args[0] === '-s') args.shift();",
      "if (args[0] !== 'test') process.exit(0);",
      "const { spawnSync } = require('node:child_process');",
      "const { readFileSync } = require('node:fs');",
      "const pkg = JSON.parse(readFileSync('package.json', 'utf8'));",
      "const command = String(pkg.scripts.test || '');",
      "const parts = command.split(/\\s+/).filter(Boolean);",
      "const res = spawnSync(parts[0], parts.slice(1), { stdio: 'inherit' });",
      "process.exit(res.status == null ? 1 : res.status);",
    ].join('\n'),
  });
}

async function setupTestCmdFixture({ importMetaUrl, t, tmpPrefix }) {
  const scriptsDir = dirname(fileURLToPath(importMetaUrl));
  const rootDir = dirname(scriptsDir);

  const fixture = await createTempFixture(t, { prefix: tmpPrefix });
  const tmp = fixture.root;

  const monoRoot = join(tmp, 'mono');
  const appDir = join(monoRoot, 'apps', 'ui');
  const { binDir } = await writeFakeYarn({ dir: tmp });

  await mkdir(appDir, { recursive: true });

  await writeYarnOkPackage({ dir: monoRoot, name: 'monorepo', scriptOutput: 'ROOT_TEST_RUN' });
  await writeYarnOkPackage({ dir: appDir, name: 'happy-app', scriptOutput: 'APP_TEST_RUN' });

  const env = buildStackHarnessEnv({
    binDirs: [binDir],
    extraEnv: {
      HAPPIER_STACK_REPO_DIR: monoRoot,
      // Prevent env.mjs from auto-discovering and loading a real machine stack env file,
      // which would overwrite our component dir override.
      HAPPIER_STACK_STACK: 'test-stack',
      HAPPIER_STACK_ENV_FILE: join(tmp, 'nonexistent-env'),
    },
  });

  return { rootDir, monoRoot, appDir, env };
}

test('hstack test --json keeps stdout JSON-only and runs monorepo root when happy points at apps/ui', async (t) => {
  const fixture = await setupTestCmdFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'happy-stacks-test-cmd-json-',
  });

  const res = await runNodeCapture([join(fixture.rootDir, 'scripts', 'test_cmd.mjs'), 'ui', '--json'], {
    cwd: fixture.rootDir,
    env: fixture.env,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

  // Stdout must be JSON only.
  let parsed;
  try {
    parsed = JSON.parse(res.stdout);
  } catch (e) {
    throw new Error(
      `stdout was not valid JSON.\n` +
        `error: ${String(e?.message ?? e)}\n` +
        `stdout:\n${res.stdout}\n` +
        `stderr:\n${res.stderr}\n`
    );
  }
  assert.equal(
    parsed?.ok,
    true,
    `expected ok=true, got:\n${JSON.stringify(parsed, null, 2)}\n\nstderr:\n${res.stderr}\n\nstdout:\n${res.stdout}`
  );
  assert.equal(parsed?.results?.length, 1);
  assert.equal(parsed.results[0].target, 'ui');

  // Monorepo detection: when happy points at apps/ui, tests should run from the monorepo root.
  assert.equal(parsed.results[0].dir, fixture.monoRoot);

  // Any command output should be written to stderr (to keep stdout JSON-only).
  assert.ok(res.stderr.includes('ROOT_TEST_RUN'));
  assert.ok(!res.stderr.includes('APP_TEST_RUN'));
});

test('hstack test (non-json) keeps monorepo-root routing and reports human-readable summary', async (t) => {
  const fixture = await setupTestCmdFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'happy-stacks-test-cmd-text-',
  });

  const res = await runNodeCapture([join(fixture.rootDir, 'scripts', 'test_cmd.mjs'), 'ui'], {
    cwd: fixture.rootDir,
    env: fixture.env,
  });
  assert.equal(res.code, 0, `expected exit 0, got ${res.code}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`);

  assert.ok(res.stdout.includes('[test] ui: running yarn test'), res.stdout);
  assert.ok(res.stdout.includes('ROOT_TEST_RUN'), res.stdout);
  assert.ok(!res.stdout.includes('APP_TEST_RUN'), res.stdout);
  assert.ok(res.stdout.includes('[test] results:'), res.stdout);
  assert.ok(res.stdout.includes('- ✅ ui: ok (yarn test)'), res.stdout);
});
