import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildStackHarnessEnv, writeFakeBin } from '../scripts/testkit/core/fake_bin_harness.mjs';
import { ensureMinimalMonorepoLayout } from '../scripts/testkit/core/minimal_monorepo_layout.mjs';
import { runNodeCapture } from '../scripts/testkit/core/run_node_capture.mjs';
import { createTempFixture } from '../scripts/testkit/core/temp_fixture.mjs';

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
  await writeFile(join(dir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
}

async function makeFakeYarn({ sandboxDir }) {
  const logPath = join(sandboxDir, 'fake-yarn.log');
  const { binDir } = writeFakeBin({
    root: sandboxDir,
    name: 'yarn',
    content: [
      '#!/bin/sh',
      'set -eu',
      'if [ -n "${HSTACK_FAKE_YARN_LOG:-}" ]; then',
      '  printf "%s\\n" "$*" >> "${HSTACK_FAKE_YARN_LOG}"',
      'fi',
      'if [ -f "./test-script.mjs" ]; then',
      '  node ./test-script.mjs',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
  });
  return { binDir, logPath };
}

async function runStackTestWrapperScenario({ expectedTarget, expectedTestOutput, repoRoot, sandbox, targetArg }) {
  const monoRoot = join(sandbox, 'mono');
  const { uiDir, cliDir, serverDir } = await ensureMinimalMonorepoLayout(monoRoot);
  await writeYarnOkPackage({ dir: monoRoot, name: 'monorepo', scriptOutput: 'ROOT_TEST_RUN' });
  await writeYarnOkPackage({ dir: uiDir, name: 'happier-ui', scriptOutput: 'UI_TEST_RUN' });
  await writeYarnOkPackage({ dir: cliDir, name: 'happier-cli', scriptOutput: 'CLI_TEST_RUN' });
  await writeYarnOkPackage({ dir: serverDir, name: 'happier-server', scriptOutput: 'SERVER_TEST_RUN' });
  const fakeYarn = await makeFakeYarn({ sandboxDir: sandbox });

  const stackEnvPath = join(sandbox, 'storage', 'main', 'env');
  await mkdir(dirname(stackEnvPath), { recursive: true });
  await writeFile(stackEnvPath, `HAPPIER_STACK_REPO_DIR=${monoRoot}\n`, 'utf-8');

  const env = buildStackHarnessEnv({
    binDirs: [fakeYarn.binDir],
    extraEnv: {
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      HAPPIER_STACK_UPDATE_CHECK: '0',
      HSTACK_FAKE_YARN_LOG: fakeYarn.logPath,
    },
  });
  const args = [targetArg].filter(Boolean);
  const res = await runNodeCapture([hstackBinPath(repoRoot), '--sandbox-dir', sandbox, 'stack', 'test', 'main', ...args, '--json'], {
    cwd: repoRoot,
    env,
  });
  assert.ok(
    res.code === 0 && !res.signal,
    `expected exit 0\ncode: ${res.code}\nsignal: ${res.signal}\nstderr:\n${res.stderr}\nstdout:\n${res.stdout}`
  );
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed?.ok, true, `expected ok=true, got:\n${JSON.stringify(parsed, null, 2)}\n\nstderr:\n${res.stderr}`);
  assert.equal(parsed?.results?.[0]?.target, expectedTarget);
  assert.ok(res.stderr.includes(expectedTestOutput), `expected ${expectedTestOutput} on stderr, got:\n${res.stderr}`);
  const fakeYarnLog = await readFile(fakeYarn.logPath, 'utf-8');
  assert.match(fakeYarnLog, /\btest\b/, `expected fake yarn invocation log, got:\n${fakeYarnLog}`);
}

function hstackBinPath(repoRoot) {
  return join(repoRoot, 'apps', 'stack', 'bin', 'hstack.mjs');
}

test('hstack stack test <name> runs test_cmd under stack env and keeps stdout JSON-only', async (t) => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const fixture = await createTempFixture(t, { prefix: 'hstack-sandbox-' });
  await runStackTestWrapperScenario({
    expectedTarget: 'cli',
    expectedTestOutput: 'CLI_TEST_RUN',
    repoRoot,
    sandbox: fixture.root,
    targetArg: 'cli',
  });
});

test('hstack stack test <name> forwards alternate target to test_cmd wrapper', async (t) => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const fixture = await createTempFixture(t, { prefix: 'hstack-sandbox-' });
  await runStackTestWrapperScenario({
    expectedTarget: 'ui',
    expectedTestOutput: 'ROOT_TEST_RUN',
    repoRoot,
    sandbox: fixture.root,
    targetArg: 'ui',
  });
});
