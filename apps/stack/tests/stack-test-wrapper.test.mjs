import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('close', (code, signal) => resolve({ code: code ?? (signal ? 128 : 0), signal, stdout, stderr }));
  });
}

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

async function ensureMinimalHappierMonorepo({ monoRoot }) {
  await mkdir(join(monoRoot, 'apps', 'ui'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'cli'), { recursive: true });
  await mkdir(join(monoRoot, 'apps', 'server'), { recursive: true });
  await writeYarnOkPackage({ dir: monoRoot, name: 'monorepo', scriptOutput: 'ROOT_TEST_RUN' });
  await writeYarnOkPackage({ dir: join(monoRoot, 'apps', 'ui'), name: 'happier-ui', scriptOutput: 'UI_TEST_RUN' });
  await writeYarnOkPackage({ dir: join(monoRoot, 'apps', 'cli'), name: 'happier-cli', scriptOutput: 'CLI_TEST_RUN' });
  await writeYarnOkPackage({ dir: join(monoRoot, 'apps', 'server'), name: 'happier-server', scriptOutput: 'SERVER_TEST_RUN' });
}

async function makeFakeYarn({ sandboxDir }) {
  const binDir = join(sandboxDir, 'bin');
  const logPath = join(sandboxDir, 'fake-yarn.log');
  const yarnPath = join(binDir, 'yarn');
  await mkdir(binDir, { recursive: true });
  await writeFile(
    yarnPath,
    [
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
    'utf-8'
  );
  await chmod(yarnPath, 0o755);
  return { binDir, logPath };
}

async function runStackTestWrapperScenario({ expectedTarget, expectedTestOutput, repoRoot, sandbox, targetArg }) {
  const monoRoot = join(sandbox, 'mono');
  await ensureMinimalHappierMonorepo({ monoRoot });
  const fakeYarn = await makeFakeYarn({ sandboxDir: sandbox });

  const stackEnvPath = join(sandbox, 'storage', 'main', 'env');
  await mkdir(dirname(stackEnvPath), { recursive: true });
  await writeFile(stackEnvPath, `HAPPIER_STACK_REPO_DIR=${monoRoot}\n`, 'utf-8');

  const env = {
    ...process.env,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_UPDATE_CHECK: '0',
    PATH: `${fakeYarn.binDir}${delimiter}${process.env.PATH ?? ''}`,
    HSTACK_FAKE_YARN_LOG: fakeYarn.logPath,
  };
  const args = [targetArg].filter(Boolean);
  const res = await runNode([hstackBinPath(repoRoot), '--sandbox-dir', sandbox, 'stack', 'test', 'main', ...args, '--json'], {
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

test('hstack stack test <name> runs test_cmd under stack env and keeps stdout JSON-only', async () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const sandbox = await mkdtemp(join(tmpdir(), 'hstack-sandbox-'));
  try {
    await runStackTestWrapperScenario({
      expectedTarget: 'cli',
      expectedTestOutput: 'CLI_TEST_RUN',
      repoRoot,
      sandbox,
      targetArg: 'cli',
    });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test('hstack stack test <name> forwards alternate target to test_cmd wrapper', async () => {
  const testDir = dirname(fileURLToPath(import.meta.url));
  const repoRoot = join(testDir, '..', '..', '..');
  const sandbox = await mkdtemp(join(tmpdir(), 'hstack-sandbox-'));
  try {
    await runStackTestWrapperScenario({
      expectedTarget: 'ui',
      expectedTestOutput: 'ROOT_TEST_RUN',
      repoRoot,
      sandbox,
      targetArg: 'ui',
    });
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});
