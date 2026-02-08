import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal: signal ?? null, stdout, stderr }));
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
  // Ensure deps are considered "already installed" by hstack.
  await writeFile(join(dir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
}

async function setupTestCmdFixture({ importMetaUrl, t, tmpPrefix }) {
  const scriptsDir = dirname(fileURLToPath(importMetaUrl));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), tmpPrefix));
  t.after(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  });

  const monoRoot = join(tmp, 'mono');
  const appDir = join(monoRoot, 'apps', 'ui');

  await mkdir(appDir, { recursive: true });

  await writeYarnOkPackage({ dir: monoRoot, name: 'monorepo', scriptOutput: 'ROOT_TEST_RUN' });
  await writeYarnOkPackage({ dir: appDir, name: 'happy-app', scriptOutput: 'APP_TEST_RUN' });

  const env = {
    ...process.env,
    HAPPIER_STACK_REPO_DIR: monoRoot,
    // Prevent env.mjs from auto-discovering and loading a real machine stack env file,
    // which would overwrite our component dir override.
    HAPPIER_STACK_STACK: 'test-stack',
    HAPPIER_STACK_ENV_FILE: join(tmp, 'nonexistent-env'),
  };

  return { rootDir, monoRoot, appDir, env };
}

test('hstack test --json keeps stdout JSON-only and runs monorepo root when happy points at apps/ui', async (t) => {
  const fixture = await setupTestCmdFixture({
    importMetaUrl: import.meta.url,
    t,
    tmpPrefix: 'happy-stacks-test-cmd-json-',
  });

  const res = await runNode([join(fixture.rootDir, 'scripts', 'test_cmd.mjs'), 'ui', '--json'], {
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

  const res = await runNode([join(fixture.rootDir, 'scripts', 'test_cmd.mjs'), 'ui'], {
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
