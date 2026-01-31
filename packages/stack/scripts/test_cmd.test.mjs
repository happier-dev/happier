import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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
    proc.on('exit', (code) => resolve({ code: code ?? 0, stdout, stderr }));
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
  // Ensure deps are considered "already installed" by happy-stacks.
  await writeFile(join(dir, 'node_modules', '.yarn-integrity'), 'ok\n', 'utf-8');
}

test('happys test --json keeps stdout JSON-only and runs monorepo root when happy points at packages/happy-app', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-test-cmd-'));
  const monoRoot = join(tmp, 'mono');
  const appDir = join(monoRoot, 'packages', 'happy-app');

  await mkdir(appDir, { recursive: true });

  await writeYarnOkPackage({ dir: monoRoot, name: 'monorepo', scriptOutput: 'ROOT_TEST_RUN' });
  await writeYarnOkPackage({ dir: appDir, name: 'happy-app', scriptOutput: 'APP_TEST_RUN' });

  const env = {
    ...process.env,
    HAPPY_STACKS_COMPONENT_DIR_HAPPY: appDir,
    // Prevent env.mjs from auto-discovering and loading a real machine stack env file,
    // which would overwrite our component dir override.
    HAPPY_STACKS_STACK: 'test-stack',
    HAPPY_STACKS_ENV_FILE: join(tmp, 'nonexistent-env'),
    HAPPY_LOCAL_ENV_FILE: join(tmp, 'nonexistent-env'),
  };

  const res = await runNode([join(rootDir, 'scripts', 'test.mjs'), 'happy', '--json'], { cwd: rootDir, env });
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
  assert.equal(parsed.results[0].component, 'happy');

  // Monorepo detection: when happy points at expo-app, tests should run from the monorepo root.
  assert.equal(parsed.results[0].dir, monoRoot);

  // Any command output should be written to stderr (to keep stdout JSON-only).
  assert.ok(res.stderr.includes('ROOT_TEST_RUN'));
  assert.ok(!res.stderr.includes('APP_TEST_RUN'));
});
